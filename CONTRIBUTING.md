# Contributing Guide

Development guide for claude-code-container (ccc).

## Development Setup

### Requirements

- Node.js 22+
- Docker
- npm

### From Source

```bash
git clone https://github.com/Luxusio/claude-code-container.git
cd claude-code-container
npm install && npm run build
docker build -t ccc .
```

Local builds (`docker build -t ccc .`) are never auto-replaced by the registry image. The CLI detects dev builds by the absence of a `cli.version` Docker label.

### Build Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run build` | Compile TypeScript |
| `npm test` | Run tests (vitest) |
| `npm run test:watch` | Run tests in watch mode |

### Running Locally

```bash
# Run CLI directly from source
node dist/index.js

# Or link globally for development
npm link
ccc
```

## Architecture

### Directory Layout

```
~/.ccc/
├── claude/             # Default credentials (mounted to container)
├── locks/              # Session lock files (per-session UUID)
│   ├── myproject-a1b2--<sessionId>.lock           # No profile
│   └── myproject-a1b2--p--work--<sessionId>.lock  # Profile "work"
├── profiles/           # Named profiles (credential isolation)
│   └── work/
│       ├── claude/     # Profile credentials (mounted to separate container)
│       └── claude.json
└── remote/             # Remote development configs

Docker Volume:
└── ccc-mise-cache      # Shared mise cache (named volume)
```

### Container Structure

```
Container (ccc-<project>-<hash>):            # No profile
Container (ccc-<project>-<hash>--p--work):   # Profile "work"

├── /project/<project>-<hash>   # Project path mount
├── /home/ccc/.claude           # Claude config mount (profile-specific)
├── /home/ccc/.ssh              # SSH keys (read-only)
├── /tmp/ssh-agent.sock         # SSH agent socket
└── /home/ccc/.local/share/mise # mise cache (named volume)
```

### Profile System

Profiles provide credential directory isolation. Each profile gets a separate `~/.ccc/profiles/<name>/claude/` directory mounted to its own container.

- `CCC_PROFILE` env var selects the profile at runtime
- No profile → uses `~/.ccc/claude/` (backward compatible)
- Container naming: `ccc-{projectId}--p--{profile}`
- Session locks use `--` separator: `{projectId}--p--{profile}--{sessionId}.lock`
- `getClaudeDir(profile?)` and `getClaudeJsonFile(profile?)` in `utils.ts` resolve paths
- Environment variables (API keys, backends) are NOT managed by profiles — use `mise.toml` `[env]`

### Image Management

| Scenario | Behavior |
|----------|----------|
| npm install (first run) | Auto-pulls matching version from Docker Hub |
| npm update | Detects version mismatch, auto-pulls new image |
| Local `docker build -t ccc .` | Uses local image, never auto-replaced |
| Offline with stale image | Warns but continues with existing image |
| Offline with no image | Error with instructions to build locally |

Override the registry: `export CCC_REGISTRY=myregistry/claude-code-container`

### Image Resolution

The CLI uses Docker image labels (`cli.version`) to manage versions:

1. Local `ccc` with **no label** → dev build, use as-is (never auto-replaced)
2. Local `ccc` with **matching label** → correct version, use as-is
3. **Mismatch or missing** → pull `DOCKER_REGISTRY_IMAGE:CLI_VERSION`, tag as `ccc`
4. Pull failure with stale image → warn, continue
5. Pull failure with no image → error with manual build instructions

### Session Lifecycle

1. **Start**: `ccc` runs → container created/started + session lock file created
2. **Running**: Multiple sessions possible for the same project (different lock files)
3. **Exit**: Lock file deleted → container auto-stops if no active sessions remain
4. **Crash recovery**: Stale lock files cleaned up on next `ccc` run

Container names are fixed per path hash, so `claude --continue` and `--resume` work correctly.

### Auto Container Upgrade

When the ccc image is rebuilt (locally or via registry pull), the next `ccc` run detects the SHA mismatch and automatically recreates the container. If other sessions are active, it defers the upgrade with a message.

### Environment Variable Forwarding

