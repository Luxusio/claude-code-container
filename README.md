# Claude Code Container (ccc)

Single command. Isolated environment. No setup required.

## Philosophy: Zero-Config

ccc is designed to **just work** out of the box. Run `ccc` in your project directory and everything is handled automatically:

- Container creation and project mounting
- Host environment variables, locale, and timezone forwarding
- SSH keys and agent mounting
- Project tool detection and installation via mise (node, java, python, etc.)
- Transparent localhost proxy on macOS/Windows (auto-connects host and container servers)
- Automatic container cleanup on session exit

No custom Dockerfile, docker-compose, port mapping, or volume configuration needed.

## Features

- Per-project isolated containers (path-hash based naming)
- Auto-forwarding of host env vars, locale (`LANG`/`LC_*`), and timezone (`TZ`)
- Auto-cleanup on session exit (stops container when last session ends)
- mise-based tool version management (auto-detect and create `.mise.toml`)
- Built-in Chromium (headless testing support)
- `--network host` for direct port access
- macOS/Windows: transparent localhost proxy (iptables + fallback to `host.docker.internal`)

## Installation

```bash
git clone https://github.com/your-username/claude-code-container.git
cd claude-code-container
sudo node scripts/install.js   # Omit sudo on Windows
```

If you hit the GitHub API rate limit during image build, pass a token:

```bash
export GITHUB_TOKEN=github_pat_xxx
sudo -E node scripts/install.js
```

**Uninstall:** `sudo node scripts/install.js --uninstall`

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

## Commands

```bash
ccc                        # Run Claude
ccc shell                  # Open bash shell
ccc <command>              # Run arbitrary command
ccc --env KEY=VALUE        # Set additional env var
ccc stop                   # Stop current project's container
ccc rm                     # Remove current project's container
ccc status                 # Show all containers status
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

## Remote Development

Run ccc on a powerful remote machine from a lightweight laptop.

### Requirements

- [Tailscale](https://tailscale.com/) - Network connectivity (optional, recommended for remote access)
- [Mutagen](https://mutagen.io/) - Real-time file sync
- SSH-accessible remote host

### Usage

```bash
# From MacBook - first time (config saved)
ccc remote my-desktop
# Remote user [user]: john
# Remote path [/Users/me/myproject]: /home/john/myproject
# Config saved.
# Creating sync session...
# Waiting for initial sync... done
# Connecting to my-desktop...
# [Claude now running on desktop]

# Subsequent runs
ccc remote

# Pass claude options
ccc remote --continue
ccc remote --resume
```

### Architecture

Mutagen syncs directly to the Docker container (no filesystem middleman). This bypasses slow volume mounts on Windows/macOS for better performance.

```
MacBook (laptop)                        Desktop (remote)
┌─────────────────────┐                ┌─────────────────────────┐
│  Source code (local) │                │  Docker Container       │
│                     │────Mutagen────►│  /project/<id> (direct) │
│                     │                │                         │
│  ccc remote         │──────SSH──────►│  docker exec claude     │
│  terminal I/O       │◄───────────────│                         │
└─────────────────────┘                └─────────────────────────┘
```

### Commands

```bash
ccc remote <host>       # Connect to host (first run: prompts for config)
ccc remote              # Connect using saved config
ccc remote setup        # Setup guide
ccc remote check        # Check connectivity and sync status
ccc remote terminate    # Stop sync session
```

### Requirements

1. **ccc installed on remote host**: The remote machine must also have ccc installed
2. **SSH key authentication**: Passwordless SSH access recommended
3. **Docker running**: Docker must be running on the remote host

## Tool Management (mise) — Zero-Config Project Setup

ccc uses [mise](https://mise.jdx.dev/) to automatically manage per-project tool versions.

### Auto-Detection

When running `ccc` for the first time in a project without `.mise.toml`:

1. Scans project files (`package.json`, `.nvmrc`, `pom.xml`, `build.gradle`, `go.mod`, etc.)
2. Auto-detects tools and versions in use
3. Prompts to create `.mise.toml` → press `Y` to auto-generate

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
| **Per-project** (`.mise.toml`) | node, java, python, go, rust, ruby, php, deno, bun, terraform, kotlin, elixir, zig, dotnet |
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

Rebuild the image:

```bash
ccc rm
docker rmi ccc
ccc  # Automatically builds new image
```

## Resource Limits

- **Memory/CPU**: No limits (shares host resources)
- **PIDs**: Unlimited (same as host)

## Development

### Build & Test

```bash
npm install      # Install dependencies
npm run build    # Compile TypeScript
npm test         # Run tests (vitest)
npm run test:watch  # Run tests in watch mode
```

### Project Structure

```
src/
├── index.ts              # CLI main entry point
├── localhost-proxy.ts     # Transparent localhost proxy (macOS/Windows)
├── localhost-proxy-setup.ts # Proxy + iptables setup in container
├── remote.ts             # Remote development helpers
├── scanner.ts            # Project tool detection for mise
└── utils.ts              # Shared utilities
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed development guide.

## License

MIT
