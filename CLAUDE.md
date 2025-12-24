# CLAUDE.md

Instructions for Claude Code when working with this repository.

## Project Overview

**claude-code-container** (ccc) is a CLI tool that runs Claude Code in isolated Docker containers. It provides:

- Automatic container lifecycle management
- Persistent login across sessions
- Security hardening (read-only fs, capability drops, resource limits)
- Simple project-specific Dockerfile customization

## Technology Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript (ES2015 target)
- **Container**: Docker with docker-compose

## Project Structure

```
claude-code-container/
├── src/
│   └── index.ts          # Main CLI entry point
├── dist/                 # Compiled output
├── .github/workflows/
│   ├── docker.yml        # Docker Hub publish
│   └── npm.yml           # npm publish
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

## Key Concepts

### Container Configuration

The tool generates a docker-compose.yml with:
- Volume mounts: workspace + credentials
- Security options: read_only, cap_drop, no-new-privileges
- Resource limits: CPU, memory, PIDs
- Environment: CLAUDE_CONFIG_DIR=/claude

### Credential Storage

- Location: `~/.ccc/`
- Mounted to `/claude` in container
- Persists login across all projects

### Project Dockerfile

- Location: `.claude/ccc/Dockerfile`
- Created via `ccc init`
- Users customize for project-specific tools

## Code Guidelines

- Keep the CLI simple and minimal
- Auto-cleanup containers and images on exit
- Support both `docker compose` and `docker-compose`
- Use alpine-based images for smaller size
