# pi-xiaomi

Xiaomi MiMo Token Plan provider for [pi.dev](https://pi.dev). OpenAI-compatible API (Amsterdam endpoint).

## Models

| Id | Notes |
|----|-------|
| `mimo-v2.5-pro` | Reasoning, text |
| `mimo-v2.5` | Reasoning, text + image |
| `mimo-v2-pro` | Reasoning, text |
| `mimo-v2-omni` | Multimodal |
| `mimo-v2-flash` | Fast |

Injects `prompt_cache_key` and `prompt_cache_retention: 24h` per session for cache-friendly workloads.

## Install

```bash
EXT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
mkdir -p "$EXT/pi-xiaomi"
cp extension.ts package.json package-lock.json "$EXT/pi-xiaomi/"
cd "$EXT/pi-xiaomi" && npm install
```

Run `/reload` in pi.

## Auth

```bash
export XIAOMI_API_KEY="your-key"
```

Provider id: `pi-xiaomi`. Enable models as `pi-xiaomi/<id>`.

## Deploy (this monorepo)

Edit `pi-modulos/pi-xiaomi/`, copy to runtime `extensions/pi-xiaomi/`, `/reload`. See root [README](../README.md).
