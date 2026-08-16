# pi-tools

Runs our own skills with a **dedicated model per command** instead of the chat model —
same pattern as `/commit` (pi-commit). Each skill has its own model in `config.json`.

Note: `summerize` is NOT here — it serves the pi chat model via `/skill:summerize`
(see APPEND_SYSTEM), so it stays in `.pi/agent/skills/` and is not a pi-tools command.

## How it works

- `/strip-comments`, `/format-code`, `/wiki-sync`, `/bug-hunt`, `/deduplicate-code`,
  `/security-audit`, `/performance-audit`, `/prune-dead` are extension commands
  (`pi.registerCommand`).
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
  "strip-comments": "deepseek/deepseek-v4-flash",
  "format-code": "deepseek/deepseek-v4-flash",
  "wiki-sync": "deepseek/deepseek-v4-flash",
  "bug-hunt": "pi-cursor/grok-4.6",
  "deduplicate-code": "pi-cursor/grok-4.6",
  "security-audit": "pi-cursor/grok-4.6",
  "performance-audit": "pi-cursor/grok-4.6",
  "prune-dead": "pi-cursor/grok-4.6"
}
```

| Tier | Skills | Model | Notes |
|------|--------|-------|-------|
| Mechanical | strip-comments, format-code, wiki-sync | `deepseek/deepseek-v4-flash` | Fast/cheap |
| Technical | bug-hunt, deduplicate-code, security-audit, performance-audit, prune-dead | `pi-cursor/grok-4.6` | Strong reasoning; Cursor agent tools |

If a configured model is unavailable, pi-tools falls back to the current chat model
with a warning.

## Commands

| Command | What it does |
|---------|----------------|
| `/strip-comments [path...]` | Remove ALL comments in own code; knowledge goes to wiki first |
| `/format-code [path...]` | Formatting and readability in small batches (no logic changes) |
| `/wiki-sync` | Audit local wiki vs code; preserve process/history |
| `/bug-hunt` | High-severity correctness bugs in recent commits |
| `/deduplicate-code` | Consolidate repeated code |
| `/security-audit` | Vulnerabilities, hardening, secrets, API error disclosure |
| `/performance-audit` | SQL, concurrency, memory, I/O, frontend, API latency |
| `/prune-dead` | Dead code (unused imports, orphan exports/files; proof before removal) |

All edits are delivered as working-tree changes — never committed automatically.

## Renamed (2026-08-16)

| Old | New |
|-----|-----|
| `/clean` | `/strip-comments` |
| `/formatter` | `/format-code` |
| `/wiki` | `/wiki-sync` |
| `/bug` | `/bug-hunt` |
| `/duplication` | `/deduplicate-code` |
| `/security` | `/security-audit` |
| `/performance` | `/performance-audit` |
| `/dead` | `/prune-dead` |