1. **Auto-forwarded from host**: All env vars except system ones (PATH, HOME, etc.)
2. **Locale/Timezone**: `LANG`, `LC_*`, `TZ` auto-forwarded; defaults to `en_US.UTF-8` and auto-detected timezone
3. **Per-session**: `ccc --env KEY=VALUE`
4. **Container marker**: `container=docker` auto-set inside container

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
│   ├── doctor.ts              # Health check and diagnostics
│   ├── clean.ts               # Container/image cleanup
│   ├── profile.ts             # Profile management (credential isolation)
│   └── utils.ts               # Shared utilities (CLI_VERSION, constants)
├── scripts/
│   ├── install.js             # Legacy cross-platform global installer
│   ├── clipboard-shims/       # Clipboard bridge shims (runtime)
│   └── clipboard-helper-darwin.m  # macOS clipboard helper (compiled at runtime)
├── dist/                      # Compiled JavaScript (gitignored)
├── Dockerfile                 # Container image definition
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── CLAUDE.md                  # Claude Code instructions
├── CONTRIBUTING.md            # This file
└── README.md                  # User documentation
```

## Key Components

### Container Management (`docker.ts`)

- `ensureImage()`: Label-based version matching with auto-pull from Docker Hub
- `getImageLabel()`: Read Docker image labels
- `pullImage()` / `tagImage()`: Registry image operations
- `startProjectContainer()`: Create/start project container
- `stopProjectContainer()` / `removeProjectContainer()`: Container lifecycle
- `isContainerImageOutdated()`: SHA-based container upgrade detection

### Session Management (`session.ts`)

- `createSessionLock()`: Create session lock file
- `removeSessionLock()`: Delete lock file
- `hasOtherActiveSessions()`: Check for other active sessions
- `cleanupSession()`: Cleanup session (delete lock + decide container stop)
- `setupSignalHandlers()`: Register signal handlers

### mise Integration (`scanner.ts`)

- `ensureMiseConfig()`: Check for `.mise.toml`, offer to create if missing
- `detectProjectToolsAndWriteMiseConfig()`: Analyze project with Claude to generate mise.toml

### Localhost Proxy (`localhost-proxy.ts`)

- `tryConnect()`: Attempt TCP connection with timeout
- `proxyConnection()`: Try local first, fallback to host.docker.internal
- `startProxy()` / `stopProxy()`: Proxy server lifecycle
- `setupLocalhostProxy()`: Set up iptables + proxy daemon in container

### Utilities (`utils.ts`)

- `CLI_VERSION`: Build-time injected version from package.json
- `DOCKER_REGISTRY_IMAGE`: Docker Hub registry path (overridable via `CCC_REGISTRY`)
- `hashPath()` / `getProjectId()`: Path-based container naming
- `EXCLUDE_ENV_KEYS`: Environment variables excluded from forwarding

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npx vitest run src/__tests__/docker.test.ts

# Run tests in watch mode
npm run test:watch
```

## Release Process

Releases are automated via a single GitHub Actions workflow (`.github/workflows/release.yml`).

### Steps

1. Update `version` in `package.json`
2. Commit and tag:
   ```bash
   git add package.json
   git commit -m "release: v1.2.3"
   git tag v1.2.3
   git push && git push --tags
   ```
3. GitHub Actions runs:
   - **docker-build**: Verifies tag matches package.json version, builds multi-arch image (amd64 + arm64), pushes to Docker Hub with `cli.version` label
   - **npm-publish**: Runs only if docker-build succeeds, publishes to npm with Node 24

### Version Coherence

- npm package version and Docker Hub tag are always in lockstep
- Docker image includes `cli.version` label matching the npm version
- CLI detects version mismatches on startup and auto-pulls the correct image

### Docker Hub

Images are published to [`luxusio/claude-code-container`](https://hub.docker.com/r/luxusio/claude-code-container) with tags:
- `luxusio/claude-code-container:<version>` (e.g., `1.0.0`)
- `luxusio/claude-code-container:latest`

### Secrets Required

| Secret | Description |
|--------|-------------|
| `DOCKERHUB_USERNAME` | Docker Hub username |
| `DOCKERHUB_TOKEN` | Docker Hub access token |

npm publishing uses OIDC Trusted Publishing (no token required). Configure it at [npmjs.com → package → Settings → Trusted Publishers](https://www.npmjs.com/settings) with the GitHub repository.

## Troubleshooting

### `ccc` command not found (npm install)

```bash
npm install -g claude-code-container
```

### Build Errors

```bash
rm -rf node_modules dist
npm install
npm run build
```

### Container Issues

```bash
ccc doctor              # Health check
ccc status              # Show all containers
docker logs ccc-<name>  # Check container logs
ccc rm && ccc           # Recreate container
```

### Image Rebuild (Local Development)

```bash
docker rmi ccc
docker build -t ccc .
ccc rm
ccc
```

### Stale Session Cleanup

```bash
ls -la ~/.ccc/locks/
rm ~/.ccc/locks/*.lock    # Manual cleanup if needed
```

## Code Style

- TypeScript with ES2022 target, ESM modules
- Keep code concise and minimal
- Per-project containers with path-hash naming
- Lock files for session tracking and crash recovery
- Fail-open pattern for non-critical operations (image inspect, etc.)
