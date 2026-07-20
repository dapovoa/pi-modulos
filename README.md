# Pi Modules

Collection of extensions for the [pi.dev](https://pi.dev) coding agent CLI — custom providers, tools, and safeguards.

## Modules

| Module | Type | Description |
|---|---|---|
| `pi-block` | Guard | Blocks dangerous shell commands and sensitive file reads with interactive confirmations |
| `pi-code` | Provider | Command Code API provider with git-aware context injection |
| `pi-commit` | Tool | Generates Conventional Commits from staged diffs using any configured model |
| `pi-cursor` | Provider | Cursor SDK provider with agent session management, hang detection, and auto-retry |
| `pi-kimi` | Provider | Kimi API provider with streaming, thinking, and tool call support |
| `pi-mistral` | Provider + Tools | Mistral AI provider + `mistral_ocr` and `mistral_fim` tools |
| `pi-nvidia` | Provider | Nvidia NIM provider with 10 models (Nemotron, Gemma, Kimi, DeepSeek, Qwen, etc.) |
| `pi-qwencloud` | Provider | Qwen Cloud provider with 13 models (Qwen3.7 Max, DeepSeek V4, GLM-5.1, etc.) |
| `pi-xiaomi` | Provider | Xiaomi MiMo Token Plan provider with explicit prompt cache key injection |

## Setup

Each module is a standalone extension. Copy it to `~/.pi/agent/extensions/` or symlink:

```bash
ln -s $(pwd)/pi-mistral ~/.pi/agent/extensions/pi-mistral
```

Requires pi.dev CLI with extension support.
