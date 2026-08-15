# pi-block

Guard extension for [pi.dev](https://pi.dev). Blocks dangerous shell commands and sensitive file reads. Works with Cursor hooks (`.cursor/hooks/`) when the project includes them.

## Commands

- `/block` — enable blocking (default on startup)
- `/unblock` — temporarily disable blocking for the session

Writes state to `.pi/pi-block-state.json` in the project cwd so hooks can read it.

## Blocked patterns (examples)

- Destructive git: `push`, `commit`, `reset --hard`, `clean`, …
- Destructive shell: `rm -rf`, `sudo`, `chmod 777`, `dd`, `mkfs`, …
- Pipe-to-shell: `curl|sh`, `wget|sh`
- Sensitive paths: `.ssh/`, `.env`, credentials, `auth.json`, …

## Install

```bash
EXT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
mkdir -p "$EXT/pi-block"
cp extension.ts "$EXT/pi-block/index.ts"
```

Run `/reload` in pi.

## Deploy (this monorepo)

Edit `pi-modulos/pi-block/`, copy to your runtime `extensions/pi-block/`, `/reload`. See root [README](../README.md).
