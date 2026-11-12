#!/usr/bin/env node
/**
 * Post-build patch: Force-enable browser-use, computer-use, and bundled plugins
 *
 * Renderer rules (webview/assets/**):
 *   - Browser / computer use availability hooks:
 *     AST match innermost function containing featureName "browser_use",
 *     "browser_use_external", or "computer_use" that returns
 *     {allowed?, available, isLoading, ...} -> force allowed/available to !0.
 *   - Statsig numeric gate calls inside those availability hooks
 *     (Identifier, MemberExpression, or Rspack (0, mod.fn)("410262010")) -> !0.
 *   - Legacy Vite fallbacks for standalone plugin auth gate & /goal gate when present.
 *
 * Main-process rules (.vite/build/*.js):
 *   - Default desktop feature flags (browserPane, inAppBrowserUse, externalBrowserUse,
 *     computerUse, etc.) -> !0.
 *   - "features.js_repl": !1 -> !0.
 *   - Bundled plugins .filter(r => r.isAvailable({...features...})) -> ()=>!0.
 *   - Native pipe peer authorization (code-signing TeamID check) -> bypassed (!0 / !1).
 *
 * Usage:
 *   node scripts/patch-plugin-auth.js [platform]   # Apply (mac-arm64/mac-x64/win/unix/omit=all)
 *   node scripts/patch-plugin-auth.js --check      # Dry-run
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { listJavaScriptFiles, relPath, SRC_DIR } = require("./patch-util");

const MARKER = "/* Codex plugin-auth patch */";
const FEATURE_NAME_RE =
  /featureName:\s*["'`](?:browser_use|browser_use_external|computer_use)["'`]/;

function isFunctionNode(node) {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  );
}

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

function getLiteralValue(node) {
  if (!node) return null;
  if (node.type === "Literal") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function getKeyName(keyNode) {
  if (!keyNode) return null;
  if (keyNode.type === "Identifier") return keyNode.name;
  return getLiteralValue(keyNode);
}

function isGateCallee(callee) {
  const target = callee?.type === "ChainExpression" ? callee.expression : callee;
  if (!target) return false;
  if (target.type === "Identifier" || target.type === "MemberExpression") return true;
  if (target.type === "SequenceExpression" && target.expressions.length >= 2) {
    const last = target.expressions[target.expressions.length - 1];
    return last?.type === "MemberExpression" || last?.type === "Identifier";
  }
  return false;
}

// Find innermost functions matching FEATURE_NAME_RE so Rspack module wrapper
// functions do not broaden the match across unrelated sibling hooks.
function findInnermostFeatureFunctions(ast, source) {
  const matched = [];
  walk(ast, (node) => {
    if (!isFunctionNode(node)) return;
    const slice = source.slice(node.start, node.end);
    if (!FEATURE_NAME_RE.test(slice)) return;

    let childHasFeature = false;
    walk(node.body, (inner) => {
      if (childHasFeature || !isFunctionNode(inner)) return;
      if (FEATURE_NAME_RE.test(source.slice(inner.start, inner.end))) {
        childHasFeature = true;
      }
    });
    if (!childHasFeature) matched.push(node);
  });
  return matched;
}

// ── Legacy Rule 1: Plugin auth — function(e){return e!==`chatgpt`} → !1 ──

function findPluginAuthPatches(ast, source) {
  const patches = [];
  let already = 0;
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression") return;
    const body = node.body;
    if (!body || body.type !== "BlockStatement" || body.body.length !== 1) return;
    const ret = body.body[0];
    if (ret.type !== "ReturnStatement" || !ret.argument) return;
    const arg = ret.argument;
    if (source.slice(arg.start, arg.end) === "!1") {
      already++;
      return;
    }
    if (arg.type !== "BinaryExpression" || arg.operator !== "!==") return;
    if (
      getLiteralValue(arg.left) !== "chatgpt" &&
      getLiteralValue(arg.right) !== "chatgpt"
    ) {
      return;
    }
    const expr = source.slice(arg.start, arg.end);
    patches.push({
      id: "plugin_auth_gate",
      start: arg.start,
      end: arg.end,
      replacement: "!1",
      original: expr,
    });
  });
  return { patches, already };
}

