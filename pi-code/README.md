# pi-code

[Command Code](https://commandcode.ai) provider for pi. Models are fetched from the API on startup (open-source and premium on Pro plan).

## Install

```bash
EXT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
mkdir -p "$EXT/pi-code"
cp index.ts package.json package-lock.json "$EXT/pi-code/"
cd "$EXT/pi-code" && npm install
```

## Auth

Set your API key via environment or pi login:

```bash
export COMMANDCODE_API_KEY="your-key"
```

Or in pi: `/login` → API key → Command Code.

Stored in agent `auth.json` under the `pi-code` provider entry.

## Deploy (this monorepo)

Edit `pi-modulos/pi-code/`, copy to runtime `extensions/pi-code/`, `/reload`. See root [README](../README.md).
