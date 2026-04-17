---
type: OBS
status: active
created: 2026-04-01
evidence: repo scan during harness setup
---

# Workspace Layout

## Project
- **Name**: claude-code-container (ccc)
- **Type**: CLI tool
- **License**: MIT
- **Version**: 1.0.3

## Languages & Frameworks
- TypeScript (ES2022 target, NodeNext modules)
- Node.js 22+ runtime
- vitest for testing

## Package Manager
- npm (no lockfile alternatives detected)

## Source Structure
- `src/` — 13+ TypeScript source files (index, container-runtime, docker, session, scanner, container-setup, localhost-proxy, localhost-proxy-setup, clipboard-server, mcp-forward, worktree, remote, doctor, clean, profile, utils)
- `src/container-runtime.ts` — runtime selection (docker | podman), SELinux/rootless/machine quirks (added 2026-04-17)
- `src/__tests__/` — 15+ test files including `container-runtime.test.ts`
- `scripts/` — installer (detects podman/docker), clipboard shims, localhost proxy (Go)
- `Dockerfile` — multi-stage build (chromium, go proxy, ubuntu 24.04)
- `Containerfile` — identical copy of `Dockerfile`; lets `podman build` run without `-f` flag (added 2026-04-17)

## Build & Test
- Build: `npm run build` (tsc + version injection)
- Test: `npm test` (vitest run)
- Lint: `npm run lint` (eslint)

## CI
- `.github/workflows/ci.yml` — CI pipeline
- `.github/workflows/release.yml` — release pipeline
