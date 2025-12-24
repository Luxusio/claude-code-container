# ccc - Claude Code Container

Run Claude Code in isolated Docker containers with persistent login.

## Install

```bash
npm install -g claude-code-container
```

## Usage

```bash
ccc init     # Create Dockerfile
ccc          # Start Claude (auto-cleanup on exit)
ccc shell    # Shell only
```

## How It Works

1. First run: Login via `/login` command
2. Credentials stored in `~/.ccc/`
3. Subsequent runs: Auto-authenticated

## Customize

Edit `.claude/ccc/Dockerfile`:

```dockerfile
FROM node:22-alpine

RUN apk add --no-cache git curl ca-certificates bash \
    && npm install -g @anthropic-ai/claude-code \
    && adduser -D -s /bin/bash -u 1000 claude \
    && mkdir -p /workspace /claude \
    && chown -R claude:claude /workspace /claude

# Add your tools
RUN apk add --no-cache openjdk17 maven

USER claude
WORKDIR /workspace
```

## Security Features

- Read-only container filesystem
- Capability restrictions (drops all, adds minimal)
- No new privileges
- Resource limits (CPU, memory, PIDs)
- tmpfs for /tmp and /home/claude

## GitHub Actions

| Secret               | Description              |
|----------------------|--------------------------|
| `DOCKERHUB_USERNAME` | Docker Hub username      |
| `DOCKERHUB_TOKEN`    | Docker Hub access token  |
| `NPM_TOKEN`          | npm access token         |

Release: `npm version patch && git push --tags`

## License

MIT
