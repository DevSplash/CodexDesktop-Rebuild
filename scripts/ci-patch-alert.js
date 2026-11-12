#!/usr/bin/env node
/**
 * ci-patch-alert.js — Sync patch preflight status to a single deduplicated GitHub Issue
 *
 * - Opens or updates a single `[Patch Alert]` issue when any required or optional
 *   patch fails against a new upstream release (no daily duplicate spam).
 * - Automatically closes any open `[Patch Alert]` issue once all patches pass again.
 * - Non-fatal if GITHUB_TOKEN lacks issue permissions (e.g., restricted forks).
 *
 * Usage:
 *   node scripts/ci-patch-alert.js patch-report.json
 */
const fs = require("fs");
const path = require("path");

const ALERT_PREFIX = "[Patch Alert]";

function buildAlertMarkdown(report, runUrl) {
  const ver = report.upstream?.version || "unknown";
  const build = report.upstream?.build ? ` (build \`${report.upstream.build}\`)` : "";
  const isBlocked = report.requiredFailed.length > 0;

  const lines = [
    `## ${isBlocked ? "❌ Build Blocked by Required Patch Failure" : "⚠️ Release Built in Degraded Mode (Optional Patch Skipped)"}`,
    "",
    `- **Upstream Version**: \`${ver}\`${build}`,
    runUrl ? `- **Workflow Run**: ${runUrl}` : null,
    `- **Timestamp**: \`${report.timestamp}\``,
    report.requiredFailed.length > 0
      ? `- **Required Failed (blocking)**: ${report.requiredFailed.map((n) => `\`${n}\``).join(", ")}`
      : null,
    report.optionalFailed.length > 0
      ? `- **Optional Degraded (skipped)**: ${report.optionalFailed.map((n) => `\`${n}\``).join(", ")}`
      : null,
    "",
    "### Patch Details",
    "",
  ].filter((l) => l !== null);

  for (const r of report.results.filter((x) => x.status !== "ok")) {
    lines.push(
      `<details open>`,
      `<summary><strong>${r.name}</strong> (<code>${r.tier}</code>, exit ${r.exitCode}) — ${r.description || ""}</summary>`,
      "",
      "```text",
      (r.output || "(no output)").trim(),
      "```",
      "</details>",
      "",
    );
  }

  return lines.join("\n");
}

async function githubRequest(apiBase, token, method, endpoint, body = undefined) {
  const res = await fetch(`${apiBase}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "CodexDesktop-Rebuild-Preflight",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${method} ${endpoint} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function syncPatchAlert(report) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.log("  [alert] Skipping GitHub Issue sync (GITHUB_TOKEN or GITHUB_REPOSITORY unset)");
    return;
  }

  const apiBase = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const serverUrl = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${serverUrl}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;

  const openIssues = await githubRequest(
    apiBase,
    token,
    "GET",
    `/repos/${repo}/issues?state=open&per_page=50`,
  );
  const existing = (Array.isArray(openIssues) ? openIssues : []).find(
    (it) => !it.pull_request && typeof it.title === "string" && it.title.startsWith(ALERT_PREFIX),
  );

  const ver = report.upstream?.version || "latest";

  if (report.strictOk) {
    if (existing) {
      await githubRequest(
        apiBase,
        token,
        "POST",
        `/repos/${repo}/issues/${existing.number}/comments`,
        {
          body: `✅ All patches succeeded against upstream \`${ver}\`${runUrl ? ` (${runUrl})` : ""}. Closing alert.`,
        },
      );
      await githubRequest(apiBase, token, "PATCH", `/repos/${repo}/issues/${existing.number}`, {
        state: "closed",
      });
      console.log(`  [alert] Closed resolved issue #${existing.number}`);
    }
    return;
  }

  const summaryTag =
    report.requiredFailed.length > 0
      ? `blocked (${report.requiredFailed.join(", ")})`
      : `degraded (${report.optionalFailed.join(", ")})`;
  const title = `${ALERT_PREFIX} Upstream ${ver}: ${summaryTag}`;
  const body = buildAlertMarkdown(report, runUrl);

  if (existing) {
    await githubRequest(apiBase, token, "PATCH", `/repos/${repo}/issues/${existing.number}`, {
      title,
      body,
    });
    console.log(`  [alert] Updated open issue #${existing.number}: ${title}`);
  } else {
    const created = await githubRequest(apiBase, token, "POST", `/repos/${repo}/issues`, {
      title,
      body,
    });
    console.log(`  [alert] Opened issue #${created.number}: ${title}`);
  }
}

async function main() {
  const reportFile = process.argv[2];
  if (!reportFile || !fs.existsSync(reportFile)) {
    console.error("Usage: node scripts/ci-patch-alert.js <patch-report.json>");
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(path.resolve(reportFile), "utf8"));
  try {
    await syncPatchAlert(report);
  } catch (err) {
    console.warn(`  [alert] Non-fatal GitHub Issue sync warning: ${err.message}`);
  }
}

if (require.main === module) main();

module.exports = { ALERT_PREFIX, buildAlertMarkdown, syncPatchAlert };
