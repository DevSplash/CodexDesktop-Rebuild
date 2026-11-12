#!/usr/bin/env node
/**
 * patch-updater.js — Disable Sparkle (macOS), Windows, and Linux auto-updaters
 *
 * AST match: in main-process build chunks defining BuildFlavor updater helpers,
 * find these method/property definitions (FunctionExpression, ArrowFunctionExpression,
 * or MethodDefinition) and replace their return expression/body so they return false.
 *
 * Specifically targets:
 *   shouldIncludeSparkle(...) => ...               → !1
 *   shouldIncludeWindowsUpdater(...) => ...        → !1
 *   shouldIncludeLinuxPackageUpdater(...) => ...   → !1
 *   shouldIncludeWindowsMsixUpdater(...) => ...    → !1
 *   shouldIncludeUpdater(...) => ...               → !1
 *
 * Usage:
 *   node scripts/patch-updater.js [platform]   # Apply (mac-arm64/mac-x64/win/unix/omit=all)
 *   node scripts/patch-updater.js --check      # Dry-run
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { relPath, SRC_DIR } = require("./patch-util");

const UPDATER_METHODS = new Set([
  "shouldIncludeSparkle",
  "shouldIncludeWindowsUpdater",
  "shouldIncludeLinuxPackageUpdater",
  "shouldIncludeWindowsMsixUpdater",
  "shouldIncludeUpdater",
]);

function walk(node, visitor, parent = null) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor, node);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor, node);
    }
  }
}

function collectPatches(ast, source) {
  const patches = [];
  let already = 0;

  walk(ast, (node, parent) => {
    if (node.type !== "Property" && node.type !== "MethodDefinition") return;
    if (parent && parent.type === "ObjectPattern") return;

    const keyName = node.key?.name ?? node.key?.value;
    if (!UPDATER_METHODS.has(keyName)) return;

    const fn = node.value;
    if (fn?.type !== "FunctionExpression" && fn?.type !== "ArrowFunctionExpression") return;

    const body = fn.body;
    if (!body) return;

    if (body.type === "BlockStatement") {
      if (body.body.length === 1 && body.body[0].type === "ReturnStatement" && body.body[0].argument) {
        const arg = body.body[0].argument;
        const retSrc = source.slice(arg.start, arg.end).trim();
        if (retSrc === "!1" || retSrc === "false") {
          already++;
          return;
        }
        patches.push({
          id: keyName,
          start: arg.start,
          end: arg.end,
          replacement: "!1",
          original: retSrc.length > 50 ? retSrc.slice(0, 47) + "..." : retSrc,
        });
      } else {
        const bodySrc = source.slice(body.start, body.end).replace(/\s+/g, "");
        if (bodySrc === "{return!1}" || bodySrc === "{return!1;}") {
          already++;
          return;
        }
        patches.push({
          id: keyName,
          start: body.start,
          end: body.end,
          replacement: "{return !1}",
          original: source.slice(body.start, Math.min(body.end, body.start + 47)) + "...",
        });
      }
      return;
    }

    // ArrowFunctionExpression with concise expression body: (e,t,n)=>c(e,t,"darwin",n)
    const exprSrc = source.slice(body.start, body.end).trim();
    if (exprSrc === "!1" || exprSrc === "false") {
      already++;
      return;
    }
    patches.push({
      id: keyName,
      start: body.start,
      end: body.end,
      replacement: "!1",
      original: exprSrc.length > 50 ? exprSrc.slice(0, 47) + "..." : exprSrc,
    });
  });

  return { patches, already };
}

function selectedPlatforms(platform) {
  const all = ["mac-arm64", "mac-x64", "win"];
  if (platform === "unix") {
    return ["mac-arm64", "mac-x64"].filter((p) =>
      fs.existsSync(path.join(SRC_DIR, p, "_asar", ".vite", "build")),
    );
  }
  if (platform) return [platform];
  return all.filter((p) => fs.existsSync(path.join(SRC_DIR, p, "_asar", ".vite", "build")));
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win", "unix"].includes(a));

  const platforms = selectedPlatforms(platform);
  if (platforms.length === 0) {
    console.error("  [x] No main-process build directories found");
    process.exit(1);
  }

  let failed = 0;
  const pendingWrites = [];

  for (const plat of platforms) {
    const buildDir = path.join(SRC_DIR, plat, "_asar", ".vite", "build");
    if (!fs.existsSync(buildDir)) {
      console.error(`  [x] ${plat}: missing ${relPath(buildDir)}`);
      failed++;
      continue;
    }

    let platPatched = 0;
    let platAlready = 0;

    for (const f of fs.readdirSync(buildDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(buildDir, f);
      const source = fs.readFileSync(fp, "utf-8");
      if (!source.includes("shouldIncludeSparkle") && !source.includes("shouldIncludeUpdater")) {
        continue;
      }

      const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
      const { patches, already } = collectPatches(ast, source);
      platAlready += already;

      // Skip chunks that only contain call sites (not definitions).
      if (patches.length === 0 && already === 0) continue;

      console.log(`  [${plat}] ${relPath(fp)}`);
      if (patches.length === 0) {
        console.log(`    [ok] Already patched (${already} method(s))`);
        continue;
      }

      platPatched += patches.length;
      if (isCheck) {
        for (const p of patches) {
          console.log(`    [?] [${p.id}] ${p.original} -> ${p.replacement}`);
        }
        continue;
      }

      patches.sort((a, b) => b.start - a.start);
      let code = source;
      for (const p of patches) {
        console.log(`    * [${p.id}] ${p.original} -> ${p.replacement}`);
        code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
      }

      parse(code, { ecmaVersion: "latest", sourceType: "module" });
      pendingWrites.push({ path: fp, code, count: patches.length });
    }

    if (platPatched === 0 && platAlready === 0) {
      console.error(`  [x] ${plat}: updater method definitions not found or unrecognized AST shape`);
      failed++;
    }
  }

  if (failed > 0) process.exit(1);

  for (const write of pendingWrites) {
    fs.writeFileSync(write.path, write.code, "utf-8");
    console.log(`    [ok] ${relPath(write.path)}: ${write.count} updater method(s) disabled`);
  }
}

if (require.main === module) main();

module.exports = { UPDATER_METHODS, collectPatches };
