#!/usr/bin/env node
/**
 * Post-build patch: Remove plugin auth gate + browser-use Statsig gate
 *
 * 1. Plugin auth gate (gradient-*.js or similar):
 *    Function: (e) => e !== `chatgpt`  → replaced with (e) => !1
 *    This function blocks non-ChatGPT users from accessing plugins.
 *
 * 2. Browser-use Statsig gate (use-browser-agent-availability-*.js):
 *    Statsig gate ID "410262010" check → replaced with !0
 *    This gate controls browser-use feature availability.
 *
 * AST matching strategy:
 *   1. Find functions whose body is a single return of BinaryExpression
 *      X !== `chatgpt`, replace the expression with !1
 *   2. Find CallExpression calling a gate checker with literal "410262010",
 *      replace with !0
 *
 * Usage:
 *   node scripts/patch-plugin-auth.js [platform]   # Apply
 *   node scripts/patch-plugin-auth.js --check       # Dry-run
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

// ──────────────────────────────────────────────
//  AST walker
// ──────────────────────────────────────────────

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

function getLiteralValue(node) {
  if (!node) return null;
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1)
    return node.quasis[0].value.cooked;
  return null;
}

// ──────────────────────────────────────────────
//  Rule 1: Plugin auth — e !== `chatgpt` → !1
// ──────────────────────────────────────────────

function findPluginAuthPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    // Match: function(e) { return e !== `chatgpt` }
    if (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression") return;
    const body = node.body;
    if (!body || body.type !== "BlockStatement" || body.body.length !== 1) return;

    const ret = body.body[0];
    if (ret.type !== "ReturnStatement" || !ret.argument) return;

    const arg = ret.argument;
    if (arg.type !== "BinaryExpression" || arg.operator !== "!==") return;

    // One side must be `chatgpt`
    const leftVal = getLiteralValue(arg.left);
    const rightVal = getLiteralValue(arg.right);
    if (leftVal !== "chatgpt" && rightVal !== "chatgpt") return;

    const exprSrc = source.slice(arg.start, arg.end);
    if (exprSrc === "!1") return;

    patches.push({
      id: "plugin_auth_gate",
      start: arg.start,
      end: arg.end,
      replacement: "!1",
      original: exprSrc,
    });
  });

  return patches;
}

// ──────────────────────────────────────────────
//  Rule 2: Statsig gate bypasses — gt(`ID`) → !0
//    410262010 — browser-use availability
//    410065390 — external browser (Chrome extension)
// ──────────────────────────────────────────────

const STATSIG_GATE_IDS = new Set(["410262010", "410065390"]);

function findBrowserUsePatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.arguments.length !== 1) return;

    const argVal = getLiteralValue(node.arguments[0]);
    if (!STATSIG_GATE_IDS.has(argVal)) return;

    // Callee must be a simple identifier (gate checker function)
    if (node.callee.type !== "Identifier") return;

    const exprSrc = source.slice(node.start, node.end);
    if (exprSrc === "!0") return;

    patches.push({
      id: `statsig_gate_${argVal}`,
      start: node.start,
      end: node.end,
      replacement: "!0",
      original: exprSrc,
    });
  });

  return patches;
}

// ──────────────────────────────────────────────
//  Bundle location
// ──────────────────────────────────────────────

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets"))
      );

  const targets = [];

  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;

    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js") || f.startsWith("index-")) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");

      // Plugin auth: file contains `chatgpt` and !== operator and is small
      if (src.includes("chatgpt") && src.includes("!==") && src.length < 5000) {
        targets.push({ platform: plat, path: fp, type: "plugin_auth" });
      }

      // Statsig gates: file contains any tracked gate ID
      for (const gateId of STATSIG_GATE_IDS) {
        if (src.includes(gateId)) {
          targets.push({ platform: plat, path: fp, type: "statsig_gate" });
          break;
        }
      }
    }
  }

  return targets;
}

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const targets = locateTargets(platform);

  if (targets.length === 0) {
    console.log("[ok] No plugin auth or browser-use gate targets found");
    return;
  }

  // Deduplicate by path
  const seen = new Set();
  const unique = targets.filter((t) => {
    if (seen.has(t.path)) return false;
    seen.add(t.path);
    return true;
  });

  for (const bundle of unique) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1024).toFixed(1)} KB`);

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = [
      ...findPluginAuthPatches(ast, source),
      ...findBrowserUsePatches(ast, source),
    ];

    if (patches.length === 0) {
      console.log("   [ok] Already patched or no match");
      continue;
    }

    if (isCheck) {
      console.log(`   [?] Matches: ${patches.length}`);
      for (const p of patches) {
        console.log(`     > [${p.id}] offset ${p.start}: ${p.original} -> ${p.replacement}`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`   * [${p.id}] offset ${p.start}: ${p.original} -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`   [ok] ${patches.length} gates patched`);
  }
}

main();
