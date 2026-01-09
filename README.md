# Claude Code Container (ccc)

Run Claude Code in isolated Docker containers with persistent login.

## Install

```bash
npm install -g claude-code-container
```

## Usage

```bash
ccc init     # Interactive setup (mise or Dockerfile)
ccc          # Start Claude (auto-cleanup on exit) --dockerfile
ccc shell    # Shell only
```


## Init Options

```
$ ccc init

? How do you want to configure the container?
  1. mise (recommended) - Use mise.toml for tool versions
  2. Custom Dockerfile - Full control over container

? Auto-configure based on your project?
  1. Yes - Analyze project files
  2. No - Create minimal template
```

### mise Mode (Recommended)
- Creates `.mise.toml` in project root
- Tool versions managed via mise
- Fast subsequent starts with cached tools (`~/.ccc/mise`)

### Dockerfile Mode
- Creates `.claude/ccc/Dockerfile`
- Full control over container environment
- Tools baked into image

## Auto-Detection

Uses Claude CLI to analyze your project and detect required tools automatically.
Supports: node, java, python, go, rust, ruby, php, deno, bun

## How It Works

1. First run: Login via `/login` command
2. Credentials stored in `~/.ccc/`
3. Subsequent runs: Auto-authenticated

## Security Features

- Read-only container filesystem
- Capability restrictions (drops all, adds minimal)
- No new privileges
- Resource limits (CPU, memory, PIDs)
- tmpfs for /tmp and /home/claude

## License

MIT
