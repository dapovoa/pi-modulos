# pi-mistral

Mistral AI provider and tools for [pi.dev](https://pi.dev).

## Provider

Chat models discovered from the Mistral API (static catalog on startup, background refresh). Provider id: `mistral`.

## Tools

| Tool | Model | Purpose |
|------|-------|---------|
| `mistral_ocr` | `mistral-ocr-latest` | Extract text from images, scans, screenshots, PDFs |
| `mistral_fim` | `codestral-latest` | Fill-in-the-middle code completion |

## Install

```bash
EXT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
mkdir -p "$EXT/pi-mistral"
cp index.ts package.json package-lock.json "$EXT/pi-mistral/"
cd "$EXT/pi-mistral" && npm install
```

Run `/reload` in pi.

## Auth

```bash
export MISTRAL_API_KEY="your-key"
```

Or configure in agent `auth.json` for provider `mistral`.

## Deploy (this monorepo)

Edit `pi-modulos/pi-mistral/`, copy to runtime `extensions/pi-mistral/`, `/reload`. See root [README](../README.md).
