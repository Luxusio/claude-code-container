# Claude Code Sandbox

Run Claude Code in isolated Docker containers.

## Install

```bash
npm install -g claude-sandbox
```

## Usage

```bash
claude-sandbox init     # Create Dockerfile
claude-sandbox          # Start Claude (auto-cleanup on exit)
claude-sandbox shell    # Shell only
```

## Customize

Edit `.claude/claude-sandbox/Dockerfile`:

```dockerfile
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates \
    openjdk-17-jdk maven \
    && npm install -g @anthropic-ai/claude-code \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
```

## GitHub Actions

| Secret               | Description              |
|----------------------|--------------------------|
| `DOCKERHUB_USERNAME` | Docker Hub username      |
| `DOCKERHUB_TOKEN`    | Docker Hub access token  |
| `NPM_TOKEN`          | npm access token         |

Release: `npm version patch && git push --tags`
