# Claude Code Container (ccc)

Single command. Isolated environment. No setup required.

## Features

- Per-project isolated containers
- Runs on **Docker or Podman** — auto-detect, Podman preferred when both are installed
- Host env vars, SSH keys, locale, timezone auto-forwarded
- Auto-cleanup on session exit
- [mise](https://mise.jdx.dev/) tool version management (auto-detect `mise.toml`)
- Built-in Chromium for headless testing
- Auto-pull container image on first run

## Installation

### From npm (end users)

```bash
npm install -g claude-code-container
```

The postinstall hook builds the desktop UI binary automatically. Timing:

- First install: ~3 min (requires `cargo` and, on Linux, `libwebkit2gtk-4.1`)
- Incremental rebuilds: ~30 sec (cargo incremental compilation)
- If the UI build fails (e.g. missing cargo), the CLI still installs successfully and prints a warning with manual recovery steps
- The UI uses a debug binary to keep install time reasonable

### From source (developers)

```bash
git clone <repo>
cd claude-code-container
npm install
npm run install:global          # prompts for sudo when writing /usr/local/bin
```

Do NOT use `sudo npm run install:global` — cargo/rustup refuse to run under sudo. The install
script invokes sudo internally only for the `/usr/local/bin` writes. To uninstall: `npm run uninstall:global`.

For development setup, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick Start

```bash
ccc                        # Run Claude in current project
ccc --continue             # Continue previous session
ccc shell                  # Open bash shell
ccc npm test               # Run arbitrary command
```

## Commands

```bash
ccc                        # Run Claude
ccc shell                  # Open bash shell
ccc <command>              # Run command in container
ccc stop                   # Stop container
ccc rm                     # Remove container
ccc status                 # Show all containers
ccc doctor                 # Health check
ccc clean                  # Clean stopped containers/images
ccc runtime                # Print detected container runtime + flavor
ccc ui                     # Launch the desktop app (Tauri 2). Set CCC_DEV=1 for live reload.
```

## Container Runtime (Docker or Podman)

`ccc` works with either Docker or Podman. At startup it detects which
runtime is available and picks it automatically.

```bash
ccc runtime                # e.g. runtime=podman version=5.2.3 flavor=linux-rootless socket=...
```

**Selection order (first hit wins):**

1. `--runtime <docker|podman>` CLI flag
2. `CCC_RUNTIME=docker|podman` environment variable
3. `podman` on PATH → Podman
4. `docker` on PATH → Docker

**Podman specifics handled automatically:**

- **Rootless Podman on Linux**: `--userns=keep-id` is added so host UID maps
  to the container `ccc` user. No manual UID remapping needed.
- **SELinux**: bind mounts get the `:Z` relabel suffix when SELinux is
  enforcing. Gate via `CCC_SELINUX_RELABEL=auto|force|off` (default `auto`).
- **podman machine (macOS/Windows)**: treated like Docker Desktop —
  `host.docker.internal` rewriting and the localhost proxy both apply.
- **Podman socket**: `$XDG_RUNTIME_DIR/podman/podman.sock` (rootless) or
  `/run/podman/podman.sock` (rootful) is substituted for `/var/run/docker.sock`
  on the host side; containers still see `/var/run/docker.sock`. Start it
  with `systemctl --user start podman.socket` if tools inside the container
  need to talk to the runtime. Override the path with
  `CCC_RUNTIME_SOCKET=/custom/socket` when needed.

If neither runtime is installed, `ccc` exits with a clear error.

## Profiles

Switch between different Claude accounts or credential sets. Each profile gets its own `~/.claude` directory and container, fully isolated.

```bash
ccc profile add work       # Create profile
ccc profile list           # List profiles
ccc profile rm work        # Remove profile

CCC_PROFILE=work ccc       # Run with profile
```

Profiles are for **credential directory isolation** only. For environment variables (API keys, backend URLs), use [mise environments](doc/mise-environments.md):

```toml
# mise.toml
[env]
ANTHROPIC_BASE_URL = "http://host.docker.internal:11434/v1"
ANTHROPIC_API_KEY = "dummy"
```

## Worktree Workspaces

```bash
ccc @feature               # Create workspace + run Claude
ccc @feature --continue    # Continue in workspace
ccc @                      # List workspaces
ccc @feature rm            # Remove workspace
```

Each workspace has its own container and can run simultaneously.

## SSH

SSH keys and agent are auto-mounted from host. No setup required.

```bash
# If SSH isn't working:
ssh-add ~/.ssh/id_ed25519   # Add key to agent
ccc rm && ccc               # Recreate container
```

## Environment Variables

Host env vars are auto-forwarded (except system vars like `PATH`, `HOME`).

For per-project env configuration (API keys, LLM backends), see [mise environments guide](doc/mise-environments.md).

For running a local LLM (llama.cpp) with ccc, see [local LLM guide](doc/llamacpp.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture, development setup, and release process.

## License

MIT
