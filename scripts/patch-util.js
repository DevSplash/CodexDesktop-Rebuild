/**
 * Shared utilities for patch scripts.
 * Provides multi-platform bundle location and common helpers.
 */
const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "src");
const PROJECT_ROOT = path.join(__dirname, "..");

/**
 * Locate bundles matching a filename pattern across platform directories.
 *
 * @param {object} opts
 * @param {"build"|"assets"} opts.dir - Subdirectory type:
 *   "build"  -> src/{plat}/.vite/build/
 *   "assets" -> src/{plat}/webview/assets/
 * @param {RegExp} opts.pattern - Filename regex (e.g. /^index-.*\.js$/)
 * @param {string} [opts.platform] - Restrict to a single platform
 * @param {boolean} [opts.allMatches=false] - Return all matching chunks, not just one per platform
 * @returns {Array<{platform: string, path: string}>}
 */
function locateBundles({ dir, pattern, platform, allMatches = false }) {
  const dirMap = {
    build: (plat) => path.join(SRC_DIR, plat, "_asar", ".vite", "build"),
    assets: (plat) => path.join(SRC_DIR, plat, "_asar", "webview", "assets"),
  };

  // Legacy fallback paths (flat src/ without _asar subdirs)
  const legacyMap = {
    build: path.join(SRC_DIR, ".vite", "build"),
    assets: path.join(SRC_DIR, "webview", "assets"),
  };

  const getDir = dirMap[dir];
  if (!getDir) throw new Error(`Unknown dir type: ${dir}`);

  const ALL_PLATFORMS = ["mac-arm64", "mac-x64", "win"];
  const platforms = platform
    ? [platform]
    : ALL_PLATFORMS.filter((p) => fs.existsSync(getDir(p)));

  // Legacy fallback
  if (platforms.length === 0) {
    const fallback = legacyMap[dir];
    if (fallback && fs.existsSync(fallback)) {
      const files = fs.readdirSync(fallback).filter((f) => pattern.test(f));
      if (files.length > 0) {
        if (allMatches) {
          return files.map(file => ({ platform: "legacy", path: path.join(fallback, file) }));
        }
        // For build dir, prefer hashed file over plain
        const target =
          files.length > 1 ? files.find((f) => f !== "main.js") || files[0] : files[0];
        return [{ platform: "legacy", path: path.join(fallback, target) }];
      }
    }
    return [];
  }

  const results = [];
  for (const plat of platforms) {
    const d = getDir(plat);
    if (!fs.existsSync(d)) continue;

    const files = fs.readdirSync(d).filter((f) => pattern.test(f));
    if (files.length === 0) {
      console.warn(`  [!] ${plat}: no match for ${pattern}`);
      continue;
    }

    if (allMatches) {
      results.push(...files.map(file => ({ platform: plat, path: path.join(d, file) })));
      continue;
    }

    // For build dir with multiple matches, prefer hashed variant
    const target =
      files.length > 1 ? files.find((f) => f !== "main.js") || files[0] : files[0];

    results.push({ platform: plat, path: path.join(d, target) });
  }

  return results;
}

/**
 * Return path relative to project root.
 */
function relPath(absPath) {
  return path.relative(PROJECT_ROOT, absPath);
}

// Rspack places most frontend chunks in assets/async; Vite used a flat directory.
function listJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJavaScriptFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(entryPath);
  }
  return files;
}

module.exports = { locateBundles, relPath, listJavaScriptFiles, SRC_DIR, PROJECT_ROOT };
