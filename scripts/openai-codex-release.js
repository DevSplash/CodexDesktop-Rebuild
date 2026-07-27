/**
 * Install Linux Codex resources that exactly match a desktop-bundled Codex
 * binary. Windows and macOS must keep their official desktop resource sets.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const RELEASE_API = "https://api.github.com/repos/openai/codex/releases";
const CHECKSUM_ASSET = "codex-package_SHA256SUMS";
const VERSION_PATTERN =
  /(^|[^0-9A-Za-z])(\d+\.\d+\.\d+(?:-[A-Za-z][A-Za-z0-9-]*\.\d+(?:\.\d+)*)?)/g;
const VERSION_SCAN_CHUNK_SIZE = 4 * 1024 * 1024;
const VERSION_SCAN_OVERLAP = 256;
const RELEASES_PER_PAGE = 30;
const MAX_RELEASE_PAGES = 6;

const PLATFORM_CONFIG = {
  "linux-arm64": {
    target: "aarch64-unknown-linux-musl",
    executableSuffix: "",
  },
  "linux-x64": {
    target: "x86_64-unknown-linux-musl",
    executableSuffix: "",
  },
};

const releaseCache = new Map();
const packageCache = new Map();

function curlText(url) {
  return execFileSync("curl", [
    "-fsSL",
    "--retry", "3",
    "--retry-delay", "2",
    "-H", "Accept: application/vnd.github+json",
    "-H", "User-Agent: CodexDesktop-Rebuild",
    url,
  ], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function downloadFile(url, destination) {
  execFileSync("curl", [
    "-fL",
    "--retry", "3",
    "--retry-delay", "2",
    "--output", destination,
    url,
  ], { stdio: "inherit" });
}

function normalizeReleaseTag(tag) {
  if (!tag) return null;
  return tag.startsWith("rust-v") ? tag : `rust-v${tag.replace(/^v/, "")}`;
}

function detectBundledCodexVersions(binaryPath) {
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    throw new Error(`Bundled desktop Codex binary is missing: ${binaryPath}`);
  }

  const versions = new Set();
  const fd = fs.openSync(binaryPath, "r");
  let overlap = "";
  try {
    const buffer = Buffer.allocUnsafe(VERSION_SCAN_CHUNK_SIZE);
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;

      const text = overlap + buffer.subarray(0, bytesRead).toString("latin1");
      VERSION_PATTERN.lastIndex = 0;
      let match;
      while ((match = VERSION_PATTERN.exec(text)) !== null) {
        versions.add(match[2]);
      }
      overlap = text.slice(-VERSION_SCAN_OVERLAP);
    }
  } finally {
    fs.closeSync(fd);
  }

  return [...versions];
}

function fetchRelease(tag) {
  if (releaseCache.has(tag)) return releaseCache.get(tag);

  const release = JSON.parse(
    curlText(`${RELEASE_API}/tags/${encodeURIComponent(tag)}`),
  );
  return cacheRelease(release);
}

function cacheRelease(release) {
  if (!release.tag_name || !Array.isArray(release.assets)) {
    throw new Error("Invalid response from the openai/codex releases API");
  }
  if (release.draft) {
    throw new Error(`Refusing draft openai/codex release: ${release.tag_name}`);
  }

  const resolved = {
    ...release,
    version: release.tag_name.replace(/^rust-v/, ""),
  };
  releaseCache.set(release.tag_name, resolved);
  return resolved;
}

function hasPackageAsset(release, platform) {
  const platformConfig = PLATFORM_CONFIG[platform];
  if (!platformConfig) return false;
  const archiveName = `codex-package-${platformConfig.target}.tar.gz`;
  return release.assets.some((asset) => asset.name === archiveName)
    && release.assets.some((asset) => asset.name === CHECKSUM_ASSET);
}

function getRelease(bundledCodexPath, platform) {
  const detectedVersions = detectBundledCodexVersions(bundledCodexPath);
  if (detectedVersions.length === 0) {
    throw new Error(
      `Could not detect a Codex version in the desktop binary: ${bundledCodexPath}`,
    );
  }

  const requestedTag = normalizeReleaseTag(
    process.env.OPENAI_CODEX_RELEASE_TAG?.trim(),
  );
  if (requestedTag) {
    const requestedVersion = requestedTag.replace(/^rust-v/, "");
    if (!detectedVersions.includes(requestedVersion)) {
      throw new Error(
        `OPENAI_CODEX_RELEASE_TAG ${requestedTag} does not match the bundled `
        + `desktop Codex binary at ${bundledCodexPath}`,
      );
    }
    const release = fetchRelease(requestedTag);
    if (!hasPackageAsset(release, platform)) {
      throw new Error(
        `Release ${requestedTag} has no complete package for ${platform}`,
      );
    }
    return release;
  }

  const detectedSet = new Set(detectedVersions);
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const releases = JSON.parse(
      curlText(
        `${RELEASE_API}?per_page=${RELEASES_PER_PAGE}&page=${page}`,
      ),
    );
    if (!Array.isArray(releases)) {
      throw new Error("Invalid response from the openai/codex releases API");
    }

    for (const candidate of releases) {
      if (
        candidate.draft
        || !candidate.tag_name?.startsWith("rust-v")
        || !Array.isArray(candidate.assets)
      ) {
        continue;
      }
      const version = candidate.tag_name.replace(/^rust-v/, "");
      if (detectedSet.has(version) && hasPackageAsset(candidate, platform)) {
        return cacheRelease(candidate);
      }
    }
    if (releases.length < RELEASES_PER_PAGE) break;
  }

  throw new Error(
    `No openai/codex release matches the bundled desktop binary. `
    + `Found ${detectedVersions.length} version-like strings in ${bundledCodexPath}. `
    + `Checked the newest ${RELEASES_PER_PAGE * MAX_RELEASE_PAGES} releases; `
    + "set OPENAI_CODEX_RELEASE_TAG only as an exact-match override.",
  );
}

function findAsset(release, name) {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset?.browser_download_url) {
    throw new Error(`Release ${release.tag_name} is missing asset ${name}`);
  }
  return asset;
}

function getExpectedSha256(release, archiveName) {
  const checksumAsset = findAsset(release, CHECKSUM_ASSET);
  const checksums = curlText(checksumAsset.browser_download_url);

  for (const line of checksums.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match && match[2] === archiveName) return match[1].toLowerCase();
  }
  throw new Error(`${CHECKSUM_ASSET} has no digest for ${archiveName}`);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function findPackageRoot(extractDir) {
  const pending = [{ dir: extractDir, depth: 0 }];
  while (pending.length > 0) {
    const { dir, depth } = pending.shift();
    if (fs.existsSync(path.join(dir, "codex-package.json"))) return dir;
    if (depth >= 3) continue;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        pending.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  return null;
}

function resolveCodexPackage(platform, bundledCodexPath) {
  if (!platform.startsWith("linux-")) {
    throw new Error(
      `Official desktop resources must be preserved for ${platform}; `
      + "release substitution is only supported for Linux",
    );
  }
  const platformConfig = PLATFORM_CONFIG[platform];
  if (!platformConfig) {
    throw new Error(`Unsupported Codex release platform: ${platform}`);
  }

  const release = getRelease(bundledCodexPath, platform);
  const packageCacheKey = `${release.tag_name}/${platform}`;
  if (packageCache.has(packageCacheKey)) {
    return packageCache.get(packageCacheKey);
  }
  const archiveName = `codex-package-${platformConfig.target}.tar.gz`;
  const archiveAsset = findAsset(release, archiveName);
  const expectedSha256 = getExpectedSha256(release, archiveName);
  const safeTag = release.tag_name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const cacheDir = path.join(os.tmpdir(), "openai-codex-release", safeTag);
  const archivePath = path.join(cacheDir, archiveName);
  fs.mkdirSync(cacheDir, { recursive: true });

  let archiveIsValid = fs.existsSync(archivePath)
    && sha256File(archivePath) === expectedSha256;
  if (fs.existsSync(archivePath) && !archiveIsValid) {
    fs.unlinkSync(archivePath);
  }

  if (!archiveIsValid) {
    const partialPath = `${archivePath}.partial-${process.pid}`;
    if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
    console.log(`   [download] ${archiveName}`);
    try {
      downloadFile(archiveAsset.browser_download_url, partialPath);
      const actualSha256 = sha256File(partialPath);
      if (actualSha256 !== expectedSha256) {
        throw new Error(
          `SHA-256 mismatch for ${archiveName}: expected ${expectedSha256}, got ${actualSha256}`,
        );
      }
      fs.renameSync(partialPath, archivePath);
      archiveIsValid = true;
    } finally {
      if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
    }
  } else {
    console.log(`   [cache] ${archiveName}`);
  }

  if (!archiveIsValid) {
    throw new Error(`Unable to obtain a valid ${archiveName}`);
  }

  const extractDir = fs.mkdtempSync(path.join(cacheDir, `${platformConfig.target}-`));
  execFileSync("tar", ["xzf", archivePath, "-C", extractDir], { stdio: "pipe" });
  const packageRoot = findPackageRoot(extractDir);
  if (!packageRoot) {
    throw new Error(`${archiveName} does not contain codex-package.json`);
  }

  const metadata = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "codex-package.json"), "utf-8"),
  );
  for (const key of ["entrypoint", "resourcesDir", "pathDir"]) {
    if (typeof metadata[key] !== "string" || metadata[key].length === 0) {
      throw new Error(`${archiveName} has invalid ${key} metadata`);
    }
  }
  if (metadata.version !== release.version || metadata.target !== platformConfig.target) {
    throw new Error(
      `Package metadata mismatch: expected ${release.version}/${platformConfig.target}, `
      + `got ${metadata.version}/${metadata.target}`,
    );
  }

  const resolved = {
    archiveName,
    expectedSha256,
    metadata,
    packageRoot,
    platformConfig,
    release,
  };
  packageCache.set(packageCacheKey, resolved);
  return resolved;
}

function copyExecutable(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`Required Codex release file is missing: ${source}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  try { fs.chmodSync(destination, 0o755); } catch {}
}

function copyResourceTree(sourceDir, destinationDir, relativeDir = "") {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Required Codex resource directory is missing: ${sourceDir}`);
  }

  const copied = [];
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const relativePath = path.join(relativeDir, entry.name);
    const destination = path.join(destinationDir, relativePath);
    if (entry.isDirectory()) {
      copied.push(...copyResourceTree(source, destinationDir, relativePath));
    } else if (entry.isFile()) {
      copyExecutable(source, destination);
      copied.push(relativePath.split(path.sep).join("/"));
    } else {
      throw new Error(`Unsupported entry in Codex resources: ${source}`);
    }
  }
  return copied;
}

function installCodexReleaseResources(
  platform,
  resourcesDir,
  bundledCodexPath,
) {
  const resolved = resolveCodexPackage(platform, bundledCodexPath);
  const {
    archiveName,
    expectedSha256,
    metadata,
    packageRoot,
    platformConfig,
    release,
  } = resolved;
  const suffix = platformConfig.executableSuffix;
  const files = [
    [metadata.entrypoint, `codex${suffix}`],
    [`bin/codex-code-mode-host${suffix}`, `codex-code-mode-host${suffix}`],
    [`${metadata.pathDir}/rg${suffix}`, `rg${suffix}`],
  ];

  fs.mkdirSync(resourcesDir, { recursive: true });
  console.log(`   [codex release] ${release.version} (${release.tag_name})`);
  const installedFiles = [];
  for (const [sourceRelative, destinationName] of files) {
    const source = path.join(packageRoot, ...sourceRelative.split("/"));
    const destination = path.join(resourcesDir, destinationName);
    copyExecutable(source, destination);
    installedFiles.push(destinationName);
    console.log(`   [replace] ${destinationName}`);
  }

  const releaseResources = copyResourceTree(
    path.join(packageRoot, metadata.resourcesDir),
    resourcesDir,
  );
  for (const relativePath of releaseResources) {
    installedFiles.push(relativePath);
    console.log(`   [replace] ${relativePath}`);
  }

  const manifest = {
    repository: "openai/codex",
    tag: release.tag_name,
    version: release.version,
    platform,
    target: metadata.target,
    asset: archiveName,
    sha256: expectedSha256,
    files: installedFiles,
  };
  fs.writeFileSync(
    path.join(resourcesDir, "codex-release.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

module.exports = {
  PLATFORM_CONFIG,
  detectBundledCodexVersions,
  getRelease,
  installCodexReleaseResources,
  resolveCodexPackage,
};
