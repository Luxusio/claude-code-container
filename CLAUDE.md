# CLAUDE.md

@CONTRACTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**claude-code-container** (ccc) is a CLI tool that runs Claude Code in an isolated Docker container. It provides:

- Per-project isolated containers (path-hash based naming)
- Host environment variables auto-forwarding
- Session-based auto-cleanup (stops container when last session exits)
- mise-based tool version management per project
- Chromium included for headless testing
- `--network host` for direct port access

## Architecture

```
~/.ccc/
├── claude/             # Claude credentials (mounted to /claude)
└── locks/              # Session lock files (per session)
    ├── my-project-a1b2c3d4e5f6-uuid1.lock
    └── my-project-a1b2c3d4e5f6-uuid2.lock

Docker Volume:
└── ccc-mise-cache      # Shared mise cache (named volume for macOS/Windows performance)

Container (ccc-<project>-<hash>):
├── /project/<project>-<hash>  # Mounted from actual project path
├── /claude                     # Mounted from ~/.ccc/claude
├── /home/ccc/.ssh              # Mounted from ~/.ssh (read-only)
├── /tmp/ssh-agent.sock         # SSH agent socket (auto-detected per platform)
└── /home/ccc/.local/share/mise # Named volume (ccc-mise-cache)
```

## Session Lifecycle

1. **Start**: `ccc` creates/starts container + creates session lock file
2. **Running**: Multiple sessions can run for same project (different lock files)
3. **Exit**: Lock file deleted, container stopped if no other sessions remain
4. **Crash recovery**: Next `ccc` run cleans up stale lock files

Container name is fixed per project path hash, ensuring `claude --continue` and `--resume` work correctly.

## Technology Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript (ES2022 target)
- **Container**: Docker (per-project containers)
- **Base Image**: ubuntu:24.04

## Project Structure

```
claude-code-container/
├── src/
│   ├── index.ts               # Main CLI entry point
│   ├── docker.ts              # Docker container lifecycle management
│   ├── session.ts             # Session lock file management
│   ├── scanner.ts             # Project tool detection for mise
│   ├── container-setup.ts     # Claude binary installation in container
│   ├── localhost-proxy.ts     # Transparent localhost proxy (macOS/Windows)
│   ├── localhost-proxy-setup.ts # Proxy + iptables setup in container
│   ├── clipboard-server.ts    # Host clipboard bridge
│   ├── mcp-forward.ts         # MCP server forwarding
│   ├── worktree.ts            # Git worktree workspace management
│   ├── remote.ts              # Remote development helpers (Tailscale + Mutagen)
│   └── utils.ts               # Shared utilities
├── scripts/
│   └── install.js             # Cross-platform global installer
├── dist/                      # Compiled output
├── Dockerfile                 # Container image definition
├── package.json
├── tsconfig.json
└── README.md
```

## Build Commands

```bash
npm install              # Install dependencies
npm run build            # Compile TypeScript
npm test                 # Run tests (vitest)
npm run test:watch       # Run tests in watch mode
npm run install:global   # Install globally (sudo on macOS/Linux)
npm run uninstall:global # Uninstall globally (sudo on macOS/Linux)
```

## CLI Commands

### Container Management
- `ccc stop` - Stop current project's container
- `ccc rm` - Remove current project's container
- `ccc status` - Show all containers status

### Execution
- `ccc` - Run Claude in current project
- `ccc shell` - Open bash shell in current project
- `ccc <command>` - Run arbitrary command in current project
- `ccc --env KEY=VALUE` - Set additional environment variable for session

### Remote Development
- `ccc remote <host>` - Connect to remote host (first time saves config)
- `ccc remote` - Connect using saved config
- `ccc remote setup` - Setup guide
- `ccc remote check` - Check connectivity and sync status
- `ccc remote terminate` - Stop sync session

## Key Concepts

### Project Containers

Each project gets its own container named `ccc-<project>-<path-hash>`:
1. Container created on first `ccc` run
2. Lock file created per session for tracking
3. On exit: lock removed, container stopped if no other sessions active

### Environment Variables

**Auto-forwarded from host**: All host env vars except system ones (PATH, HOME, USER, SHELL, etc.)

**Locale/Timezone**: `LANG`, `LC_ALL`, `LC_CTYPE` forwarded from host (common locales pre-generated in image). `TZ` auto-detected via `Intl.DateTimeFormat`. Defaults: `LANG=en_US.UTF-8`, `TZ=UTC`.

**Per-session**: `ccc --env KEY=VALUE`

**Container marker**: `container=docker` is auto-set inside the container (systemd convention). Use in mise.toml `[env]` for per-project container/desktop env separation.

### mise Integration

- Projects use `mise.toml` for tool version management
- On first `ccc` run, prompts to auto-detect and create `mise.toml`
- `mise install` runs automatically before `claude` command
- mise cache stored in Docker named volume (`ccc-mise-cache`) for better macOS/Windows performance

### Container Image

Built from Dockerfile on first run. Includes:
- Base: `ubuntu:24.04`
- Dependencies: curl, git, ca-certificates, unzip
- Chromium browser (`CHROME_BIN` env set)
- Docker CLI (communicates with host Docker daemon via socket mount)
- locales + tzdata (pre-generated: en_US, ko_KR, ja_JP, zh_CN, de_DE, fr_FR, es_ES, pt_BR)
- iptables (for transparent localhost proxy on macOS/Windows)
- mise with global tools: maven, gradle, yarn, pnpm
- claude-code native binary
- `.bashrc` configured for mise activation

### Resource Limits

- **Memory/CPU**: No limits (shares host resources)
- **PIDs**: Unlimited (same as host)

### Signal Handling

- SIGINT (Ctrl+C), SIGTERM, SIGHUP: cleanup session and exit
- Normal exit: cleanup session
- Container stopped only when no other sessions remain

### Remote Development

Run ccc on a remote desktop from your MacBook:
- **Mutagen**: Direct sync to Docker container (no filesystem middleman)
- **SSH**: Start container, run docker exec claude
- Config saved per-project in `~/.ccc/remote/`
- Use `ccc remote <host>` for first-time setup
- Better performance on Windows/macOS (bypasses slow volume mounts)

## Code Guidelines

- Keep the CLI simple and minimal
- Per-project container approach with path-hash naming
- Lock files for session tracking and crash recovery
- Auto-forward host environment variables
- Auto-stop container when last session exits

## Operating Mode

- `doc/harness/manifest.yaml` is the initialization marker.
- Every repo-mutating task follows: plan -> critic-plan PASS -> implement -> runtime QA -> writer/DOC_SYNC -> critic-document (when needed) -> close.
- The only hard gate is at task completion: critic verdicts must PASS. Stale PASS (after file changes) does not count.
- DOC_SYNC.md is mandatory for all repo-mutating tasks.
- Work in plain language. The harness routes requests and gates completion.

## Harness routing
<!-- harness:routing-injected -->
- Run the full cycle (plan → develop → verify → close) → `Skill(harness:run)`
- Plan only → `Skill(harness:plan)`
- Implement an approved PLAN.md → `Skill(harness:develop)`
- Bootstrap harness in a new project / repair existing → `Skill(harness:setup)`
- Contract drift / post-upgrade cleanup → `Skill(harness:maintain)`
- Read-only question or explanation → answer directly, no skill
