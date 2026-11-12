# Codex Desktop Rebuild

Cross-platform Electron build for OpenAI Codex Desktop App.

## Supported Platforms

| Platform | Architecture | Status |
|----------|--------------|--------|
| macOS    | x64, arm64   | ✅     |
| Windows  | x64          | ✅     |
| Linux    | x64, arm64   | ✅     |

## Build

```bash
# Install dependencies
npm install

# Preflight-verify all patches against latest upstream ASAR via HTTP Range
npm run preflight

# Build for current platform
npm run build

# Build for specific platform
npm run build:mac-x64
npm run build:mac-arm64
npm run build:win-x64
npm run build:linux-x64
npm run build:linux-arm64

# Build all platforms
npm run build:all
```

macOS and Windows builds preserve the complete native resource set bundled by
the official desktop package. Linux has no official desktop package, so its
build detects the Codex version embedded in the matching macOS bundle, downloads
that exact [openai/codex release](https://github.com/openai/codex/releases),
verifies the official SHA-256 manifest, and installs its Linux resource set.
`OPENAI_CODEX_RELEASE_TAG=rust-vX.Y.Z` is accepted only when it exactly matches
the bundled desktop binary. Linux packages include
`resources/codex-release.json` with the source asset and digest.

Linux builds use `GITHUB_TOKEN` (or `GH_TOKEN`) for GitHub Release metadata when
available; both Actions workflows provide a read-only token to the Linux build
step. Public asset URLs and SHA-256 verification are unchanged. The RPM maker
also adjusts its staging copy path for RPM 4.20+ and 6.x working directories.

The custom-provider quota patch prevents the native OpenAI account's exhausted
5-hour or weekly allowance from disabling submission to a custom model provider
with an explicit non-ChatGPT `base_url`, including providers with
`requires_openai_auth = true`. It uses the saved thread's provider first and the
resolved host/workspace config for new threads. Missing, invalid or ChatGPT base
URLs and pending configuration retain native quota checks; other send-button
restrictions remain in place. The patch runs on Windows and macOS sources, which
also supply the Linux frontend. It supports both the older Vite layout and the
Rspack async-module layout, including every emitted copy of the composer module.

Fast-mode controls follow upstream authentication, model service-tier capabilities,
and workspace requirements. The obsolete `fast_mode` authentication-comparison
patch and `archive-delete` patch (now implemented natively upstream) have been
removed; API-key login does not inherit ChatGPT Fast-mode access.

## Patch Architecture & Upstream Resilience

`scripts/patch-all.js` separates patches into two tiers so minor upstream UI
refactors do not block releases while core safety invariants remain enforced:

- **Required** (`patch-proxy-config`, `patch-windows-portable-core`, `patch-updater`, `patch-provider-quota`): must succeed or the build fails.
- **Optional** (`patch-i18n`, `patch-copyright`, `patch-devtools`, `patch-plugin-auth`, `patch-luna-reserve`): validated atomically per script (syntax-checked with Acorn before writing); if an upstream refactor breaks an optional patch, it skips cleanly without partial writes unless `--strict` is passed.

In CI (`sync.yml`), `scripts/preflight-patch.js` uses HTTP Range requests to
fetch only `Contents/Resources/app.asar` from the upstream archive before
launching the multi-platform build matrix, records a summary table in
`$GITHUB_STEP_SUMMARY`, and maintains a single deduplicated `[Patch Alert]`
GitHub Issue when any patch needs attention.

## Development

```bash
npm run dev
```

## Project Structure

```
├── src/
│   ├── .vite/build/     # Main process (Electron)
│   └── webview/         # Renderer (Frontend)
├── resources/
│   ├── electron.icns    # App icon
│   └── notification.wav # Sound
├── scripts/
│   ├── patch-all.js
│   └── preflight-patch.js
├── forge.config.js      # Electron Forge config
└── package.json
```

## CI/CD

GitHub Actions automatically checks upstream daily (`sync.yml`):
- Compares upstream versions against `package.json` (`--compare-package`)
- Runs Range-ASAR preflight patch check before triggering macOS, Windows, and Linux builds
- Creates draft release with `v*` tag

## Credits

**© OpenAI · Cometix Space**

- [OpenAI Codex](https://github.com/openai/codex) - Original Codex CLI (Apache-2.0)
- [Cometix Space](https://github.com/Haleclipse) - Cross-platform rebuild
- [Electron Forge](https://www.electronforge.io/) - Build toolchain

## License

This project rebuilds the Codex Desktop app for cross-platform distribution.
Original Codex CLI by OpenAI is licensed under Apache-2.0.
