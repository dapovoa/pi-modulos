# pi-cursor

Cursor provider extension for [pi.dev](https://pi.dev). Uses `@cursor/sdk` for local agent execution with Cursor hosted models.

## Install

Copy `index.ts`, `package.json`, and `package-lock.json` into `.pi/agent/extensions/pi-cursor/` on the NVME pi install, then run:

```bash
cd ~/.pi/agent/extensions/pi-cursor && npm install
```

## Auth

Add to `.pi/agent/auth.json`:

```json
{
  "pi-cursor": { "type": "api_key", "key": "your-key" }
}
```

Get a key at https://cursor.com/dashboard/api

## Source of truth

Canonical source: `pi-modulos/pi-cursor/` on the NVME drive.

Deployed runtime copy: `.pi/agent/extensions/pi-cursor/`.

Wiki: `.pi/memory/pages/cursor-provider.md` at the NVME root.
