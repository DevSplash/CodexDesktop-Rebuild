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

The custom-provider quota patch prevents the native OpenAI account's exhausted
5-hour or weekly allowance from disabling submission to a custom model provider
with an explicit non-ChatGPT `base_url`, including providers with
`requires_openai_auth = true`. It uses the saved thread's provider first and the
resolved host/workspace config for new threads. Missing, invalid or ChatGPT base
URLs and pending configuration retain native quota checks; other send-button
restrictions remain in place. The patch runs on Windows and macOS sources, which
also supply the Linux frontend.

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
│   └── patch-copyright.js
├── forge.config.js      # Electron Forge config
└── package.json
```

## CI/CD

GitHub Actions automatically builds on:
- Push to `master`
- Tag `v*` → Creates draft release

## Credits

**© OpenAI · Cometix Space**

- [OpenAI Codex](https://github.com/openai/codex) - Original Codex CLI (Apache-2.0)
- [Cometix Space](https://github.com/Haleclipse) - Cross-platform rebuild
- [Electron Forge](https://www.electronforge.io/) - Build toolchain

## License

This project rebuilds the Codex Desktop app for cross-platform distribution.
Original Codex CLI by OpenAI is licensed under Apache-2.0.
