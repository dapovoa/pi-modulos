# pi-tools

Runs our own skills with a **dedicated model per command** instead of the chat model —
same pattern as `/commit` (pi-commit). Each skill has its own model in `config.json`.

Note: `summerize` is NOT here — it serves the pi chat model via `/skill:summerize`
(see APPEND_SYSTEM), so it stays in `.pi/agent/skills/` and is not a pi-tools command.

## How it works

- `/clean`, `/formatter`, `/wiki`, `/bug`, `/duplication`, `/security`, `/performance`, `/dead` are
  extension commands (`pi.registerCommand`).
- Each command reads the skill's `SKILL.md` from this extension's own
  `skills/<name>/SKILL.md` as the prompt (single source of truth — the skills
  live inside this extension, not in the global skills dir).
- It switches to the model configured for that skill (`pi.setModel`), sends the
  skill prompt as a hidden custom message (`display: false`), and restores the
  previous model on `agent_end`.
- Portability: the agent dir is derived from `import.meta.url` (this extension
  lives at `<agentDir>/extensions/pi-tools/`), never a hardcoded path.

## Deploy workflow

1. Edit here in `pi-modulos/pi-tools/` (source of truth).
2. Copy changed files to `$PI_CODING_AGENT_DIR/extensions/pi-tools/` (or `~/.pi/agent/extensions/pi-tools/`).
3. Run `/reload` in pi.

Never edit the runtime extensions copy without syncing back to `pi-modulos/`.

## Config

`config.json` — model per skill (`provider/model-id`):

```json
{
  "clean": "deepseek/deepseek-v4-flash",
  "formatter": "deepseek/deepseek-v4-flash",
  "wiki": "deepseek/deepseek-v4-flash",
  "bug": "pi-cursor/grok-4.6",
  "duplication": "pi-cursor/grok-4.6",
  "security": "pi-cursor/grok-4.6",
  "performance": "pi-cursor/grok-4.6",
  "dead": "pi-cursor/grok-4.6"
}
```

| Tier | Skills | Model | Notes |
|------|--------|-------|-------|
| Mechanical | clean, formatter, wiki | `deepseek/deepseek-v4-flash` | Fast/cheap |
| Technical | bug, duplication, security, performance, dead | `pi-cursor/grok-4.6` | Strong reasoning; Cursor agent tools |

If a configured model is unavailable, pi-tools falls back to the current chat model
with a warning.

## Commands

- `/clean [path...]` — remove ALL comments in own code (frontend + backend); knowledge goes to wiki
- `/formatter [path...]` — formatting and readability in small batches (no logic changes)
- `/wiki` — audit local wiki vs code, preserve process/history
- `/bug` — high-severity correctness bugs in recent commits
- `/duplication` — consolidate repeated code
- `/security` — vulnerabilities, hardening, secrets
- `/performance` — SQL, concurrency, memory, I/O, frontend, API latency
- `/dead` — dead code detection (unused imports, orphan exports/files; proof before removal)

All edits are delivered as working-tree changes — never committed automatically.
