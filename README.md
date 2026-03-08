# Claude Code Container (ccc)

Single command. Isolated environment. No setup required.

## Features

Run `ccc` in your project directory — no Dockerfile, docker-compose, port mapping, or volume config needed.

- Per-project isolated containers (path-hash based naming)
- Auto-forwarding of host env vars, locale (`LANG`/`LC_*`), and timezone (`TZ`)
- SSH keys and agent auto-mounted
- Auto-cleanup on session exit (stops container when last session ends)
- mise-based tool version management (auto-detect and create `mise.toml`)
- Built-in Chromium (headless testing support)
- `--network host` for direct port access
- macOS/Windows: transparent localhost proxy (iptables + fallback to `host.docker.internal`)
- Auto-pull Docker image from Docker Hub on first run (no manual `docker build` needed)
- Version-aware image management (auto-updates on `npm update`)

## Installation

### npm (Recommended)

```bash
npm install -g claude-code-container
```

On first `ccc` run, the Docker image (~2GB) is automatically pulled from Docker Hub. No manual build required.

For development setup, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick Start

```bash
# Run Claude in current project (container auto-created)
ccc

# Continue previous session
ccc --continue
ccc --resume

# Open a shell in the container
ccc shell

# Run arbitrary commands
ccc npm install
ccc npm test
```

## How It Works

```
~/.ccc/
├── claude/       # Claude credentials (mounted to /claude)
└── locks/        # Session lock files (per session)

Docker Volume:
└── ccc-mise-cache  # mise cache (named volume, optimized for macOS/Windows)
```

### Session Lifecycle

1. **Start**: Container created/started + session lock file created
2. **Running**: Multiple sessions can run for the same project simultaneously
3. **Exit**: Lock file deleted; container auto-stops if no other sessions remain
4. **Crash recovery**: Stale lock files cleaned up on next run

Container names are fixed per project path hash, so `claude --continue` and `--resume` work correctly.

### Image Management

ccc uses Docker image labels to manage versions:

| Scenario | Behavior |
|----------|----------|
| npm install (first run) | Auto-pulls matching version from Docker Hub |
| npm update | Detects version mismatch, auto-pulls new image |
| Local `docker build -t ccc .` | Uses local image, never auto-replaced |
| Offline with stale image | Warns but continues with existing image |
| Offline with no image | Error with instructions to build locally |

Override the registry with `CCC_REGISTRY` env var:
```bash
export CCC_REGISTRY=myregistry/claude-code-container
```

## Commands

```bash
ccc                        # Run Claude
ccc shell                  # Open bash shell
ccc <command>              # Run arbitrary command
ccc --env KEY=VALUE        # Set additional env var
ccc stop                   # Stop current project's container
ccc rm                     # Remove current project's container
ccc status                 # Show CLI version, image info, and containers
ccc doctor                 # Health check and diagnostics
ccc clean                  # Clean stopped containers and images
```

## Environment Variables

### Auto-Forwarding from Host

Host environment variables are automatically forwarded to the container.

```bash
export JIRA_API_KEY=xxx
ccc  # JIRA_API_KEY is available inside the container
```

**Excluded** (to prevent system conflicts):
- `PATH`, `HOME`, `USER`, `SHELL`, `PWD`
- macOS-specific vars (`TERM_PROGRAM`, `ITERM_*`, `LC_TERMINAL`, etc.)

**Auto-forwarded**: `LANG`, `LC_ALL`, `LC_CTYPE` (host locale), `TZ` (auto-detected)

### Per-Session Environment Variables

```bash
ccc --env API_KEY=xxx --env DEBUG=true
```

### Container/Desktop Environment Separation

