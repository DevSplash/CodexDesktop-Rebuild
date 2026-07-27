#!/usr/bin/env node
/**
 * Smart development startup script
 * Automatically detects system architecture and sets correct CLI path
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Detect platform and architecture
const platform = process.platform;
const arch = os.arch();

// Map to CLI binary paths
const platformMap = {
  darwin: {
    x64: 'darwin-x64',
    arm64: 'darwin-arm64',
  },
  linux: {
    x64: 'linux-x64',
    arm64: 'linux-arm64',
  },
  win32: {
    x64: 'win32-x64',
  },
};

const binDir = platformMap[platform]?.[arch];
if (!binDir) {
  console.error(`Unsupported platform/arch: ${platform}/${arch}`);
  process.exit(1);
}

const cliName = platform === 'win32' ? 'codex.exe' : 'codex';

// Priority: explicit override > synced platform resources > local resources/bin/
const srcPlatform = platform === 'darwin'
  ? (arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
  : platform === 'linux'
    ? (arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
    : 'win';

const candidates = [
  process.env.CODEX_CLI_PATH,
  // Official CLI copied into the platform resources during preparation.
  path.join(__dirname, '..', 'src', srcPlatform, cliName),
  // Local development fallback.
  path.join(__dirname, '..', 'resources', 'bin', binDir, cliName),
].filter(Boolean);

const cliPath = candidates.find(p => fs.existsSync(p));

// Verify CLI exists
if (!cliPath) {
  console.error('CLI not found in CODEX_CLI_PATH, src platform resources, or resources/bin/');
  process.exit(1);
}

// Resolve app entry: prefer platform-specific _asar/ (has its own package.json)
const appRoot = path.join(__dirname, '..', 'src', srcPlatform, '_asar');
const appEntry = fs.existsSync(appRoot) ? appRoot : path.join(__dirname, '..');

console.log(`[start-dev] Platform: ${platform}, Arch: ${arch}`);
console.log(`[start-dev] CLI Path: ${cliPath}`);
console.log(`[start-dev] App Root: ${appEntry}`);

// Launch Electron with CLI path
const electronBin = require('electron');
const child = spawn(electronBin, [appEntry], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: {
    ...process.env,
    CODEX_CLI_PATH: cliPath,
    BUILD_FLAVOR: process.env.BUILD_FLAVOR || 'dev',
    ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL || 'app://-/index.html',
    CODEX_ELECTRON_RESOURCES_PATH: path.join(__dirname, '..', 'src', srcPlatform),
    CODEX_ELECTRON_BUNDLED_PLUGINS_RESOURCES_PATH: path.join(__dirname, '..', 'src', srcPlatform),
    CODEX_NODE_REPL_PATH: path.join(__dirname, '..', 'src', srcPlatform, 'node_repl'),
    CODEX_BROWSER_USE_NODE_PATH: path.join(__dirname, '..', 'src', srcPlatform, 'node'),
  },
});

child.on('close', (code) => {
  process.exit(code);
});
