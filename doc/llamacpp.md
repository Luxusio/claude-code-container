# Local LLM with llama.cpp + ccc

Run Claude Code against a local LLM via [llama.cpp](https://github.com/ggerganov/llama.cpp) instead of Anthropic's API.

## How It Works

llama.cpp's `llama-server` exposes an OpenAI-compatible HTTP endpoint.
Claude Code connects to it via `ANTHROPIC_BASE_URL`, and `CCC_PROFILE=local-llm` keeps credentials isolated from your main Claude account.

## 1. Get the Model

[Unsloth](https://unsloth.ai/docs/models/qwen3.5#qwen3.5-397b-a17b) provides optimized GGUF quantizations.
Recommended: **UD-Q4_K_XL** (best quality/size balance at ~214 GB).

```bash
pip install huggingface_hub hf_transfer

hf download unsloth/Qwen3.5-397B-A17B-GGUF \
    --local-dir unsloth/Qwen3.5-397B-A17B-GGUF \
    --include "*UD-Q4_K_XL*"
```

| Quantization | Size | Requirement |
|---|---|---|
| UD-Q4_K_XL | ~214 GB | 256 GB RAM (e.g. M3 Ultra) |
| UD-Q3_K_XL | ~160 GB | 192 GB RAM |
| UD-Q2_K_XL | ~107 GB | Minimum recommended |

## 2. Start llama-server

```bash
export LLAMA_CACHE="unsloth/Qwen3.5-397B-A17B-GGUF"

llama-server \
    -hf unsloth/Qwen3.5-397B-A17B-GGUF:UD-Q4_K_XL \
    --ctx-size 204800 \
    --temp 0.6 \
    --top-p 0.95 \
    --top-k 20 \
    --min-p 0.00 \
    --port 7410
```

Or with a local `.gguf` file (split or single):

```bash
llama-server --model Qwen3.5-397B-A17B-Q4_0-00001-of-00006.gguf \
    --ctx-size 204800 \
    --temp 0.6 \
    --top-p 0.95 \
    --top-k 20 \
    --min-p 0.00 \
    --port 7410
```

The server listens on `http://localhost:7410`.

> **Note**: ccc runs Claude Code inside a Docker container.
> Use `http://localhost:7410` — ccc's transparent proxy handles routing to the host automatically.

### Thinking mode

Qwen3.5 supports a thinking (reasoning) mode. Disable it for faster, more direct coding responses:

```bash
llama-server -hf unsloth/Qwen3.5-397B-A17B-GGUF:UD-Q4_K_XL \
    --ctx-size 204800 \
    --temp 0.7 \
    --top-p 0.8 \
    --top-k 20 \
    --min-p 0.00 \
    --port 7410 \
    --chat-template-kwargs '{"enable_thinking":false}'
```

## 3. Create a wrapper script

Save as `~/bin/ccc-local`:

```zsh
#!/bin/zsh

export ANTHROPIC_BASE_URL="http://localhost:7410"
export ANTHROPIC_API_KEY="sk-no-key-required"
# export CLAUDE_CODE_ATTRIBUTION_HEADER="1"
export CCC_PROFILE="local-llm"

exec ccc "$@"
```

```bash
chmod +x ~/bin/ccc-local
```

The `local-llm` profile is a **built-in profile** — created automatically on first use.
It sets `CLAUDE_CODE_ATTRIBUTION_HEADER=0` so the attribution header doesn't interfere with local models.

## 4. Run

```bash
ccc-local

# Or inline
CCC_PROFILE=local-llm ANTHROPIC_BASE_URL="http://localhost:7410" ANTHROPIC_API_KEY="sk-no-key-required" ccc
```

## Sampling Parameters

| Flag | Thinking mode | Non-thinking mode | Purpose |
|------|--------------|-------------------|---------|
| `--temp` | `0.6` | `0.7` | Creativity |
| `--top-p` | `0.95` | `0.8` | Nucleus sampling |
| `--top-k` | `20` | `20` | Candidate tokens |
| `--min-p` | `0.00` | `0.00` | Min-p filter (off) |
| `--ctx-size` | up to `262144` | up to `262144` | Context window |

## Profiles vs mise Environments

| Approach | Best for |
|----------|----------|
| Wrapper script (this guide) | Simple, always-on local LLM setup |
| [mise environments](mise-environments.md) | Per-project backend switching (Ollama, Bedrock, Vertex, etc.) |

Both can be combined:

```bash
CCC_PROFILE=local-llm MISE_ENV=llamacpp ccc
```

## Troubleshooting

**Connection refused**
- Check server is running: `curl http://localhost:7410/health`
- Verify port matches `ANTHROPIC_BASE_URL`

**Model not found**
- Use the full path to the `.gguf` file, or set `LLAMA_CACHE` to the parent directory

**Out of memory**
- Reduce `--ctx-size` or use a smaller quantization (`UD-Q3_K_XL` or `UD-Q2_K_XL`)
- Enable GPU offload with `--n-gpu-layers N` to reduce RAM usage
