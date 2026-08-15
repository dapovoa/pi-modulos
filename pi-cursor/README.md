# pi-cursor

Cursor provider for [pi.dev](https://pi.dev). Uses `@cursor/sdk` for local agent execution with Cursor-hosted models (Composer, Grok, Gemini, etc.).

## Install

```bash
EXT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
mkdir -p "$EXT/pi-cursor"
cp index.ts package.json package-lock.json "$EXT/pi-cursor/"
cd "$EXT/pi-cursor" && npm install
```

Run `/reload` in pi.

## Auth

Add an API key to your pi agent `auth.json` (path: `$PI_CODING_AGENT_DIR/auth.json` or `~/.pi/agent/auth.json`):

```json
{
  "pi-cursor": { "type": "api_key", "key": "YOUR_CURSOR_API_KEY" }
}
```

Keys: [cursor.com/dashboard/api](https://cursor.com/dashboard/api)

Enable models in `settings.json` (`enabledModels`), e.g. `pi-cursor/composer-2.5`.

## Features

- Agent session management and streaming
- Hang detection and auto-retry
- Model catalog from Cursor API (`cursor-models.json` cache)
- Project Cursor rules: copies `rules/*.mdc` to `<cwd>/.cursor/rules/` on session start
- E2E probes: `e2e-sdk.mjs`, `watchdog-auth.sh`

## Deploy (this monorepo)

Source of truth: `pi-modulos/pi-cursor/`. Copy changed files to runtime `extensions/pi-cursor/`, `npm install` if deps changed, `/reload`. Include `rules/*.mdc` when style/behavior rules change — they sync to each project on next pi session start.
