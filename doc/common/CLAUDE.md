# doc/common — note index
updated: 2026-04-17

## Notes

- [OBS: Workspace Layout](OBS__repo__workspace-layout.md) — detected project structure, languages, tooling (refreshed for container-runtime module + Containerfile)
- [REQ: Primary Goals](REQ__project__primary-goals.md) — project goals (runtime-agnostic execution added 2026-04-17)
- [INF: Initial Assumptions](INF__arch__initial-assumptions.md) — inferred architecture assumptions (Podman runtime abstraction)
- [OBS: Windows Rust .exe Suffix](OBS__install__windows-rust-exe-suffix.md) — Rust always emits .exe on win32; Tauri externalBin stays extensionless; use sidecarBinPaths helper
- [OBS: npm/cli#4828 Optional Deps](OBS__install__npm-optional-deps-4828.md) — npm skips platform-specific optional deps (lockfile, omit, and .npmrc os= variants); mitigations: cleanUiDepsForFreshInstall + ensureTauriCliPlatformBinding helpers + --include=optional + --os/--cpu CLI flags
- [OBS: Tauri Windows icon.ico](OBS__install__tauri-windows-icon-ico.md) — tauri-build requires icons/icon.ico for Windows Resource generation; use scripts/generate-tauri-ico.mjs to wrap icon.png in a valid ICO container
- [OBS: Node 22 spawn(.cmd) silent fail](OBS__install__ccc-ui-spawn-dotcmd-node22.md) — Node 22 CVE-2024-27980 mitigation rejects spawning .cmd shims without shell: true; combined with `result.status ?? 0` the caller exits silently; fix: split spawnPath from binPath and surface result.error with `?? 1` fallback
