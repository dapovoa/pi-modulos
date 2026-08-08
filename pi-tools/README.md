# pi-tools

Runs our own skills with a DEDICATED model per command instead of the chat model
- the `/commit` pattern (pi-commit). Mechanical tasks use the cheap/fast model;
technical analysis tasks use the stronger model.

Note: `summerize` is NOT here - it serves the pi chat model via `/skill:summerize`
(see APPEND_SYSTEM), so it stays in `.pi/agent/skills/` and is not a pi-tools command.

## How it works

- `/comments`, `/clean`, `/formatter`, `/wiki`, `/bug`, `/duplication`, `/security` are
  extension commands (`pi.registerCommand`).
- Each command reads the skill's `SKILL.md` from this extension's own
  `skills/<name>/SKILL.md` as the prompt (single source of truth - the skills
  live inside this extension, not in the global skills dir).
- It switches to the model configured for that skill (`pi.setModel`), sends the
  skill prompt as a hidden custom message (`display: false`), and restores the
  previous model on `agent_end`.
- Portability: the agent dir is derived from `import.meta.url` (this extension
  lives at `<agentDir>/extensions/pi-tools/`), never a hardcoded path - the NVME
  stays portable when the user name changes.

## Config

`config.json` - model per skill:

```json
{
  "comments": "deepseek/deepseek-v4-flash",
  "clean": "deepseek/deepseek-v4-flash",
  "formatter": "deepseek/deepseek-v4-flash",
  "wiki": "deepseek/deepseek-v4-flash",
  "bug": "pi-cursor/grok-4.5",
  "duplication": "pi-cursor/grok-4.5",
  "security": "pi-cursor/grok-4.5"
}
```

Mechanical (comments, clean, formatter, wiki) -> deepseek-v4-flash (fast/cheap).
Technical (bug, duplication, security) -> grok-4.5 (strong reasoning).

## Commands

- `/comments [path...]` - run the comments skill (frontend zero-comments, file scope rules)
- `/clean [path...]` - run the clean skill (remove ALL comments in own code, frontend AND backend; knowledge goes to the wiki)
- `/formatter [path...]` - run the formatter skill (clean formatting in small batches)
- `/wiki` - run the wiki skill (audit local wiki vs code, preserve process/history)
- `/bug` - run the bug skill (high-severity correctness bugs in recent commits)
- `/duplication` - run the duplication skill (consolidate repeated code)
- `/security` - run the security skill (vulnerabilities, hardening, secrets)

All edits are delivered as working-tree changes - never committed automatically.