See the [Tool Management (mise)](#tool-management-mise--zero-config-project-setup) section for details on separating container and desktop environments.

## SSH Access

SSH configuration from the host is automatically used when Git SSH access is needed (private repo cloning, plugin installation, etc.).

### Auto-Mounted (no setup required)

| Item | macOS (Docker Desktop) | Linux |
|------|----------------------|-------|
| SSH keys (`~/.ssh`) | Read-only mount | Read-only mount |
| SSH Agent | Docker Desktop built-in socket | `$SSH_AUTH_SOCK` auto-detected |

### Troubleshooting SSH

```bash
# 1. Check if SSH keys are registered with the agent on host
ssh-add -l

# Add key if missing
ssh-add ~/.ssh/id_ed25519   # or id_rsa

# 2. Recreate container (to apply new mounts)
ccc rm
ccc
```

### Verification

```bash
ccc shell
ssh-add -l                          # List agent keys
ssh -T git@github.com               # Test GitHub connection
ssh -T git@gitlab.example.com       # Test GitLab connection
```

## Worktree Workspaces (`ccc @<branch>`)

`ccc @<branch>` creates an isolated workspace per branch. It auto-creates `git worktree` entries for git repos in the current directory and runs Claude in the workspace.

### Structure

```
~/projects/
├── my-project/          # Original (git repos + other files)
│   ├── backend/         # git repo
│   ├── frontend/        # git repo
│   └── shared/          # regular directory
└── my-project--feature/ # Workspace (auto-created)
    ├── backend/         # git worktree (feature branch)
    ├── frontend/        # git worktree (feature branch)
    └── shared -> ../my-project/shared  # symlink
```

Git repos are linked via `git worktree`; other items are symlinked.

### Commands

```bash
# Create workspace + run Claude
ccc @feature

# Reuse existing workspace
ccc @feature --continue

# List workspaces + container status
ccc @

# Remove workspace (container + worktrees)
ccc @feature rm

# Force remove dirty worktrees
ccc @feature rm -f
```

### Branch Handling

- **Local branch exists**: Creates worktree from that branch
- **Remote only**: Creates local branch from `origin/<branch>`
- **Doesn't exist**: Creates new branch from HEAD

Branch `/` is converted to `-` in directory names (e.g., `feature/login` → `my-project--feature-login/`).

### Parallel Work

Each workspace has its own container, so they can run simultaneously.

```bash
# Terminal 1
cd ~/projects/my-project && ccc @feature --continue

# Terminal 2 (simultaneously)
cd ~/projects/my-project && ccc @bugfix --continue
```

## Tool Management (mise) — Zero-Config Project Setup

ccc uses [mise](https://mise.jdx.dev/) to automatically manage per-project tool versions.

### Auto-Detection

When running `ccc` for the first time in a project without `mise.toml`:

1. Scans project files (`package.json`, `.nvmrc`, `pom.xml`, `build.gradle`, `go.mod`, etc.)
2. Auto-detects tools and versions in use
3. Prompts to create `mise.toml` → press `Y` to auto-generate

```
$ ccc
No mise.toml found in project.
Create mise.toml? (auto-detect tools) [Y/n]: Y
Scanning project files...
Found 3 version file(s), 2 version hint(s). Analyzing with Claude...
Created: /path/to/project/mise.toml
```

### Configuration Example

```toml
# .mise.toml
[tools]
node = "22"
java = "temurin-21"

[env]
_.file = [".env", "{% if env.container is defined %}.env.ccc{% else %}/dev/null{% endif %}"]
```

`mise install` runs automatically on each `ccc` invocation, installing any required tools. The mise cache is stored in a Docker named volume (`ccc-mise-cache`), shared across projects and optimized for macOS/Windows performance.

### Supported Tools

| Category | Tools |
|----------|-------|
| **Per-project** (`mise.toml`) | node, java, python, go, rust, ruby, php, deno, bun, terraform, kotlin, elixir, zig, dotnet |
| **Global** (built into image) | maven, gradle, yarn, pnpm |

### Container/Desktop Environment Separation

The `container=docker` environment variable is automatically set inside the container. Use it in mise.toml to load different `.env` files per environment.

| File | Loaded in | Purpose |
|------|-----------|---------|
| `.env` | Always | Shared environment variables |
| `.env.ccc` | Container only | Container-specific overrides (e.g., `DB_HOST=host.docker.internal`) |

## Container Image

Based on Ubuntu 24.04, includes:
- mise (tool version management)
- claude-code CLI
- Chromium (for headless testing, `CHROME_BIN` configured)
- maven, gradle, yarn, pnpm
- Pre-generated locales (en_US, ko_KR, ja_JP, zh_CN, de_DE, fr_FR, es_ES, pt_BR)
- No memory/CPU/PID limits (shares host resources)

The image is available on [Docker Hub](https://hub.docker.com/r/luxusio/claude-code-container):
```bash
docker pull luxusio/claude-code-container:latest
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture, and release process.

## License

MIT
