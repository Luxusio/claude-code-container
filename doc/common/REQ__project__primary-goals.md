---
type: REQ
status: active
created: 2026-04-01
source: README.md, package.json, CLAUDE.md
---

# Primary Goals

Run Claude Code in isolated containers with:

1. **Per-project isolation** — containers named by path hash, each project gets its own environment
2. **Runtime-agnostic container execution** — works with Docker or Podman; auto-detect with Podman preferred, override via `--runtime` / `CCC_RUNTIME`. First-class support for rootless Podman on Linux and podman machine on macOS/Windows (added 2026-04-17)
3. **Host environment forwarding** — auto-forward env vars, SSH agent, locale, timezone
4. **Session lifecycle management** — lock files track sessions, auto-stop container when last session exits
5. **Tool version management** — mise-based per-project tool versions
6. **Browser testing** — Chromium included for headless testing
7. **Network transparency** — `--network host` for direct port access, localhost proxy for Docker Desktop / podman machine
