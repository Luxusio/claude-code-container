# CLAUDE.md

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
├── locks/              # Session lock files (per session)
│   ├── my-project-a1b2c3d4e5f6-uuid1.lock
│   └── my-project-a1b2c3d4e5f6-uuid2.lock
└── mise/               # Shared mise cache

Container (ccc-<project>-<hash>):
├── /project/<project>-<hash>  # Mounted from actual project path
├── /claude                     # Mounted from ~/.ccc/claude
└── /home/ccc/.local/share/mise # Mounted mise cache
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
│   ├── index.ts        # Main CLI entry point
│   └── scanner.ts      # Project tool detection for mise
├── dist/               # Compiled output
├── Dockerfile          # Container image definition
├── package.json
├── tsconfig.json
└── README.md
```

## Build Commands

```bash
npm install      # Install dependencies
npm run build    # Compile TypeScript
npm link         # Install globally for development
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

## Key Concepts

### Project Containers

Each project gets its own container named `ccc-<project>-<path-hash>`:
1. Container created on first `ccc` run
2. Lock file created per session for tracking
3. On exit: lock removed, container stopped if no other sessions active

### Environment Variables

**Auto-forwarded from host**: All host env vars except system ones (PATH, HOME, USER, SHELL, LC_*, etc.)

**Per-session**: `ccc --env KEY=VALUE`

### mise Integration

- Projects use `.mise.toml` for tool version management
- On first `ccc` run, prompts to auto-detect and create `.mise.toml`
- `mise install` runs automatically before `claude` command
- mise cache shared across all sessions (`~/.ccc/mise`)

### Container Image

Built from Dockerfile on first run. Includes:
- Base: `ubuntu:24.04`
- Dependencies: curl, git, ca-certificates, unzip
- Chromium browser (`CHROME_BIN` env set)
- mise with global tools: maven, gradle, yarn, pnpm
- claude-code native binary
- `.bashrc` configured for mise activation

### Resource Limits

- **Memory/CPU**: No limits (shares host resources)
- **PIDs**: Limited to 512 processes

### Signal Handling

- SIGINT (Ctrl+C), SIGTERM, SIGHUP: cleanup session and exit
- Normal exit: cleanup session
- Container stopped only when no other sessions remain

## Code Guidelines

- Keep the CLI simple and minimal
- Per-project container approach with path-hash naming
- Lock files for session tracking and crash recovery
- Auto-forward host environment variables
- Auto-stop container when last session exits