// ── Legacy Rule 6: Force /goal slash command available ──

function findGoalGatePatches(ast, source) {
  const patches = [];
  let already = 0;
  walk(ast, (node) => {
    if (node.type !== "LogicalExpression" || node.operator !== "&&") return;
    const slice = source.slice(node.start, node.end);
    if (!/["'`]goals["'`]/.test(slice) || !/["'`]cloud["'`]/.test(slice)) return;
    let hasGateCall = false;
    walk(node, (inner) => {
      if (inner.type !== "CallExpression") return;
      if (!isGateCallee(inner.callee)) return;
      if (inner.arguments?.length !== 1) return;
      const val = getLiteralValue(inner.arguments[0]);
      if (val && /^\d{6,}$/.test(val)) hasGateCall = true;
    });
    if (!hasGateCall) return;
    const right = node.right;
    const rightSrc = source.slice(right.start, right.end);
    if (!rightSrc.includes("cloud")) return;
    const fullSrc = source.slice(node.start, node.end);
    if (fullSrc === rightSrc) {
      already++;
      return;
    }
    patches.push({
      id: "goal_gate_bypass",
      start: node.start,
      end: node.end,
      replacement: rightSrc,
      original: fullSrc.slice(0, 50) + "...",
    });
  });
  return { patches, already };
}

// ── Rule 2: Force browser-use / computer-use availability ──

function findBrowserAvailPatches(ast, source) {
  const patches = [];
  let already = 0;

  for (const fnNode of findInnermostFeatureFunctions(ast, source)) {
    walk(fnNode, (inner) => {
      if (inner.type !== "ObjectExpression") return;
      const props = inner.properties;
      if (!props || props.length < 3) return;
      const keys = props.map((p) => getKeyName(p.key));
      if (!keys.includes("available") || !keys.includes("isLoading")) return;

      for (const prop of props) {
        if (!prop.value) continue;
        const name = getKeyName(prop.key);
        if (name === "allowed" || name === "available") {
          const val = source.slice(prop.value.start, prop.value.end).trim();
          if (val === "!0" || val === "true") {
            already++;
            continue;
          }
          patches.push({
            id: `browser_use_${name}`,
            start: prop.value.start,
            end: prop.value.end,
            replacement: "!0",
            original: val,
          });
        }
      }
    });
  }

  return { patches, already };
}

// ── Rule 3: Statsig gate bypass inside availability hooks ──

function findStatsigGatePatches(ast, source) {
  const patches = [];
  let already = 0;

  for (const fnNode of findInnermostFeatureFunctions(ast, source)) {
    walk(fnNode, (inner, parent) => {
      if (inner.type !== "CallExpression") return;
      if (!isGateCallee(inner.callee)) return;
      if (inner.arguments?.length !== 1) return;
      const argVal = getLiteralValue(inner.arguments[0]);
      if (!argVal || !/^\d{6,}$/.test(argVal)) return;

      const target = parent?.type === "ChainExpression" ? parent : inner;
      const expr = source.slice(target.start, target.end).trim();
      if (expr === "!0" || expr === "true") {
        already++;
        return;
      }

      patches.push({
        id: `statsig_gate_${argVal}`,
        start: target.start,
        end: target.end,
        replacement: "!0",
        original: expr,
      });
    });
  }

  return { patches, already };
}

// ── Rule 4: Force default desktop feature availability & peer-auth bypass ──

const FEATURE_KEYS = [
  "browserPane",
  "inAppBrowserUse",
  "inAppBrowserUseAllowed",
  "externalBrowserUse",
  "externalBrowserUseAllowed",
  "computerUse",
  "computerUseNodeRepl",
  "control",
  "multiWindow",
];

