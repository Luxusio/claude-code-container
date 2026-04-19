# Using mise Environments with ccc

Switch between different LLM backends (Anthropic, Bedrock, Vertex, local LLM) per project using mise's environment feature.

## How It Works

mise loads `mise.<ENV>.toml` files based on `MISE_ENV`. Each file can set different environment variables.

```
my-project/
├── mise.toml              # Base config (tools, shared env)
├── mise.ollama.toml       # Ollama settings
├── mise.llamacpp.toml     # llama.cpp settings
├── mise.bedrock.toml      # AWS Bedrock settings
└── mise.vertex.toml       # Google Vertex settings
```

## Setup

### 1. Base config

```toml
# mise.toml — shared tools, always loaded
[tools]
node = "22"
```

### 2. Environment-specific configs

```toml
# mise.ollama.toml
[env]
ANTHROPIC_BASE_URL = "http://host.docker.internal:11434/v1"
ANTHROPIC_API_KEY = "dummy"
```

```toml
# mise.llamacpp.toml — llama.cpp local server (see https://unsloth.ai/docs/basics/claude-code)
[env]
ANTHROPIC_BASE_URL = "http://host.docker.internal:8001"
ANTHROPIC_API_KEY = "sk-no-key-required"
```

```toml
# mise.bedrock.toml
[env]
CLAUDE_CODE_USE_BEDROCK = "1"
AWS_REGION = "us-east-1"
AWS_ACCESS_KEY_ID = "xxx"
AWS_SECRET_ACCESS_KEY = "xxx"
```

```toml
# mise.vertex.toml
[env]
CLAUDE_CODE_USE_VERTEX = "1"
CLOUD_ML_REGION = "us-east5"
ANTHROPIC_VERTEX_PROJECT_ID = "my-project"
```

### 3. Run with environment

```bash
# Local LLM (Ollama)
MISE_ENV=ollama ccc

# Local LLM (llama.cpp)
MISE_ENV=llamacpp ccc

# AWS Bedrock
MISE_ENV=bedrock ccc

# Google Vertex
MISE_ENV=vertex ccc

# Default (no MISE_ENV = just mise.toml)
ccc
```

## Config Merge Order

Higher priority overrides lower:

```
mise.ollama.local.toml   ← highest (personal, gitignored)
mise.local.toml
mise.ollama.toml
mise.toml                ← lowest (base)
```

## Tips

### Keep secrets in `.local` files

```toml
# mise.bedrock.local.toml — gitignored, personal secrets
[env]
AWS_ACCESS_KEY_ID = "AKIA..."
AWS_SECRET_ACCESS_KEY = "wJal..."
```

```toml
# mise.bedrock.toml — committed, shared settings
[env]
CLAUDE_CODE_USE_BEDROCK = "1"
AWS_REGION = "us-east-1"
```

Add to `.gitignore`:

```
mise.*.local.toml
mise.local.toml
```

### Multiple environments

```bash
MISE_ENV=ollama,debug ccc    # last takes precedence on conflicts
```

### Set default environment per directory

```toml
# .miserc.toml
env = ["ollama"]
```

Now `ccc` in this directory always loads `mise.ollama.toml` without setting `MISE_ENV`.

### Combine with profiles

Profiles (credential isolation) and mise environments (env vars) are independent:

```bash
# Different Claude account + local LLM backend
CCC_PROFILE=work MISE_ENV=ollama ccc
```

### Verify active config

```bash
ccc shell
mise config    # shows which config files are loaded
mise env       # shows resolved environment variables
```
