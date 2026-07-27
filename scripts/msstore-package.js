/**
 * Select the latest Microsoft Store package for a Windows CPU architecture.
 * SyncUpdates does not guarantee result order; ARM64 packages can precede x64.
 */
function selectPackageForArchitecture(packages, architecture = "x64") {
  const target = architecture.toLowerCase();
  const architectureOf = (name) => {
    const match = String(name).match(/_(x64|arm64|x86|neutral)(?=__)/i);
    return match ? match[1].toLowerCase() : "unknown";
  };
  const versionOf = (name) => {
    const match = String(name).match(/OpenAI\.Codex_(\d+(?:\.\d+)+)_/i);
    return match ? match[1].split(".").map(Number) : [];
  };
  const compareVersionsDescending = (a, b) => {
    const aVersion = versionOf(a.name);
    const bVersion = versionOf(b.name);
    const length = Math.max(aVersion.length, bVersion.length);
    for (let i = 0; i < length; i++) {
      const diff = (bVersion[i] || 0) - (aVersion[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };

  const candidates = packages.filter((pkg) => architectureOf(pkg.name) === target);
  if (candidates.length === 0) {
    const available = [...new Set(packages.map((pkg) => architectureOf(pkg.name)))];
    throw new Error(
      `No ${architecture} Codex package found (available architectures: ${available.join(", ") || "none"})`
    );
  }

  return candidates.sort(compareVersionsDescending)[0];
}

module.exports = { selectPackageForArchitecture };
