# pi-nvidia

[Nvidia NIM](https://build.nvidia.com) provider for [pi.dev](https://pi.dev). OpenAI-compatible API at `integrate.api.nvidia.com`.

## Models

| Id | Name |
|----|------|
| `nemotron-3-ultra` | Nemotron-3-Ultra |
| `gemma-4-31b` | Gemma-4-31B |
| `kimi-k2.6` | Kimi-K2.6 |
| `step-3.7-flash` | Step-3.7-Flash |
| `glm-5.1` | GLM-5.1 |
| `mistral-large-3` | Mistral-Large-3 |
| `minimax-m2.7` | MiniMax-M2.7 |
| `gpt-oss-120b` | GPT-OSS-120B |
| `qwen3-coder` | Qwen3-Coder |
| `deepseek-v4-flash` | DeepSeek-V4-Flash |

Enable in `settings.json` as `pi-nvidia/<id>`.

## Install

```bash
EXT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
mkdir -p "$EXT/pi-nvidia"
cp index.ts "$EXT/pi-nvidia/index.ts"
```

Run `/reload` in pi.

## Auth

Nvidia API key in agent `auth.json` for provider `pi-nvidia` (placeholder: `sk-pi-nvidia`). Get a key at [build.nvidia.com](https://build.nvidia.com).

## Deploy (this monorepo)

Edit `pi-modulos/pi-nvidia/`, copy to runtime `extensions/pi-nvidia/`, `/reload`. See root [README](../README.md).
