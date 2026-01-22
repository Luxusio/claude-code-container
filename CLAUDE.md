# CLAUDE.md

Instructions for Claude Code when working with this repository.

## Project Overview

**claude-code-container** (ccc) is a CLI tool that runs Claude Code in an isolated Docker container. It provides:

- Single daemon container shared across all projects
- Session-based project mounting (auto-cleanup on exit)
- Global environment variable file support
- mise-based tool version management per project
- `--network host` for direct port access

## Architecture

```
~/.ccc/
├── claude/             # Claude credentials (mounted to /claude)
├── projects/           # Project symlinks (path-hash based, fixed per project)
│   └── my-project-a1b2c3d4e5f6 -> /path/to/my-project
├── locks/              # Session lock files (per session)
│   ├── my-project-a1b2c3d4e5f6-uuid1.lock
│   └── my-project-a1b2c3d4e5f6-uuid2.lock
├── mise/               # Shared mise cache
└── env                 # Global environment variables file

Container (ccc-daemon):
├── /projects           # Mounted from ~/.ccc/projects
├── /claude             # Mounted from ~/.ccc/claude
├── /env                # Mounted from ~/.ccc/env (read-only)
└── /root/.local/share/mise  # Mounted mise cache
```

## Session Lifecycle

1. **Start**: `ccc` creates project symlink (fixed, path-hash based) + session lock file
2. **Running**: Multiple sessions can run for same project (same symlink, different lock files)
3. **Exit**: Lock file deleted, `cleanupStaleSymlinks()` removes symlink if no locks remain
4. **Crash recovery**: Next `ccc` run cleans up symlinks without any associated lock files

This design ensures `claude --continue` and `claude --resume` work correctly since the container path stays fixed per project.

## Technology Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript (ES2015 target)
- **Container**: Docker (single long-running container)
- **Base Image**: ubuntu:24.04

## Project Structure

```
claude-code-container/
├── src/
│   ├── index.ts        # Main CLI entry point
│   └── scanner.ts      # Project tool detection for mise
├── dist/               # Compiled output
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
- `ccc start` - Start the daemon container (auto-installs mise + claude)
- `ccc stop` - Stop the daemon container
- `ccc restart` - Restart the daemon container
- `ccc rm` - Remove the daemon container
- `ccc status` - Show container and active sessions

### Execution
- `ccc` - Run Claude in current project
- `ccc shell` - Open bash shell in current project
- `ccc <command>` - Run arbitrary command in current project
- `ccc --env KEY=VALUE` - Set environment variable for session

## Key Concepts

### Project Mounting

Each project has a fixed symlink based on path hash (12 chars):
1. Symlink: `~/.ccc/projects/<project>-<path-hash>` -> actual project path
2. Lock file: `~/.ccc/locks/<project>-<path-hash>-<session-uuid>.lock` (per session)
3. On exit: lock removed, symlink cleaned only if no other sessions active

This ensures container paths are stable for `claude --continue` and `--resume`.

### Global Environment Variables

- File: `~/.ccc/env`
- Mounted to `/env` in container (read-only)
- Applied via `docker exec --env-file /env`
- Also sourced in `.bashrc` for `source ~/.bashrc` compatibility
- Edit `~/.ccc/env` to add persistent environment variables

### mise Integration

- Projects use `.mise.toml` for tool version management
- On first `ccc` run, prompts to auto-detect and create `.mise.toml`
- `mise install` runs automatically before `claude` command
- mise cache shared across all sessions (`~/.ccc/mise`)

### Container Initialization

On first `ccc start`:
1. Builds `ccc-daemon` image from Dockerfile (if not exists)
2. Creates and starts container from the image

The Dockerfile includes:
- Base: `ubuntu:24.04`
- Dependencies: curl, git, ca-certificates, unzip
- mise installation and configuration
- Global tools via mise: maven, gradle, yarn, pnpm
- claude-code native binary (independent of project node version)
- `.bashrc` configured for mise activation and env sourcing

### Resource Limits

- **Memory/CPU**: No limits (shares host resources)
- **PIDs**: Limited to 512 processes

### Signal Handling

- SIGINT (Ctrl+C), SIGTERM, SIGHUP: cleanup and exit
- SIGKILL: cleaned up on next `ccc` run via `cleanupStaleSessions()`

## Code Guidelines

- Keep the CLI simple and minimal
- Single container approach - no per-project containers
- Session-based symlinks with UUID for isolation
- Lock files for crash recovery
- Environment variables via global file, not per-session
