#!/usr/bin/env node
/**
 * Post-build patch: Force-enable DevTools & InspectElement
 *
 * Strategy (AST-based):
 *   Across main-process build chunks, find Property / MethodDefinition nodes:
 *   - allowInspectElement: <value>  ->  allowInspectElement: !0
 *   - devTools: <expr containing allowDevtools>  ->  devTools: !0
 *   - allowDevtools: <fn>  ->  ()=>!0 (BuildFlavor helper gating menu & shortcuts)
 *
 * Usage:
 *   node scripts/patch-devtools.js [platform]   # Apply patch (mac-arm64/mac-x64/win/unix/omit=all)
 *   node scripts/patch-devtools.js --check      # Dry-run: report matches
 */
const fs = require("fs");
const { parse } = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

function walkAST(node, visitor, parent) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      child.forEach((c) => walkAST(c, visitor, node));
    } else if (child && typeof child === "object" && child.type) {
      walkAST(child, visitor, node);
    }
  }
}

function getPropertyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return node.value;
  return null;
}

const RULES = [
  {
    id: "allowInspectElement",
    match(node, source, parent) {
      if (node.type !== "Property") return null;
      if (getPropertyName(node.key) !== "allowInspectElement") return null;
      // Skip destructured function params (ObjectPattern context)
      if (parent && parent.type === "ObjectPattern") return null;
      if (node.shorthand) return null;
      const val = node.value;
      const valSrc = source.slice(val.start, val.end).trim();
      if (valSrc === "!0" || valSrc === "true") return { already: true };
      return { start: val.start, end: val.end, replacement: "!0", original: valSrc };
    },
  },
  {
    id: "devTools",
    match(node, source, parent) {
      if (node.type !== "Property") return null;
      if (parent && parent.type === "ObjectPattern") return null;
      if (getPropertyName(node.key) !== "devTools") return null;
      const val = node.value;
      const valSrc = source.slice(val.start, val.end).trim();
      if (valSrc === "!0" || valSrc === "true") return { already: true };
      if (!valSrc.includes("allowDevtools") && !valSrc.includes("allowDevTools")) {
        return null;
      }
      return { start: val.start, end: val.end, replacement: "!0", original: valSrc };
    },
  },
  {
    id: "allowDevtoolsHelper",
    match(node, source, parent) {
      if (node.type !== "Property" && node.type !== "MethodDefinition") return null;
      if (parent && parent.type === "ObjectPattern") return null;
      const name = getPropertyName(node.key);
      if (name !== "allowDevtools" && name !== "allowDevTools") return null;
      const fn = node.value;
      if (fn?.type !== "ArrowFunctionExpression" && fn?.type !== "FunctionExpression") return null;
      const body = fn.body;
      if (!body) return null;
      if (body.type === "BlockStatement") {
        const bodySrc = source.slice(body.start, body.end).replace(/\s+/g, "");
        if (bodySrc === "{return!0}" || bodySrc === "{return!0;}") return { already: true };
        return { start: body.start, end: body.end, replacement: "{return !0}", original: source.slice(body.start, body.end) };
      }
      const exprSrc = source.slice(body.start, body.end).trim();
      if (exprSrc === "!0" || exprSrc === "true") return { already: true };
      return { start: body.start, end: body.end, replacement: "!0", original: exprSrc };
    },
  },
];

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const rawPlatform = args.find((a) => ["mac-arm64", "mac-x64", "win", "unix"].includes(a));
  const platforms = rawPlatform === "unix" ? ["mac-arm64", "mac-x64"] : rawPlatform ? [rawPlatform] : [undefined];

  const bundles = platforms.flatMap((platform) =>
    locateBundles({
      dir: "build",
      pattern: /\.js$/,
      platform,
      allMatches: true,
    }),
  );

  if (bundles.length === 0) {
    console.error("[x] No main-process build bundles found");
    process.exit(1);
  }

  const byPlatform = new Map();
  for (const bundle of bundles) {
    const list = byPlatform.get(bundle.platform) ?? [];
    list.push(bundle);
    byPlatform.set(bundle.platform, list);
  }

  let failed = 0;
  const pendingWrites = [];

  for (const [plat, platBundles] of byPlatform) {
    let platPatched = 0;
    let platAlready = 0;

    for (const bundle of platBundles) {
      const source = fs.readFileSync(bundle.path, "utf-8");
      if (
        !source.includes("allowInspectElement") &&
        !/allowDevtools|allowDevTools/.test(source)
      ) {
        continue;
      }

      const t0 = Date.now();
      const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
      const parseMs = Date.now() - t0;

      const patches = [];
      const seen = new Set();
      let fileAlready = 0;

      walkAST(ast, (node, parent) => {
        for (const rule of RULES) {
          const result = rule.match(node, source, parent);
          if (!result) continue;
          if (result.already) {
            fileAlready++;
            continue;
          }
          const key = `${result.start}:${result.end}`;
          if (seen.has(key)) continue;
          seen.add(key);
          patches.push({ ...result, rule: rule.id });
        }
      });

      platAlready += fileAlready;
      if (patches.length === 0) {
        if (fileAlready > 0) {
          console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
          console.log(`   [ok] DevTools already enabled (${fileAlready} site(s))`);
        }
        continue;
      }

      platPatched += patches.length;
      console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
      console.log(`   size: ${(source.length / 1048576).toFixed(1)} MB, parse: ${parseMs}ms`);

      patches.sort((a, b) => b.start - a.start);

      if (isCheck) {
        console.log(`   [?] Matches: ${patches.length}`);
        for (const p of [...patches].reverse()) {
          console.log(`     > [${p.rule}] offset ${p.start}: ${p.original} -> ${p.replacement}`);
        }
        continue;
      }

      let patched = source;
      for (const p of patches) {
        console.log(`   * [${p.rule}] offset ${p.start}: ${p.original} -> ${p.replacement}`);
        patched = patched.slice(0, p.start) + p.replacement + patched.slice(p.end);
      }

      parse(patched, { ecmaVersion: "latest", sourceType: "module" });
      pendingWrites.push({ path: bundle.path, code: patched, count: patches.length });
    }

    if (platPatched === 0 && platAlready === 0) {
      console.error(`  [x] ${plat}: no DevTools / allowInspectElement properties matched`);
      failed++;
    }
  }

  if (failed > 0) process.exit(1);

  for (const write of pendingWrites) {
    fs.writeFileSync(write.path, write.code, "utf-8");
    console.log(`   [ok] ${relPath(write.path)}: DevTools force-enabled (${write.count} replacement(s))`);
  }
}

if (require.main === module) main();

module.exports = { RULES };
