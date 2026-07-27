const fs = require("fs");

const MACHO_MAGICS = new Set([
  0xfeedface, 0xcefaedfe,
  0xfeedfacf, 0xcffaedfe,
]);

function classifyExecutableHeader(header) {
  if (!Buffer.isBuffer(header) || header.length < 4) return null;

  const magic = header.readUInt32BE(0);
  if (MACHO_MAGICS.has(magic)) return { format: "macho" };

  // Mach-O universal binaries and Java class files share CAFEBABE. A universal
  // binary follows it with a small architecture count; a class file follows it
  // with minor/major bytecode versions.
  if (
    header.length >= 8
    && (magic === 0xcafebabe || magic === 0xcafebabf)
    && header.readUInt32BE(4) > 0
    && header.readUInt32BE(4) <= 32
  ) {
    return { format: "macho" };
  }
  if (
    header.length >= 8
    && (magic === 0xbebafeca || magic === 0xbfbafeca)
    && header.readUInt32LE(4) > 0
    && header.readUInt32LE(4) <= 32
  ) {
    return { format: "macho" };
  }

  if (header[0] === 0x4d && header[1] === 0x5a) {
    return { format: "pe" };
  }

  if (
    header.length >= 20
    && header[0] === 0x7f
    && header[1] === 0x45
    && header[2] === 0x4c
    && header[3] === 0x46
  ) {
    const machine = header[5] === 2
      ? header.readUInt16BE(18)
      : header.readUInt16LE(18);
    return { format: "elf", machine };
  }
  return null;
}

function readExecutableType(filePath) {
  const header = Buffer.alloc(20);
  const fd = fs.openSync(filePath, "r");
  let bytesRead;
  try {
    bytesRead = fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return classifyExecutableHeader(header.subarray(0, bytesRead));
}

function isForeignLinuxBinary(filePath, arch) {
  const executable = readExecutableType(filePath);
  if (!executable) return false;
  if (executable.format === "macho" || executable.format === "pe") return true;
  if (executable.format !== "elf") return false;

  const expectedMachine = arch === "x64" ? 62 : arch === "arm64" ? 183 : null;
  if (expectedMachine === null) {
    throw new Error(`Unsupported Linux architecture: ${arch}`);
  }
  return executable.machine !== expectedMachine;
}

function isMacBundleDirectory(name) {
  return name.endsWith(".app")
    || name.endsWith(".framework")
    || name.endsWith(".dSYM")
    || name === "__MACOSX";
}

module.exports = {
  classifyExecutableHeader,
  isForeignLinuxBinary,
  isMacBundleDirectory,
  readExecutableType,
};
