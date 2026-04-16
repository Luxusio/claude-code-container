# Claude Code Container (ccc)

Single command. Isolated environment. No setup required.

## Features

- Per-project isolated containers
- Host env vars, SSH keys, locale, timezone auto-forwarded
- Auto-cleanup on session exit
- [mise](https://mise.jdx.dev/) tool version management (auto-detect `mise.toml`)
- Built-in Chromium for headless testing
- Auto-pull Docker image on first run

## Installation

```bash
npm install -g claude-code-container
```

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
```

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