function findFeatureDefaultPatches(ast, source) {
  const patches = [];
  let already = 0;

  // Part A: Force default feature values from !1 to !0
  walk(ast, (node) => {
    if (node.type !== "ObjectExpression") return;
    const props = node.properties;
    if (!props || props.length < 5) return;
    const keys = props.map((p) => getKeyName(p.key));
    let matchCount = 0;
    for (const k of FEATURE_KEYS) if (keys.includes(k)) matchCount++;
    if (matchCount < 3) return;

    for (const prop of props) {
      if (!prop.value) continue;
      const name = getKeyName(prop.key);
      if (!FEATURE_KEYS.includes(name)) continue;
      const val = source.slice(prop.value.start, prop.value.end).trim();
      if (val === "!0" || val === "true") {
        already++;
        continue;
      }
      if (val !== "!1" && val !== "false") continue;
      patches.push({
        id: `feature_default_${name}`,
        start: prop.value.start,
        end: prop.value.end,
        replacement: "!0",
        original: val,
      });
    }
  });

  // Part A2: Force "features.js_repl" to true in any feature config map
  walk(ast, (node) => {
    if (node.type !== "ObjectExpression") return;
    for (const prop of node.properties || []) {
      if (!prop.value) continue;
      if (getKeyName(prop.key) !== "features.js_repl") continue;
      const val = source.slice(prop.value.start, prop.value.end).trim();
      if (val === "!0" || val === "true") {
        already++;
        continue;
      }
      if (val !== "!1" && val !== "false") continue;
      patches.push({
        id: "feature_js_repl",
        start: prop.value.start,
        end: prop.value.end,
        replacement: "!0",
        original: val,
      });
    }
  });

  // Part B: Bypass the isAvailable filter in bundled plugins descriptor
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.callee?.type !== "MemberExpression") return;
    if (getKeyName(node.callee.property) !== "filter") return;
    if (node.arguments?.length !== 1) return;
    const cb = node.arguments[0];
    if (cb.type !== "ArrowFunctionExpression") return;
    const cbSrc = source.slice(cb.start, cb.end);
    if (cbSrc === "()=>!0") {
      already++;
      return;
    }
    if (!cbSrc.includes("isAvailable") || !cbSrc.includes("features")) return;
    patches.push({
      id: "bundled_plugins_filter_bypass",
      start: cb.start,
      end: cb.end,
      replacement: "()=>!0",
      original: cbSrc.slice(0, 48) + (cbSrc.length > 48 ? "..." : ""),
    });
  });

  // Part C1: Bypass browser-use native pipe peer authorization in authorizer loader
  walk(ast, (node) => {
    if (!isFunctionNode(node)) return;
    const slice = source.slice(node.start, node.end);
    if (!slice.includes("shouldIncludeBrowserUsePeerAuthorization")) return;

    walk(node, (inner) => {
      if (inner.type !== "IfStatement") return;
      const cons = inner.consequent;
      const ret =
        cons?.type === "ReturnStatement"
          ? cons
          : cons?.type === "BlockStatement" && cons.body.length === 1 && cons.body[0].type === "ReturnStatement"
            ? cons.body[0]
            : null;
      if (!ret?.argument || ret.argument.type !== "ArrowFunctionExpression") return;
      const body = ret.argument.body;
      if (!body || body.type !== "ObjectExpression") return;
      const props = body.properties;
      const authProp = props?.find((p) => getKeyName(p.key) === "authorized");
      const reasonProp = props?.find((p) => getKeyName(p.key) === "reason");
      if (!authProp || reasonProp) return;
      const authVal = source.slice(authProp.value.start, authProp.value.end).trim();
      if (authVal !== "!0" && authVal !== "true") return;

      const test = inner.test;
      const testSrc = source.slice(test.start, test.end).trim();
      if (testSrc.includes("platform")) return;
      if (testSrc === "!0" || testSrc === "true") {
        already++;
        return;
      }
      patches.push({
        id: "peer_auth_bypass",
        start: test.start,
        end: test.end,
        replacement: "!0",
        original: testSrc,
      });
    });
  });

  // Part C2: Force BuildFlavor.shouldIncludeBrowserUsePeerAuthorization helper to !1
  walk(ast, (node) => {
    if (node.type !== "Property" && node.type !== "MethodDefinition") return;
    if (node.kind === "get" || node.kind === "set") return;
    if (getKeyName(node.key) !== "shouldIncludeBrowserUsePeerAuthorization") return;
    const fn = node.value;
    if (!isFunctionNode(fn)) return;

    if (fn.type === "ArrowFunctionExpression" && fn.body.type !== "BlockStatement") {
      const bodySrc = source.slice(fn.body.start, fn.body.end).trim();
      if (bodySrc === "!1" || bodySrc === "false") {
        already++;
        return;
      }
      patches.push({
        id: "peer_auth_flavor_disable",
        start: fn.body.start,
        end: fn.body.end,
        replacement: "!1",
        original: bodySrc,
      });
      return;
    }

    if (fn.body?.type === "BlockStatement" && fn.body.body.length === 1 && fn.body.body[0].type === "ReturnStatement") {
      const arg = fn.body.body[0].argument;
      if (!arg) return;
      const argSrc = source.slice(arg.start, arg.end).trim();
      if (argSrc === "!1" || argSrc === "false") {
        already++;
        return;
      }
      patches.push({
        id: "peer_auth_flavor_disable",
        start: arg.start,
        end: arg.end,
        replacement: "!1",
        original: argSrc,
      });
    }
  });

  return { patches, already };
}

