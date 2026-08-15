# pi-qwencloud

Alibaba DashScope (international) provider for [pi.dev](https://pi.dev). OpenAI-compatible endpoint.

## Models

Qwen 3.x (Max, Plus, Flash, Coder), QWQ-Plus, DeepSeek V4 Pro/Flash, DeepSeek V3.2, GLM-5.1, MiniMax M2.5.

Provider id: `pi-qwencloud`. Enable models as `pi-qwencloud/<model-id>` in `settings.json`.

## Install

```bash
EXT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
mkdir -p "$EXT/pi-qwencloud"
cp extension.ts "$EXT/pi-qwencloud/index.ts"
```

Run `/reload` in pi.

## Auth

DashScope API key in agent `auth.json` for provider `pi-qwencloud` (placeholder: `sk-pi-qwencloud`).

## Deploy (this monorepo)

Edit `pi-modulos/pi-qwencloud/`, copy to runtime `extensions/pi-qwencloud/`, `/reload`. See root [README](../README.md).
