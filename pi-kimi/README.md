# pi-kimi

Moonshot Kimi API provider for [pi.dev](https://pi.dev). Direct HTTP to `api.kimi.com/coding/v1` with streaming, thinking, tools, and images.

## Model

- `kimi-k2.6` — Kimi K2.6 (reasoning, text + image, 262K context)

## Install

```bash
EXT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
mkdir -p "$EXT/pi-kimi"
cp extension.ts package.json package-lock.json "$EXT/pi-kimi/"
cd "$EXT/pi-kimi" && npm install
```

Run `/reload` in pi.

## Auth

Configure a Kimi API key in agent `auth.json` for provider `pi-kimi` (placeholder key id: `sk-pi-kimi`), or use pi `/login` if supported.

## Deploy (this monorepo)

Edit `pi-modulos/pi-kimi/`, copy to runtime `extensions/pi-kimi/`, `/reload`. See root [README](../README.md).
