---
type: REQ
status: active
created: 2026-04-01
source: README.md, package.json, CLAUDE.md
---

# Primary Goals

Run Claude Code in isolated Docker containers with:

1. **Per-project isolation** — containers named by path hash, each project gets its own environment
2. **Host environment forwarding** — auto-forward env vars, SSH agent, locale, timezone
3. **Session lifecycle management** — lock files track sessions, auto-stop container when last session exits
4. **Tool version management** — mise-based per-project tool versions
5. **Browser testing** — Chromium included for headless testing
6. **Network transparency** — `--network host` for direct port access, localhost proxy for Docker Desktop
