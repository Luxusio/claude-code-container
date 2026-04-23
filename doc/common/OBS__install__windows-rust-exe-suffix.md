---
type: OBS
status: active
created: 2026-04-10
evidence: TASK__ui-sidecar-windows-exe — build verification + 17 passing unit tests (CRITIC__runtime.md verdict PASS)
---

# Windows Rust Binary .exe Suffix Contract

## Fact

Rust always appends `.exe` to binary outputs on `win32`, regardless of the
`[[bin]] name` entry in `Cargo.toml`. A crate with `name = "ccc-daemon"` produces
`target/release/ccc-daemon.exe` on Windows and `target/release/ccc-daemon` on
Linux/macOS. The build system does not provide a way to suppress the extension.

## Tauri v2 externalBin convention

`tauri.conf.json` `externalBin` entries must use the **extensionless canonical form**
(e.g. `"../src-sidecar/target/release/ccc-daemon"`). Tauri auto-appends both the
platform exe suffix and the target triple at bundle time. Adding `.exe` to
`tauri.conf.json` would break Linux/macOS bundling.

The triple-suffixed sidecar that Tauri expects on disk is:
- Windows: `ccc-daemon-<triple>.exe`
- Linux/macOS: `ccc-daemon-<triple>` (no extension)

## Consequence for install and build scripts

Any script that resolves a Rust binary at the file-system level (e.g. to check
existence or create a symlink/copy) must branch on the platform:

```js
const exeSuffix = platform === "win32" ? ".exe" : "";
const srcBin  = join(releaseDir, `ccc-daemon${exeSuffix}`);
const destBin = join(releaseDir, `ccc-daemon-${triple}${exeSuffix}`);
```

Checking `platform === "win32"` is preferred over `triple.includes("windows")`
because the triple is an optional argument; `process.platform` is always available.

## Canonical helper in this project

`scripts/ui-toolchain.js` — `sidecarBinPaths(releaseDir, triple, platform = process.platform)`
(lines 257-264). Use this function wherever Phase 5 path resolution is needed.
Do not re-inline the suffix logic elsewhere.

## Root cause of TASK__ui-sidecar-windows-exe

`scripts/install.js` Phase 5 previously hardcoded `"ccc-daemon"` (no extension).
On Windows, `existsSync` returned `false` → install threw `"Sidecar binary not found"` →
Phases 6-8 never ran → `ccc ui` was left uninstalled. Fixed by introducing
`sidecarBinPaths` and calling it from Phase 5 (`scripts/install.js:177`).

## Prompted by

Task `TASK__ui-sidecar-windows-exe` (2026-04-10).
Verified: `npm run build` exit 0, 17 unit tests pass (2 files).
Critic runtime verdict: PASS — `doc/harness/tasks/TASK__ui-sidecar-windows-exe/CRITIC__runtime.md`.
