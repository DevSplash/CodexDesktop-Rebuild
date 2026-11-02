/**
 * Post-build patch: Update copyright text
 *
 * Uses AST to locate the copyright property or the About dialog's HTML template
 * and replace the copyright text with a custom value, including split build chunks.
 *
 * Usage:
 *   node scripts/patch-copyright.js [platform]   # Apply patch (unix/win/omit=both)
 *   node scripts/patch-copyright.js --check       # Dry-run: report matches
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

// ──────────────────────────────────────────────
//  Config
// ──────────────────────────────────────────────

const OLD_COPYRIGHT = "\u00A9 OpenAI"; // (c) OpenAI
const NEW_COPYRIGHT = "\u00A9 OpenAI \u00B7 Cometix Space"; // (c) OpenAI . Cometix Space

// ──────────────────────────────────────────────
//  AST walker
// ──────────────────────────────────────────────

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === "string") walk(item, visitor);
      }
    } else if (child && typeof child.type === "string") {
      walk(child, visitor);
    }
  }
}

// ──────────────────────────────────────────────
//  Patch rule
// ──────────────────────────────────────────────

function collectPatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    // Newer bundles render their own About dialog instead of using Electron's
    // setAboutPanelOptions. Match only its copyright element, not arbitrary
    // OpenAI references, and accept the compiler's escaped copyright symbol.
    if (node.type === "TemplateElement") {
      const raw = source.slice(node.start, node.end);
      const pattern = /(<div\b[^>]*\bclass=["']copyright["'][^>]*>)(?:\u00a9|\\x[aA]9|\\u00[aA]9) OpenAI(<\/div>)/g;
      for (const match of raw.matchAll(pattern)) {
        patches.push({
          start: node.start + match.index,
          end: node.start + match.index + match[0].length,
          replacement: `${match[1]}${NEW_COPYRIGHT}${match[2]}`,
          original: match[0],
        });
      }
      return;
    }
    if (node.type !== "Property") return;
    const keyName =
      node.key.type === "Identifier"
        ? node.key.name
        : node.key.type === "Literal"
          ? node.key.value
          : null;
    if (keyName !== "copyright") return;

    const val = node.value;

    // Case 1: Literal string  copyright: "..."
    if (val.type === "Literal" && val.value === OLD_COPYRIGHT) {
      patches.push({
        start: val.start,
        end: val.end,
        replacement: JSON.stringify(NEW_COPYRIGHT),
        original: source.slice(val.start, val.end),
      });
      return;
    }

    // Case 2: Template literal  copyright: `...`  (no expressions, single quasi)
    if (
      val.type === "TemplateLiteral" &&
      val.expressions.length === 0 &&
      val.quasis.length === 1 &&
      val.quasis[0].value.cooked === OLD_COPYRIGHT
    ) {
      patches.push({
        start: val.start,
        end: val.end,
        replacement: "`" + NEW_COPYRIGHT + "`",
        original: source.slice(val.start, val.end),
      });
      return;
    }
  });
  return patches;
}

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const bundles = locateBundles({
    dir: "build",
    pattern: /\.js$/,
    platform,
    allMatches: true,
  });

  if (bundles.length === 0) {
    console.error("[x] No main-process build bundles found");
    process.exit(1);
  }

  for (const bundle of bundles) {
    const source = fs.readFileSync(bundle.path, "utf-8");
    if (!source.includes("copyright")) continue;
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    console.log(`   size: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = collectPatches(ast, source);

    if (patches.length === 0) {
      // Check if already patched
      if (source.includes(NEW_COPYRIGHT)) {
        console.log("   [ok] Already patched");
      } else {
        console.log("   [!] No copyright property matched");
      }
      continue;
    }

    if (isCheck) {
      console.log(`   [?] Matches: ${patches.length}`);
      for (const p of patches) {
        console.log(`     > offset ${p.start}: ${p.original} -> ${p.replacement}`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);
    let code = source;
    for (const p of patches) {
      console.log(`   * offset ${p.start}: ${p.original} -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    parse(code, { ecmaVersion: "latest", sourceType: "module" });
    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`   [ok] Copyright updated: ${patches.length} replacements`);
  }
}

main();