function dedupePatches(patches) {
  const seen = new Set();
  const out = [];
  for (const p of patches) {
    const key = `${p.start}:${p.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  out.sort((a, b) => b.start - a.start);
  for (let i = 1; i < out.length; i++) {
    if (out[i].end > out[i - 1].start) {
      throw new Error(
        `Overlapping AST patches: [${out[i].id} ${out[i].start}..${out[i].end}] vs [${out[i - 1].id} ${out[i - 1].start}..${out[i - 1].end}]`,
      );
    }
  }
  return out;
}

// ── Target location ──

function resolvePlatforms(platform) {
  const candidates =
    platform === "unix"
      ? ["mac-arm64", "mac-x64"]
      : platform
        ? [platform]
        : ["mac-arm64", "mac-x64", "win"];

  if (platform && platform !== "unix") return candidates;
  return candidates.filter((p) =>
    fs.existsSync(path.join(SRC_DIR, p, "_asar")),
  );
}

function locatePlatformTargets(plat) {
  const targets = [];
  const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
  const buildDir = path.join(SRC_DIR, plat, "_asar", ".vite", "build");

  if (fs.existsSync(assetsDir)) {
    for (const fp of listJavaScriptFiles(assetsDir)) {
      const src = fs.readFileSync(fp, "utf-8");
      const rules = new Set();

      if (FEATURE_NAME_RE.test(src)) {
        rules.add("avail");
        rules.add("gate");
      }

      if (
        src.includes("goalSlashCommand") &&
        /["'`]goals["'`]/.test(src) &&
        /["'`]cloud["'`]/.test(src)
      ) {
        rules.add("goal");
      }

      // Legacy Vite standalone gradient/plugin-auth helper chunk (< 5 KB top-level file)
      if (
        path.dirname(fp) === assetsDir &&
        src.length < 5000 &&
        src.includes("chatgpt") &&
        src.includes("!==")
      ) {
        rules.add("auth");
      }

      if (rules.size > 0) {
        targets.push({
          platform: plat,
          area: "assets",
          path: fp,
          source: src,
          rules: [...rules],
        });
      }
    }
  }

  if (fs.existsSync(buildDir)) {
    for (const f of fs.readdirSync(buildDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(buildDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if (
        src.includes("externalBrowserUseAllowed") ||
        src.includes("features.js_repl") ||
        src.includes("shouldIncludeBrowserUsePeerAuthorization")
      ) {
        targets.push({
          platform: plat,
          area: "build",
          path: fp,
          source: src,
          rules: ["features"],
        });
      }
    }
  }

  return {
    hasAssetsDir: fs.existsSync(assetsDir),
    hasBuildDir: fs.existsSync(buildDir),
    targets,
  };
}

// ── Main ──

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win", "unix"].includes(a));

  const platforms = resolvePlatforms(platform);
  if (platforms.length === 0) {
    console.error("  [x] No target platform directories found");
    process.exit(1);
  }

  let failed = 0;
  const pendingWrites = [];

  for (const plat of platforms) {
    const { hasAssetsDir, hasBuildDir, targets } = locatePlatformTargets(plat);
    if (!hasAssetsDir && !hasBuildDir) {
      console.error(`  [x] [${plat}] Missing _asar/webview/assets and _asar/.vite/build`);
      failed++;
      continue;
    }

    let assetsMatched = 0;
    let buildMatched = 0;

    for (const bundle of targets) {
      const source = bundle.source;
      const t0 = Date.now();
      const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
      const parseMs = Date.now() - t0;

      const rawPatches = [];
      let fileAlready = source.includes(MARKER) ? 1 : 0;

      for (const rule of bundle.rules) {
        const res =
          rule === "auth"
            ? findPluginAuthPatches(ast, source)
            : rule === "avail"
              ? findBrowserAvailPatches(ast, source)
              : rule === "gate"
                ? findStatsigGatePatches(ast, source)
                : rule === "features"
                  ? findFeatureDefaultPatches(ast, source)
                  : findGoalGatePatches(ast, source);
        rawPatches.push(...res.patches);
        fileAlready += res.already;
      }

      const patches = dedupePatches(rawPatches);

      if (patches.length === 0 && fileAlready === 0) {
        // Build chunks may only reference a helper call site (e.g. calling
        // shouldIncludeBrowserUsePeerAuthorization without defining or gating it).
        if (bundle.area === "assets") {
          console.error(
            `\n-- [${bundle.platform}] ${relPath(bundle.path)}\n   [x] Matched feature pre-filter (${bundle.rules.join(",")}) but 0 AST gates matched`,
          );
          failed++;
        }
        continue;
      }

      if (bundle.area === "assets") assetsMatched += patches.length + fileAlready;
      else buildMatched += patches.length + fileAlready;

      console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
      console.log(`   size: ${(source.length / 1024).toFixed(1)} KB, parse: ${parseMs}ms`);

      if (patches.length === 0) {
        console.log("   [ok] Already patched");
        continue;
      }

      if (isCheck) {
        for (const p of [...patches].reverse()) {
          console.log(`   [?] [${p.id}] offset ${p.start}: ${p.original} -> ${p.replacement}`);
        }
        continue;
      }

      let code = source;
      for (const p of patches) {
        console.log(`   * [${p.id}] offset ${p.start}: ${p.original} -> ${p.replacement}`);
        code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
      }
      if (!code.includes(MARKER)) {
        code = `${MARKER}\n${code}`;
      }

      parse(code, { ecmaVersion: "latest", sourceType: "module" });
      pendingWrites.push({ path: bundle.path, code, count: patches.length });
    }

    if (hasAssetsDir && assetsMatched === 0) {
      console.error(`  [x] [${plat}] No renderer browser-use/computer-use availability gates matched`);
      failed++;
    }
    if (hasBuildDir && buildMatched === 0) {
      console.error(`  [x] [${plat}] No main-process desktop feature / peer-auth gates matched`);
      failed++;
    }
  }

  if (failed > 0) process.exit(1);

  for (const write of pendingWrites) {
    const tmpPath = `${write.path}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, write.code, "utf-8");
    fs.renameSync(tmpPath, write.path);
    console.log(`   [ok] ${relPath(write.path)}: ${write.count} gate(s) patched`);
  }
}

if (require.main === module) main();

module.exports = {
  MARKER,
  findBrowserAvailPatches,
  findFeatureDefaultPatches,
  findGoalGatePatches,
  findPluginAuthPatches,
  findStatsigGatePatches,
};
