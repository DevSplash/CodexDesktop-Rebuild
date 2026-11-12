#!/usr/bin/env node
/**
 * preflight-patch.js — Lightweight upstream ASAR patch preflight verifier
 *
 * Uses HTTP Range requests against the upstream macOS arm64 ZIP to download
 * ONLY `Contents/Resources/app.asar`, streams raw-deflate decompression to disk
 * with minimal memory (~30 MB peak RAM), extracts only `package.json` and `.js`
 * bundles (skipping `node_modules`, source maps, and static media) into an
 * isolated temporary directory, runs `patch-all.js mac-arm64 --check`, and
 * guarantees complete cleanup of temporary files on exit.
 *
 * Usage:
 *   node scripts/preflight-patch.js
 *   node scripts/preflight-patch.js --strict
 *   node scripts/preflight-patch.js --report patch-report.json --summary
 *   node scripts/preflight-patch.js --url https://.../ChatGPT-darwin-arm64-....zip
 *   node scripts/preflight-patch.js --zip /path/to/local.zip
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { execFileSync, spawnSync } = require("child_process");
const { XMLParser } = require("fast-xml-parser");

const { checkMacArm64Version } = require("./check-update");
const { formatMarkdownSummary } = require("./patch-all");

const APPCAST_ARM64 = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";
const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function parseArgs(argv) {
  let url = null;
  let zipPath = null;
  let isStrict = false;
  let reportPath = null;
  let writeStepSummary = false;
  let summaryFile = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") url = argv[++i] || null;
    else if (arg.startsWith("--url=")) url = arg.slice("--url=".length) || null;
    else if (arg === "--zip") zipPath = argv[++i] || null;
    else if (arg.startsWith("--zip=")) zipPath = arg.slice("--zip=".length) || null;
    else if (arg === "--strict") isStrict = true;
    else if (arg === "--report") reportPath = argv[++i] || null;
    else if (arg.startsWith("--report=")) reportPath = arg.slice("--report=".length) || null;
    else if (arg === "--summary") writeStepSummary = true;
    else if (arg === "--summary-file") summaryFile = argv[++i] || null;
  }

  return { url, zipPath, isStrict, reportPath, writeStepSummary, summaryFile };
}

function validateRemoteUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid upstream ZIP URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

async function resolveLatestMacArm64(tmpDir) {
  try {
    const xmlPath = path.join(tmpDir, "appcast.xml");
    execFileSync(
      "curl",
      ["-sS", "-L", "--fail", "--retry", "3", "--max-time", "20", "-o", xmlPath, APPCAST_ARM64],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const xml = fs.readFileSync(xmlPath, "utf8");
    const parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
    }).parse(xml);
    const items = parsed.rss?.channel?.item;
    const latest = Array.isArray(items) ? items[0] : items;
    let enc = latest?.enclosure;
    if (Array.isArray(enc)) enc = enc[0];
    if (latest && enc?.["@_url"]) {
      return {
        platform: "macOS-arm64",
        version: latest.shortVersionString || latest.title || "",
        build: String(latest.version || ""),
        downloadUrl: enc["@_url"],
        size: Number(enc["@_length"] || 0),
      };
    }
  } catch {}
  return checkMacArm64Version();
}

function curlRangeToFile(url, start, end, outFile, headerFile = null) {
  const args = [
    "-sS",
    "-L",
    "--fail",
    "--retry",
    "3",
    "--retry-delay",
    "2",
    "-r",
    `${start}-${end}`,
    "-o",
    outFile,
  ];
  if (headerFile) args.push("-D", headerFile);
  args.push(url);
  execFileSync("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
}

function probeRemoteSize(url, tmpDir, fallbackSize = 0) {
  const probeBody = path.join(tmpDir, "probe.bin");
  const probeHdr = path.join(tmpDir, "probe.hdr");
  curlRangeToFile(url, 0, 0, probeBody, probeHdr);
  const headers = fs.readFileSync(probeHdr, "utf8");
  const matches = [...headers.matchAll(/^content-range:\s*bytes\s+0-0\/(\d+)/gim)];
  if (matches.length > 0) {
    return Number(matches[matches.length - 1][1]);
  }
  if (fallbackSize > 0) return fallbackSize;
  throw new Error("Server did not return Content-Range for HTTP Range probe");
}

function findEocdOffset(buf) {
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen <= buf.length) return i;
  }
  return -1;
}

function parseCentralDirectoryForAsar(cdBuf) {
  let pos = 0;
  while (pos + 46 <= cdBuf.length) {
    if (cdBuf.readUInt32LE(pos) !== CD_SIG) {
      throw new Error(`Invalid Central Directory signature at offset ${pos}`);
    }
    const compressionMethod = cdBuf.readUInt16LE(pos + 10);
    let compressedSize = cdBuf.readUInt32LE(pos + 20);
    let uncompressedSize = cdBuf.readUInt32LE(pos + 24);
    const nameLen = cdBuf.readUInt16LE(pos + 28);
    const extraLen = cdBuf.readUInt16LE(pos + 30);
    const commentLen = cdBuf.readUInt16LE(pos + 32);
    let localHeaderOffset = cdBuf.readUInt32LE(pos + 42);

    const nameStart = pos + 46;
    const extraStart = nameStart + nameLen;
    const nextPos = extraStart + extraLen + commentLen;
    if (nextPos > cdBuf.length) break;

    const entryName = cdBuf.toString("utf8", nameStart, extraStart).replace(/\\/g, "/");

    if (
      uncompressedSize === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      let ep = extraStart;
      const extraEnd = extraStart + extraLen;
      while (ep + 4 <= extraEnd) {
        const tag = cdBuf.readUInt16LE(ep);
        const sz = cdBuf.readUInt16LE(ep + 2);
        const dataEnd = ep + 4 + sz;
        if (dataEnd > extraEnd) break;
        if (tag === 0x0001) {
          let zp = ep + 4;
          if (uncompressedSize === 0xffffffff && zp + 8 <= dataEnd) {
            uncompressedSize = Number(cdBuf.readBigUInt64LE(zp));
            zp += 8;
          }
          if (compressedSize === 0xffffffff && zp + 8 <= dataEnd) {
            compressedSize = Number(cdBuf.readBigUInt64LE(zp));
            zp += 8;
          }
          if (localHeaderOffset === 0xffffffff && zp + 8 <= dataEnd) {
            localHeaderOffset = Number(cdBuf.readBigUInt64LE(zp));
          }
          break;
        }
        ep = dataEnd;
      }
    }

    if (
      entryName === "Contents/Resources/app.asar" ||
      entryName.endsWith("/Contents/Resources/app.asar")
    ) {
      return {
        entryName,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        nameLen,
        extraLen,
      };
    }

    pos = nextPos;
  }

  throw new Error("Contents/Resources/app.asar not found in ZIP Central Directory");
}

async function streamInflateZipEntryToAsarFile(sourceFile, lfhOffset, entryMeta, destAsarFile) {
  const fd = fs.openSync(sourceFile, "r");
  let lfhBuf;
  try {
    lfhBuf = Buffer.allocUnsafe(30);
    const bytesRead = fs.readSync(fd, lfhBuf, 0, 30, lfhOffset);
    if (bytesRead < 30 || lfhBuf.readUInt32LE(0) !== LFH_SIG) {
      throw new Error("Invalid ZIP Local File Header signature for app.asar");
    }
  } finally {
    fs.closeSync(fd);
  }

  const localNameLen = lfhBuf.readUInt16LE(26);
  const localExtraLen = lfhBuf.readUInt16LE(28);
  const dataStart = lfhOffset + 30 + localNameLen + localExtraLen;
  const dataEndInclusive = dataStart + entryMeta.compressedSize - 1;

  const readStream = fs.createReadStream(sourceFile, {
    start: dataStart,
    end: dataEndInclusive,
    highWaterMark: 1024 * 1024,
  });
  const writeStream = fs.createWriteStream(destAsarFile, { highWaterMark: 1024 * 1024 });

  if (entryMeta.compressionMethod === 0) {
    await pipeline(readStream, writeStream);
  } else if (entryMeta.compressionMethod === 8) {
    await pipeline(readStream, zlib.createInflateRaw({ chunkSize: 1024 * 1024 }), writeStream);
  } else {
    readStream.destroy();
    writeStream.destroy();
    throw new Error(`Unsupported ZIP compression method: ${entryMeta.compressionMethod}`);
  }

  const actualSize = fs.statSync(destAsarFile).size;
  if (entryMeta.uncompressedSize > 0 && actualSize !== entryMeta.uncompressedSize) {
    throw new Error(
      `Decompressed app.asar size mismatch: expected ${entryMeta.uncompressedSize}, got ${actualSize}`,
    );
  }
  return actualSize;
}

async function fetchAsarFileFromRemoteZip(url, tmpDir, destAsarFile, fallbackSize = 0) {
  const totalSize = probeRemoteSize(url, tmpDir, fallbackSize);
  const tailLen = Math.min(totalSize, 262144);
  const tailStart = totalSize - tailLen;
  const tailPath = path.join(tmpDir, "tail.bin");
  curlRangeToFile(url, tailStart, totalSize - 1, tailPath);
  const tailBuf = fs.readFileSync(tailPath);

  const eocdPos = findEocdOffset(tailBuf);
  if (eocdPos < 0) {
    throw new Error("ZIP End of Central Directory record not found in archive tail");
  }

  let cdSize = tailBuf.readUInt32LE(eocdPos + 12);
  let cdOffset = tailBuf.readUInt32LE(eocdPos + 16);

  if (
    (cdSize === 0xffffffff || cdOffset === 0xffffffff) &&
    eocdPos >= 20 &&
    tailBuf.readUInt32LE(eocdPos - 20) === ZIP64_LOCATOR_SIG
  ) {
    const z64Offset = Number(tailBuf.readBigUInt64LE(eocdPos - 12));
    let z64Buf;
    if (z64Offset >= tailStart) {
      z64Buf = tailBuf.subarray(z64Offset - tailStart);
    } else {
      const z64Path = path.join(tmpDir, "z64.bin");
      curlRangeToFile(url, z64Offset, Math.min(totalSize - 1, z64Offset + 128), z64Path);
      z64Buf = fs.readFileSync(z64Path);
    }
    if (z64Buf.readUInt32LE(0) !== ZIP64_EOCD_SIG) {
      throw new Error("Invalid ZIP64 EOCD signature");
    }
    cdSize = Number(z64Buf.readBigUInt64LE(40));
    cdOffset = Number(z64Buf.readBigUInt64LE(48));
  }

  let cdBuf;
  if (cdOffset >= tailStart && cdOffset + cdSize <= totalSize) {
    cdBuf = tailBuf.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize);
  } else {
    const cdPath = path.join(tmpDir, "cd.bin");
    curlRangeToFile(url, cdOffset, cdOffset + cdSize - 1, cdPath);
    cdBuf = fs.readFileSync(cdPath);
  }

  const entryMeta = parseCentralDirectoryForAsar(cdBuf);
  const rangeStart = entryMeta.localHeaderOffset;
  const rangeEnd = Math.min(
    totalSize - 1,
    rangeStart + 30 + entryMeta.nameLen + entryMeta.extraLen + entryMeta.compressedSize + 4096,
  );

  console.log(
    `  [range] Fetching ${entryMeta.entryName} (${(entryMeta.compressedSize / 1048576).toFixed(1)} MB compressed / ${(totalSize / 1048576).toFixed(1)} MB archive)`,
  );
  const entryPath = path.join(tmpDir, "asar-entry.bin");
  curlRangeToFile(url, rangeStart, rangeEnd, entryPath);

  const asarSize = await streamInflateZipEntryToAsarFile(entryPath, 0, entryMeta, destAsarFile);
  fs.rmSync(entryPath, { force: true });
  return asarSize;
}

async function extractAsarFileFromLocalZip(zipFile, destAsarFile) {
  const fd = fs.openSync(zipFile, "r");
  let entryMeta;
  try {
    const totalSize = fs.fstatSync(fd).size;
    const tailLen = Math.min(totalSize, 262144);
    const tailStart = totalSize - tailLen;
    const tailBuf = Buffer.allocUnsafe(tailLen);
    fs.readSync(fd, tailBuf, 0, tailLen, tailStart);

    const eocdPos = findEocdOffset(tailBuf);
    if (eocdPos < 0) throw new Error("ZIP EOCD not found in local archive");

    let cdSize = tailBuf.readUInt32LE(eocdPos + 12);
    let cdOffset = tailBuf.readUInt32LE(eocdPos + 16);

    if (
      (cdSize === 0xffffffff || cdOffset === 0xffffffff) &&
      eocdPos >= 20 &&
      tailBuf.readUInt32LE(eocdPos - 20) === ZIP64_LOCATOR_SIG
    ) {
      const z64Offset = Number(tailBuf.readBigUInt64LE(eocdPos - 12));
      const z64Buf = Buffer.allocUnsafe(64);
      fs.readSync(fd, z64Buf, 0, 64, z64Offset);
      if (z64Buf.readUInt32LE(0) !== ZIP64_EOCD_SIG) {
        throw new Error("Invalid ZIP64 EOCD signature in local archive");
      }
      cdSize = Number(z64Buf.readBigUInt64LE(40));
      cdOffset = Number(z64Buf.readBigUInt64LE(48));
    }

    const cdBuf = Buffer.allocUnsafe(cdSize);
    fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);
    entryMeta = parseCentralDirectoryForAsar(cdBuf);
  } finally {
    fs.closeSync(fd);
  }

  return streamInflateZipEntryToAsarFile(
    zipFile,
    entryMeta.localHeaderOffset,
    entryMeta,
    destAsarFile,
  );
}

function shouldExtractForPatchCheck(relChild, depth) {
  if (depth === 0 && relChild === "package.json") return true;
  return relChild.endsWith(".js");
}

function extractPatchTargetsFromAsarFile(asarFile, outDir) {
  const fd = fs.openSync(asarFile, "r");
  try {
    const fileStat = fs.fstatSync(fd);
    if (fileStat.size < 16) throw new Error("Invalid ASAR file (too small)");

    const prefix = Buffer.allocUnsafe(16);
    fs.readSync(fd, prefix, 0, 16, 0);
    const headerPickleSize = prefix.readUInt32LE(4);
    const jsonLen = prefix.readUInt32LE(12);
    const baseOffset = 8 + headerPickleSize;
    if (16 + jsonLen > fileStat.size || baseOffset > fileStat.size) {
      throw new Error("Corrupted ASAR header bounds");
    }

    const headerBuf = Buffer.allocUnsafe(jsonLen);
    fs.readSync(fd, headerBuf, 0, jsonLen, 16);
    const header = JSON.parse(headerBuf.toString("utf8"));
    const resolvedRoot = path.resolve(outDir);
    let extractedCount = 0;

    function walkTree(node, relDir, depth) {
      if (!node || typeof node.files !== "object") return;
      for (const [name, meta] of Object.entries(node.files)) {
        if (depth === 0 && name === "node_modules") continue;
        if (!meta || typeof meta !== "object") continue;

        const relChild = relDir ? path.join(relDir, name) : name;
        const absTarget = path.resolve(resolvedRoot, relChild);
        if (absTarget !== resolvedRoot && !absTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
          throw new Error(`Refusing ASAR path traversal entry: ${relChild}`);
        }

        if (meta.files) {
          walkTree(meta, relChild, depth + 1);
        } else if (
          !meta.unpacked &&
          !meta.link &&
          meta.offset !== undefined &&
          meta.size !== undefined &&
          shouldExtractForPatchCheck(relChild, depth)
        ) {
          const start = baseOffset + Number(meta.offset);
          const size = Number(meta.size);
          if (start < baseOffset || start + size > fileStat.size) {
            throw new Error(`ASAR entry out of bounds: ${relChild}`);
          }
          const buf = Buffer.allocUnsafe(size);
          let readTotal = 0;
          while (readTotal < size) {
            const n = fs.readSync(fd, buf, readTotal, size - readTotal, start + readTotal);
            if (n <= 0) break;
            readTotal += n;
          }
          fs.mkdirSync(path.dirname(absTarget), { recursive: true });
          fs.writeFileSync(absTarget, buf);
          extractedCount++;
        }
      }
    }

    fs.mkdirSync(resolvedRoot, { recursive: true });
    walkTree(header, "", 0);
    return extractedCount;
  } finally {
    fs.closeSync(fd);
  }
}

function removeTempDirSafe(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-preflight-"));

  const onSignal = (sig) => {
    removeTempDirSafe(tmpDir);
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    let upstream = null;
    const asarFile = path.join(tmpDir, "app.asar");
    let asarSize = 0;

    if (opts.zipPath) {
      const absZip = path.resolve(opts.zipPath);
      console.log(`== Preflight source: local archive ${absZip} ==`);
      asarSize = await extractAsarFileFromLocalZip(absZip, asarFile);
      upstream = { platform: "macOS-arm64", version: "local", build: "", downloadUrl: absZip };
    } else {
      let targetUrl = opts.url;
      let expectedSize = 0;
      if (!targetUrl) {
        const info = await resolveLatestMacArm64(tmpDir);
        upstream = {
          platform: info.platform,
          version: info.version,
          build: info.build,
          downloadUrl: info.downloadUrl,
        };
        targetUrl = info.downloadUrl;
        expectedSize = info.size || 0;
        console.log(`== Preflight source: ${info.platform} ${info.version} (build ${info.build}) ==`);
      } else {
        upstream = {
          platform: "macOS-arm64",
          version: "custom-url",
          build: "",
          downloadUrl: targetUrl,
        };
        console.log(`== Preflight source: ${targetUrl} ==`);
      }

      targetUrl = validateRemoteUrl(targetUrl);
      asarSize = await fetchAsarFileFromRemoteZip(targetUrl, tmpDir, asarFile, expectedSize);
    }

    const virtualSrcDir = path.join(tmpDir, "src");
    const asarOutDir = path.join(virtualSrcDir, "mac-arm64", "_asar");
    const fileCount = extractPatchTargetsFromAsarFile(asarFile, asarOutDir);
    // Free disk space before spawning patch-all.js
    fs.rmSync(asarFile, { force: true });
    console.log(
      `  [asar] Extracted ${fileCount} JS/JSON patch target files from ${(asarSize / 1048576).toFixed(1)} MB app.asar`,
    );

    const pkgPath = path.join(asarOutDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (
          (!upstream.version || upstream.version === "local" || upstream.version === "custom-url") &&
          pkg.version
        ) {
          upstream.version = pkg.version;
        }
        if (!upstream.build && pkg.codexBuildNumber) {
          upstream.build = String(pkg.codexBuildNumber);
        }
      } catch {}
    }

    const tmpReportPath = path.join(tmpDir, "patch-report.json");
    const patchAllArgs = [
      path.join(__dirname, "patch-all.js"),
      "mac-arm64",
      "--check",
      "--report",
      tmpReportPath,
      ...(opts.isStrict ? ["--strict"] : []),
    ];

    const res = spawnSync(process.execPath, patchAllArgs, {
      stdio: "inherit",
      env: { ...process.env, CODEX_SRC_DIR: virtualSrcDir },
    });

    if (!fs.existsSync(tmpReportPath)) {
      throw new Error(`patch-all.js did not produce a report (exit ${res.status})`);
    }

    const report = JSON.parse(fs.readFileSync(tmpReportPath, "utf8"));
    report.upstream = upstream;

    if (opts.reportPath) {
      const absReport = path.resolve(opts.reportPath);
      fs.mkdirSync(path.dirname(absReport), { recursive: true });
      fs.writeFileSync(absReport, JSON.stringify(report, null, 2) + "\n", "utf8");
    }

    const md = formatMarkdownSummary(report);
    if (opts.summaryFile) {
      const absSummary = path.resolve(opts.summaryFile);
      fs.mkdirSync(path.dirname(absSummary), { recursive: true });
      fs.writeFileSync(absSummary, md, "utf8");
    }
    if (opts.writeStepSummary && process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`, "utf8");
    }

    if (res.status !== 0 || !report.ok) {
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    removeTempDirSafe(tmpDir);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[x] Preflight failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  extractAsarFileFromLocalZip,
  extractPatchTargetsFromAsarFile,
  fetchAsarFileFromRemoteZip,
  parseCentralDirectoryForAsar,
};
