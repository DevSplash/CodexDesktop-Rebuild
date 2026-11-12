/**
 * Post-build patch: Force-enable i18n by bypassing Statsig cloud control
 *
 * Codex i18n is gated behind a Statsig layer field "enable_i18n".
 * The Statsig server can push enable_i18n=false to override the default, and
 * some chunks default enable_i18n to !1 when offline.
 *
 * AST match: any .get("enable_i18n", <default>) call expression
 * (optionally wrapped in ChainExpression for ?.get), replaced with !0.
 *
 * Target files: any chunk under webview/assets/ (including Rspack async/)
 * containing "enable_i18n".
 *
 * Usage:
 *   node scripts/patch-i18n.js [platform]   # Apply (mac-arm64/mac-x64/win/unix/omit=all)
 *   node scripts/patch-i18n.js --check      # Dry-run
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { listJavaScriptFiles, relPath, SRC_DIR } = require("./patch-util");

const MARKER = "/* Codex i18n patch */";
const FIELD_NAME = "enable_i18n";

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

/**
 * Find CallExpression (possibly wrapped in ChainExpression):
 *   X?.get("enable_i18n", <default>)
 *   X.get("enable_i18n", <default>)
 *
 * AST structural match — no hardcoded layer ID. The .get("enable_i18n", ...)
 * pattern on a MemberExpression is unique enough.
 *
 * Replace the outermost expression (ChainExpression or CallExpression) with !0.
 */
function collectPatches(ast, source) {
  const patches = [];
  const seen = new Set();

  walk(ast, (node) => {
    let callNode = null;
    let replaceNode = null;

    // Match ChainExpression wrapping a CallExpression
    if (node.type === "ChainExpression" && node.expression?.type === "CallExpression") {
      callNode = node.expression;
      replaceNode = node;
    } else if (node.type === "CallExpression") {
      callNode = node;
      replaceNode = node;
    }

    if (!callNode) return;

    // Callee must be MemberExpression with property "get"
    const callee = callNode.callee;
    if (!callee || callee.type !== "MemberExpression") return;
    const prop = callee.property;
    if (!prop) return;
    const propName = prop.type === "Identifier" ? prop.name
      : prop.type === "Literal" ? prop.value : null;
    if (propName !== "get") return;

    // First argument must be string literal "enable_i18n"
    const args = callNode.arguments;
    if (!args || args.length < 2) return;
    const firstArg = args[0];
    const argValue = firstArg.type === "Literal" ? firstArg.value
      : (firstArg.type === "TemplateLiteral" && firstArg.expressions.length === 0
        && firstArg.quasis.length === 1) ? firstArg.quasis[0].value.cooked
      : null;
    if (argValue !== FIELD_NAME) return;

    // Already patched?
    const exprSrc = source.slice(replaceNode.start, replaceNode.end);
    if (exprSrc === "!0") return;

    // Dedup (when ChainExpression wraps CallExpression, outer node visits first)
    if (seen.has(callNode.start)) return;
    seen.add(callNode.start);
    seen.add(replaceNode.start);

    patches.push({
      start: replaceNode.start,
      end: replaceNode.end,
      replacement: "!0",
      original: exprSrc,
    });
  });

  return patches;
}

function selectedPlatforms(platform) {
  const all = ["mac-arm64", "mac-x64", "win"];
  if (platform === "unix") {
    return ["mac-arm64", "mac-x64"].filter((p) =>
      fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
    );
  }
  if (platform) return [platform];
  return all.filter((p) => fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")));
}

function locateTargets(platform) {
  const targets = [];
  for (const plat of selectedPlatforms(platform)) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const fp of listJavaScriptFiles(assetsDir)) {
      const src = fs.readFileSync(fp, "utf-8");
      if (src.includes(FIELD_NAME) || src.includes(MARKER)) {
        targets.push({ platform: plat, path: fp, source: src });
      }
    }
  }
  return targets;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win", "unix"].includes(a));

  const targets = locateTargets(platform);

  if (targets.length === 0) {
    console.log("  [skip] No files contain enable_i18n (upstream removed gate)");
    return;
  }

  let grandTotal = 0;
  let failed = 0;
  const pendingWrites = [];

  for (const bundle of targets) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = bundle.source;
    console.log(`   size: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = collectPatches(ast, source);
    grandTotal += patches.length;

    if (patches.length === 0) {
      if (source.includes(MARKER)) {
        console.log("   [ok] enable_i18n already bypassed");
      } else {
        console.error("   [x] File references enable_i18n, but no .get(\"enable_i18n\", ...) AST node matched");
        failed++;
      }
      continue;
    }

    if (isCheck) {
      console.log(`   [?] Matches: ${patches.length}`);
      for (const p of patches) {
        console.log(`     > offset ${p.start}: ${p.original.slice(0, 60)} -> !0`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`   * offset ${p.start}: ${p.original.slice(0, 60)} -> !0`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }
    if (!code.includes(MARKER)) {
      code = `${MARKER}\n${code}`;
    }

    parse(code, { ecmaVersion: "latest", sourceType: "module" });
    pendingWrites.push({ path: bundle.path, code, count: patches.length });
  }

  if (failed > 0) process.exit(1);

  for (const write of pendingWrites) {
    fs.writeFileSync(write.path, write.code, "utf-8");
    console.log(`   [ok] ${relPath(write.path)}: i18n gate bypassed (${write.count} replacement(s))`);
  }

  if (isCheck && grandTotal > 0) {
    console.log(`\n=> Total: ${grandTotal} patchable location(s)`);
  }
}

if (require.main === module) main();

module.exports = { FIELD_NAME, MARKER, collectPatches };
