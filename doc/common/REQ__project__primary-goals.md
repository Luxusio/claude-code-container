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
8. **Tool credential availability** — every local container mounts all registered coding-tool credential directories regardless of the command or tool that starts it
9. **Recoverable Codex config access** — before host-side MCP generation and after command exit, probe `~/.ccc/codex/config.toml` for host read/write access. Healthy or absent files require no ownership change. On EACCES/EPERM, automatically repair only a regular config file in a real directory owned by the invoking host user, using the mounted parent's ownership reference to respect container user namespaces. Preserve config contents, the file group and existing group permissions; reject symlinks and avoid recursive credential changes. Verify host access after repair. Failed or unsafe repair warns; unresolved MCP access remains an actionable error, while post-command warnings preserve cleanup and the command exit status. This conditional handoff does not guarantee simultaneous access by different host/container UIDs.
10. **Independent coding-tool installation** — install missing npm tools in separate sequential transactions and create wrappers only for successful installations. Optional package failures (including OpenCode platform errors) must not prevent a usable Codex installation. A failed readiness probe, requested-tool installation, or requested-tool wrapper must surface its cause before launch and clean up the session. Reused containers must check and repair the requested npm tool without reinstalling unrelated tools. `ccc codex login` retains its existing argument behavior.

11. **Writable Codex authentication storage** — at Codex session startup, verify that its container user can read, write and traverse the mounted credential directory as well as access the config. For an inaccessible real directory owned by the invoking host user with ordinary Unix permissions, grant only the actual container user a named-user access ACL on that directory. During the directory ACL grant, preserve directory ownership, existing group/other effective access, and child contents/permissions; do not apply recursive or default ACL changes. Leave healthy directories unchanged and decline unsafe paths or complex existing ACLs. Include the ACL utilities in images and provision them on demand in older containers. Any preparation or verification failure must stop before launching Codex, preserve the cause, and clean the session and temporary environment file. A successful login must be able to save authentication state when host and container UIDs differ.

Verification: permission regression tests exercise actual EACCES on a temporary config where Unix permissions apply, recovery before MCP merging, and preservation of user settings. Installer and startup tests cover optional failures, active failures, directory access, safe ACL repair, rejected repair, cleanup, and cold/warm recovery. Real Docker tests use disposable credentials and a synthetic API key to verify authentication storage without an external account login. Mocked runtime evidence alone does not establish WSL2 Docker Desktop integration; actual container checks require a reachable runtime.
