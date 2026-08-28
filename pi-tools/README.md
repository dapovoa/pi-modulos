# pi-tools

Runs our own skills with a **dedicated model per command** instead of the chat model —
same pattern as `/commit` (pi-commit). Each skill has its own model in `config.json`.

Commands use the **`pi-{category}-{action}`** prefix with **full words** (no abbreviations)
so they group in autocomplete (`/pi`) and read clearly in the menu.

Note: `summerize` is NOT here — it serves the pi chat model via `/skill:summerize`
(see APPEND_SYSTEM), so it stays in `.pi/agent/skills/` and is not a pi-tools command.

## How it works

- Extension commands (`pi.registerCommand`), alphabetical:

  `/pi-audit-bug`, `/pi-audit-dependencies`, `/pi-audit-performance`, `/pi-audit-security`,
  `/pi-fix-dead-code`, `/pi-fix-deduplicate`, `/pi-fix-format`, `/pi-fix-remove-comments`,
  `/pi-maintain-wiki`

- Each command reads the skill's `SKILL.md` from `skills/<skill-id>/SKILL.md` as the prompt.
- It switches to the model configured for that skill (`pi.setModel`), sends the
  skill prompt as a hidden custom message (`display: false`), and restores the
  previous model on `agent_end`.

## Deploy workflow

1. Edit here in `pi-modulos/pi-tools/` (source of truth).
2. Copy changed files to `$PI_CODING_AGENT_DIR/extensions/pi-tools/`.
3. Run `/reload` in pi.

Never edit the runtime extensions copy without syncing back to `pi-modulos/`.

## Config

`config.json` — model per skill (`provider/model-id`):

```json
{
  "fix-clean": "deepseek/deepseek-v4-flash",
  "fix-format": "deepseek/deepseek-v4-flash",
  "maintain-wiki": "deepseek/deepseek-v4-flash",
  "audit-bug": "pi-cursor/grok-4.6",
  "fix-dedupe": "pi-cursor/grok-4.6",
  "audit-security": "pi-cursor/grok-4.6",
  "audit-perf": "pi-cursor/grok-4.6",
  "fix-dead": "pi-cursor/grok-4.6",
  "audit-deps": "pi-cursor/grok-4.6"
}
```

| Category | Commands | Model |
|----------|----------|-------|
| **fix** (mechanical) | `pi-fix-remove-comments`, `pi-fix-format` | `deepseek/deepseek-v4-flash` |
| **fix** (technical) | `pi-fix-deduplicate`, `pi-fix-dead-code` | `pi-cursor/grok-4.6` |
| **audit** | `pi-audit-bug`, `pi-audit-security`, `pi-audit-performance`, `pi-audit-dependencies` | `pi-cursor/grok-4.6` |
| **maintain** | `pi-maintain-wiki` | `deepseek/deepseek-v4-flash` |

## Commands

| Command | What it does |
|---------|----------------|
| `/pi-audit-bug` | High-severity correctness bugs |
| `/pi-audit-dependencies` | Supply chain: npm audit, CVE report (advisory) |
| `/pi-audit-performance` | SQL, latency, memory, bundle |
| `/pi-audit-security` | Vulnerabilities, secrets, API error disclosure |
| `/pi-fix-dead-code` | Dead code (proof before removal) |
| `/pi-fix-deduplicate` | Consolidate repeated code |
| `/pi-fix-format [path...]` | Formatting in small batches (no logic changes) |
| `/pi-fix-remove-comments [path...]` | Remove ALL comments; knowledge → wiki first |
| `/pi-maintain-wiki` | Audit wiki vs code |

All edits are delivered as working-tree changes — never committed automatically.

## Command history

| Era | Pattern | Example |
|-----|---------|---------|
| 2026-08-15 | single word | `/clean`, `/bug` |
| 2026-08-16 | kebab two-word | `/strip-comments`, `/bug-hunt` |
| 2026-08-17 | `pi-{category}-{action}` | `/pi-fix-clean`, `/pi-audit-deps` |
| 2026-08-28 | full words, no abbrev | `/pi-fix-remove-comments`, `/pi-audit-dependencies` |
