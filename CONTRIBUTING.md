# Contributing Guide

Development guide for claude-code-container (ccc).

## Development Setup

### Requirements

- Node.js 22+
- Docker
- npm

### Installation

```bash
git clone https://github.com/your-username/claude-code-container.git
cd claude-code-container
sudo node scripts/install.js   # Omit sudo on Windows
```

Handles npm install, build, and global installation automatically.

## Architecture

### Directory Structure

```
~/.ccc/
├── claude/             # Claude credentials (mounted to container)
├── locks/              # Session lock files (per-session UUID)
│   ├── my-project-a1b2c3d4e5f6-uuid1.lock
│   └── my-project-a1b2c3d4e5f6-uuid2.lock
└── mise/               # Shared mise cache
```

### Container Structure

```
Container (ccc-<project>-<hash>):
├── /project/<project>-<hash>   # Project path mount
├── /claude                      # ~/.ccc/claude mount
└── /home/ccc/.local/share/mise  # mise cache mount
```

### Image Build

When running `sudo node scripts/install.js`:
1. Stops all running `ccc-*` containers
2. Deletes existing `ccc` image and rebuilds from Dockerfile

When running `ccc`:
1. If no `ccc` image exists, shows error (directs to install.js)
2. Creates per-project container from the image

Dockerfile includes:
- Ubuntu 24.04 base
- curl, git, ca-certificates, unzip
- Chromium (for headless testing, `CHROME_BIN` env set)
- locales and tzdata (pre-generated common locales)
- iptables (for transparent localhost proxy on macOS/Windows)
- mise installation and configuration
- Global tools: maven, gradle, yarn, pnpm
- claude-code native binary (independent of project node version)

### Session Lifecycle

1. **Start**: `ccc` runs → container created/started + session lock file created
2. **Running**: Multiple sessions possible for the same project (different lock files)
3. **Exit**: Lock file deleted → container auto-stops if no active sessions remain
4. **Crash recovery**: Stale lock files cleaned up on next `ccc` run

Container names are fixed per path hash, so `claude --continue` and `--resume` work correctly.

### Environment Variable Forwarding

1. **Auto-forwarded from host**: All env vars except system ones (PATH, HOME, etc.) are forwarded
2. **Locale/Timezone**: `LANG`, `LC_*`, `TZ` auto-forwarded; defaults to `en_US.UTF-8` and auto-detected timezone
3. **Per-session**: `ccc --env KEY=VALUE`

### Transparent Localhost Proxy (macOS/Windows)

On macOS/Windows, `--network host` doesn't truly share the host network (runs in a VM). A transparent proxy handles this:

1. iptables REDIRECT rule captures all TCP traffic to `127.0.0.1`
2. Proxy tries connecting to `localhost:PORT` first (container server)
3. On ECONNREFUSED, falls back to `host.docker.internal:PORT` (host server)
4. On Linux, this is skipped entirely (`--network host` works natively)

### Signal Handling

- SIGINT (Ctrl+C), SIGTERM, SIGHUP: cleanup and exit
- Normal exit: delete lock file, stop container if no other sessions

## Project Structure

```
claude-code-container/
├── src/
│   ├── index.ts               # CLI main entry point
│   ├── docker.ts              # Docker container lifecycle management
│   ├── session.ts             # Session lock file management
│   ├── scanner.ts             # Project tool detection for mise
│   ├── container-setup.ts     # Claude binary installation in container
│   ├── localhost-proxy.ts     # Transparent localhost proxy core logic
│   ├── localhost-proxy-setup.ts # Proxy + iptables setup in container
│   ├── clipboard-server.ts    # Host clipboard bridge
│   ├── mcp-forward.ts         # MCP server forwarding
│   ├── worktree.ts            # Git worktree workspace management
│   ├── remote.ts              # Remote development helpers
│   └── utils.ts               # Shared utilities
├── scripts/
│   └── install.js             # Cross-platform global installer
├── dist/                      # Compiled JavaScript (gitignored)
├── Dockerfile                 # Container image definition
├── package.json
├── tsconfig.json
├── CLAUDE.md                  # Claude Code instructions
├── CONTRIBUTING.md            # This file
└── README.md                  # User documentation
```

## Development Workflow

```bash
# Build after code changes
npm run build

# Test ccc command (symlinked, auto-reflects changes)
ccc --help
ccc status
```

### Uninstall Global

```bash
# macOS/Linux
sudo npm run uninstall:global

# Windows
npm run uninstall:global
```

## Build Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run build` | Compile TypeScript |
| `npm test` | Run tests (vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run install:global` | Install globally (sudo on macOS/Linux) |
| `npm run uninstall:global` | Uninstall globally (sudo on macOS/Linux) |

## Code Style

- TypeScript ES2022 target
- Keep code concise and minimal
- Per-project containers with path-hash naming
- Lock files for session tracking and crash recovery

## Key Components

### Container Management

- `startProjectContainer()`: Create/start project container
- `stopProjectContainer()`: Stop container
- `removeProjectContainer()`: Remove container
- `ensureImage()`: Check image exists (directs to install.js if missing)

### Session Management

- `createSessionLock()`: Create session lock file
- `removeSessionLock()`: Delete lock file
- `hasOtherActiveSessions()`: Check for other active sessions
- `cleanupSession()`: Cleanup session (delete lock + decide container stop)
- `setupSignalHandlers()`: Register signal handlers

### mise Integration

- `ensureMiseConfig()`: Check for `.mise.toml`, offer to create if missing
- `detectProjectToolsAndWriteMiseConfig()`: Analyze project with Claude to generate mise.toml

### Localhost Proxy

- `tryConnect()`: Attempt TCP connection with timeout
- `proxyConnection()`: Try local first, fallback to host.docker.internal
- `startProxy()` / `stopProxy()`: Proxy server lifecycle
- `setupLocalhostProxy()`: Set up iptables + proxy daemon in container (macOS/Windows only)

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test -- src/__tests__/localhost-proxy.test.ts

# Run Claude in a project (container auto-created)
cd /path/to/project
ccc

# Check status
ccc status

# Open shell
ccc shell

# Cleanup
ccc rm
```

## Deployment

### npm Release

Auto-deployed on tag push to `main` branch:

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Troubleshooting

### `ccc` command not found

```bash
# Re-run global install
sudo npm run install:global   # macOS/Linux
npm run install:global        # Windows

# Verify installation
which ccc    # macOS/Linux
where ccc    # Windows
```

### Build Errors

```bash
# Reinstall node_modules
rm -rf node_modules dist
npm install
npm run build
```

### Container Issues

```bash
# Check container status
ccc status
docker ps -a | grep ccc-

# Check container logs
docker logs ccc-<project>-<hash>

# Remove and restart container
ccc rm
ccc
```

### Image Rebuild

```bash
sudo node scripts/install.js  # Stops containers + rebuilds image
```

### Manual Stale Session Cleanup

```bash
# Check lock files
ls -la ~/.ccc/locks/

# Manual cleanup (if needed)
rm ~/.ccc/locks/*.lock
```
