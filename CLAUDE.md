# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm link             # Link globally for local development
```

Build the Docker image locally:
```bash
docker build -t claude-code-container .
```

Release (triggers npm + Docker Hub CI/CD):
```bash
git tag vX.X.X && git push origin vX.X.X
```

**Note:** No test suite or linting is configured. Testing is manual via `ccc init`, `ccc`, `ccc shell` commands.

## Architecture

### Source Files
- `src/index.ts` - CLI entry point implementing three commands: `ccc init` (setup wizard), `ccc` (run Claude in container), `ccc shell` (shell-only mode)
- `src/scanner.ts` - Scans projects for version files across 25+ language ecosystems to auto-detect tooling

### Two Configuration Modes
1. **mise mode** (recommended): Creates `.mise.toml` in project root. Tools are cached in `~/.ccc/mise/`
2. **Dockerfile mode**: Creates custom Dockerfile in `.claude/ccc/Dockerfile`

Both modes use AI-assisted configuration - the CLI invokes Claude with `--allowedTools Read,Write` to analyze scanned version files and generate appropriate configs.

### Key Paths
| Path | Purpose |
|------|---------|
| `.claude/ccc/` | Project sandbox (docker-compose.yml, optional Dockerfile) |
| `~/.ccc/` | Global credential storage |
| `~/.ccc/mise/` | Cached mise tool installations |

### Container Security Model
Generated docker-compose.yml implements:
- Read-only filesystem
- Drops all capabilities (adds only CHOWN, SETUID, SETGID, DAC_OVERRIDE)
- Resource limits: 2 CPUs, 4GB memory, 256 PIDs
- Non-root `claude` user (UID 1000)
- tmpfs for /tmp and /home/claude
