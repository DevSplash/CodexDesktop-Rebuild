#!/usr/bin/env node
/**
 * Disable MSIX app-contained-core mode for the portable Windows build.
 *
 * Electron reports extracted apps as packaged, but they do not have a Windows
 * package identity. Leaving this upstream flag enabled makes startup call the
 * MSIX-only getCurrentPackageFamily API and abort with APPMODEL_ERROR_NO_PACKAGE.
 */
const fs = require("fs");
const path = require("path");

const { SRC_DIR, relPath } = require("./patch-util");

const CONTAINED_CORE_FLAG = "codexWindowsAppContainedCore";

function patchMetadata(metadata) {
  if (!Object.prototype.hasOwnProperty.call(metadata, CONTAINED_CORE_FLAG)) {
    return { status: "not-needed", metadata };
  }
  if (metadata[CONTAINED_CORE_FLAG] === "0") {
    return { status: "already", metadata };
  }

  return {
    status: "patched",
    metadata: { ...metadata, [CONTAINED_CORE_FLAG]: "0" },
    original: metadata[CONTAINED_CORE_FLAG],
  };
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) =>
    ["mac-arm64", "mac-x64", "win", "unix"].includes(arg),
  );
  const isCheck = args.includes("--check");

  if (platform && platform !== "win") {
    console.log("  [ok] Windows portable-core patch not applicable");
    return;
  }

  const packagePath = path.join(SRC_DIR, "win", "_asar", "package.json");
  if (!fs.existsSync(packagePath)) {
    console.log("  [ok] Windows package metadata not found");
    return;
  }

  const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const result = patchMetadata(metadata);

  if (result.status === "not-needed") {
    console.log(`  [ok] ${relPath(packagePath)}: contained-core flag not present`);
    return;
  }
  if (result.status === "already") {
    console.log(`  [ok] ${relPath(packagePath)}: portable core mode already set`);
    return;
  }
  if (isCheck) {
    console.log(
      `  [?] ${relPath(packagePath)}: would set ${CONTAINED_CORE_FLAG} to \"0\"`,
    );
    return;
  }

  fs.writeFileSync(packagePath, `${JSON.stringify(result.metadata, null, 2)}\n`);
  console.log(
    `  [ok] ${relPath(packagePath)}: ${CONTAINED_CORE_FLAG} ${JSON.stringify(result.original)} -> \"0\"`,
  );
}

if (require.main === module) main();

module.exports = { CONTAINED_CORE_FLAG, patchMetadata };
