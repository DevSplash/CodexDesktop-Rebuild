#!/usr/bin/env node
/**
 * Run all patch scripts in sequence with required vs optional fault isolation.
 *
 * Tiers:
 *   - required: build/runtime correctness & core user workflows; failure aborts build.
 *   - optional: UI enhancements & experimental feature unlocks; failure logs a warning
 *               and skips cleanly unless --strict is passed.
 *
 * Usage:
 *   node scripts/patch-all.js                        # Patch all available platforms
 *   node scripts/patch-all.js mac-arm64              # Patch mac-arm64 only
 *   node scripts/patch-all.js win                    # Patch win only
 *   node scripts/patch-all.js --check                # Dry-run all patches
 *   node scripts/patch-all.js --strict               # Fail on optional patch errors too
 *   node scripts/patch-all.js --report report.json   # Write structured JSON summary
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PATCHES = [
  // Required patches
  {
    script: "patch-proxy-config.js",
    tier: "required",
    description: "App-wide [proxy] config.toml bootstrap",
  },
  {
    script: "patch-windows-portable-core.js",
    tier: "required",
    description: "Disable MSIX contained-core crash on portable Windows",
  },
  {
    script: "patch-updater.js",
    tier: "required",
    description: "Disable upstream Sparkle/Windows/Linux auto-updaters",
  },
  {
    script: "patch-provider-quota.js",
    tier: "required",
    description: "Bypass ChatGPT quota block for custom base_url providers",
  },

  // Optional patches (graceful degradation when upstream refactors UI/gates)
  {
    script: "patch-i18n.js",
    tier: "optional",
    description: "Force-enable i18n regardless of Statsig gate",
  },
  {
    script: "patch-copyright.js",
    tier: "optional",
    description: "Add rebuild attribution in About copyright",
  },
  {
    script: "patch-devtools.js",
    tier: "optional",
    description: "Enable DevTools & Inspect Element in packaged builds",
  },
  {
    script: "patch-plugin-auth.js",
    tier: "optional",
    description: "Unlock browser-use, computer-use & bundled plugins",
  },
  {
    script: "patch-luna-reserve.js",
    tier: "optional",
    description: "Keep ordinary models selectable alongside gpt-reserve",
  },
];

function formatMarkdownSummary(report) {
  const lines = [
    `### Patch ${report.check ? "Preflight" : "Execution"} Summary`,
    "",
    report.upstream?.version
      ? `- **Upstream**: \`${report.upstream.version}\`${report.upstream.build ? ` (build \`${report.upstream.build}\`)` : ""}`
      : null,
    `- **Platform**: \`${report.platform || "all"}\``,
    `- **Result**: ${
      report.requiredFailed.length > 0
        ? `❌ **Blocked** (${report.requiredFailed.length} required patch failed)`
        : report.optionalFailed.length > 0
          ? `⚠️ **Degraded** (${report.optionalFailed.length} optional patch skipped)`
          : "✅ **All patches healthy**"
    }`,
    "",
    "| Patch | Tier | Status | Duration |",
    "|-------|------|--------|----------|",
  ].filter((line) => line !== null);

  for (const r of report.results) {
    const badge =
      r.status === "ok"
        ? "✅ ok"
        : r.tier === "required"
          ? "❌ failed"
          : "⚠️ degraded (skipped)";
    lines.push(`| \`${r.name}\` | \`${r.tier}\` | ${badge} | ${r.durationMs}ms |`);
  }

  return lines.join("\n") + "\n";
}

function parseArgs(argv) {
  let platform = null;
  let isCheck = false;
  let isStrict = false;
  let reportPath = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["mac-arm64", "mac-x64", "win", "unix"].includes(arg)) {
      platform = arg;
    } else if (arg === "--check") {
      isCheck = true;
    } else if (arg === "--strict") {
      isStrict = true;
    } else if (arg === "--report") {
      reportPath = argv[++i] || null;
    } else if (arg.startsWith("--report=")) {
      reportPath = arg.slice("--report=".length) || null;
    }
  }

  return { platform, isCheck, isStrict, reportPath };
}

function runPatches({ platform = null, isCheck = false, isStrict = false, patches = PATCHES } = {}) {
  const passArgs = [...(platform ? [platform] : []), ...(isCheck ? ["--check"] : [])];
  const results = [];
  const requiredFailed = [];
  const optionalFailed = [];
  const inActions = process.env.GITHUB_ACTIONS === "true";

  for (const entry of patches) {
    const scriptPath = path.isAbsolute(entry.script)
      ? entry.script
      : path.join(__dirname, entry.script);
    const label = path.basename(entry.script, ".js");
    console.log(`\n== ${label} [${entry.tier}] ==`);

    const t0 = Date.now();
    const res = spawnSync(process.execPath, [scriptPath, ...passArgs], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    });
    const durationMs = Date.now() - t0;

    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    if (res.error) console.error(`  [x] spawn error: ${res.error.message}`);

    const exitCode = typeof res.status === "number" ? res.status : 1;
    const combinedOutput = `${res.stdout || ""}${res.stderr || ""}${res.error ? res.error.message : ""}`.trim();
    const tailOutput =
      combinedOutput.length > 4000 ? `...${combinedOutput.slice(-4000)}` : combinedOutput;

    if (exitCode === 0) {
      results.push({
        name: label,
        script: entry.script,
        tier: entry.tier,
        description: entry.description,
        status: "ok",
        exitCode: 0,
        durationMs,
        output: tailOutput,
      });
      continue;
    }

    if (entry.tier === "required") {
      requiredFailed.push(label);
      console.error(`[x] REQUIRED patch ${label} failed (exit ${exitCode})`);
      if (inActions) {
        console.log(`::error title=Required patch failed::${label} exited with code ${exitCode}`);
      }
    } else {
      optionalFailed.push(label);
      console.warn(`[!] OPTIONAL patch ${label} failed (exit ${exitCode}) — ${isStrict ? "failing (--strict)" : "skipping cleanly"}`);
      if (inActions) {
        console.log(`::warning title=Optional patch degraded::${label} exited with code ${exitCode} and was skipped`);
      }
    }

    results.push({
      name: label,
      script: entry.script,
      tier: entry.tier,
      description: entry.description,
      status: "failed",
      exitCode,
      durationMs,
      output: tailOutput,
    });
  }

  const succeededCount = results.length - requiredFailed.length - optionalFailed.length;
  console.log(
    `\n== Summary: ${succeededCount}/${results.length} succeeded` +
      (optionalFailed.length > 0 ? `, ${optionalFailed.length} optional degraded (${optionalFailed.join(", ")})` : "") +
      (requiredFailed.length > 0 ? `, ${requiredFailed.length} required failed (${requiredFailed.join(", ")})` : "") +
      " ==",
  );

  const ok = requiredFailed.length === 0 && (!isStrict || optionalFailed.length === 0);
  const strictOk = requiredFailed.length === 0 && optionalFailed.length === 0;

  return {
    timestamp: new Date().toISOString(),
    platform: platform || "all",
    check: isCheck,
    strict: isStrict,
    ok,
    strictOk,
    requiredFailed,
    optionalFailed,
    results,
  };
}

function main() {
  const { platform, isCheck, isStrict, reportPath } = parseArgs(process.argv.slice(2));
  const report = runPatches({ platform, isCheck, isStrict });

  if (reportPath) {
    const absReport = path.resolve(reportPath);
    fs.mkdirSync(path.dirname(absReport), { recursive: true });
    fs.writeFileSync(absReport, JSON.stringify(report, null, 2) + "\n", "utf8");
  }

  if (!report.ok) process.exit(1);
}

if (require.main === module) main();

module.exports = { PATCHES, formatMarkdownSummary, runPatches };
