# pi-tools

Runs dedicated models per command (same pattern as `/commit` in pi-commit).
Skill prompts live in `skills/<id>/SKILL.md`. Shared rules live in
`skills/_shared/CONTRACT.md` — injected in front of every prompt.

Commands use the `pi-{category}-{action}` prefix with full words so they group
under `/pi`.

**Language:** prompts and contract in English; chat report in pt-PT; wiki
(`.pi/memory/`) in English. Menu descriptions stay pt-PT.

`summerize` is not here — it serves the chat model via `/skill:summerize`.

Skills are **project-agnostic**. They discover the tree in front of them. They
must not name, special-case, or assume a particular repository. A project that
uses non-conventional script names declares them in `config.json` instead of
growing defaults in this extension.

## Commands

| Command | Skill | What it does |
|---------|-------|----------------|
| `/pi-review [branch [ref]] [path...]` | `review-diff` | Diff-scoped review (correctness, security, perf, duplication) |
| `/pi-audit-bug` | `audit-bug` | Correctness bugs, full tree |
| `/pi-audit-security` | `audit-security` | Reachable vulnerabilities, full tree |
| `/pi-audit-performance` | `audit-perf` | Measurable bottlenecks, full tree |
| `/pi-audit-dependencies` | `audit-deps` | Advisory audit; same-major patches only |
| `/pi-fix-dead-code` | `fix-dead` | Remove code proven unused |
| `/pi-fix-deduplicate` | `fix-dedupe` | One implementation where two exist |
| `/pi-fix-remove-comments [path...]` | `fix-clean` | Remove comments (parser for JS/TS) |
| `/pi-fix-format [path...]` | `fix-format` | Structural style (deepseek-flash); project formatter first if present |
| `/pi-maintain-wiki` | `maintain-wiki` | Wiki vs code in this cwd |

Ownership of overlapping concerns is a table in `CONTRACT.md`. Path arguments
are **scope**, not a feature list. `resume` as the first argument skips the
progress-file reset.

## How a command runs

1. Load `CONTRACT.md` + `SKILL.md`. `{{SKILL_DIR}}` becomes the skill directory.
2. Switch to the model in `config.json` for that skill (`provider/model-id`).
3. Reset `.pi/memory/pages/pi-tools-progress-{skill}.md` unless `resume`.
4. For `/pi-review`, the extension computes the file list and writes it as the
   backlog. The model only changes statuses.
5. For `/pi-fix-format` (unless `resume`), the extension runs the project's
   formatter if one is configured, then starts the model.
6. Send the prompt. Restore the previous model on `agent_end` **and** on error.
   If the model stops with an error (quota, abort) or produces no text, the
   extension reports that the skill did **not** run and skips verification —
   an empty tree is not treated as a completed pass.

## Independent verification

On `agent_end` the extension diffs a working-tree snapshot taken before the
prompt against one taken after. Only paths whose content fingerprint changed
count (mode-only git changes are `0/0` and do not count). It then runs this
project's typecheck/test scripts, if any, and appends a Verification section
the model cannot write.

Default script names: `typecheck` / `type-check`, then `test`, then `format` /
`fmt`. Override in `config.json`:

```json
{
  "scripts": {
    "typecheck": ["types:check"],
    "test": ["test:ci"],
    "format": ["style:fix"]
  }
}
```

A `test` script that starts a watcher will hit the 240s timeout and count as
FAIL — point `config.json` at a non-watching script.

Projects with no package scripts and no `tsconfig.json` get "no verification
available". That is correct, not a missing special case.

## `/pi-review` scope

The extension builds the backlog. Mode-only changes are dropped. Empty scope
does not start the model.

| Invocation | Scope |
|------------|-------|
| `/pi-review` | Uncommitted vs `HEAD`, plus untracked |
| `/pi-review src worker` | The same, limited to those paths |
| `/pi-review branch` | Since merge-base with `origin/HEAD` / `main` / `master` |
| `/pi-review branch origin/dev` | Since merge-base with an explicit ref |

If auto-detection finds no common ancestor (orphan/grafted branch), it asks
for an explicit ref.

Never put in a review backlog: anything under `.pi/`, and lockfiles.

## `/pi-fix-format`

Skill `fix-format` on `deepseek/deepseek-flash`. Closed structural rules (braces,
one statement per line, no chained ternaries, wrap long conditions without
breaking short-circuit). Never changes behaviour.

If this project already has a formatter, the extension runs it **first** (same
detection as before: `format`/`fmt` script, else Prettier config, else Biome).
The model is told not to redo indent/wrapping/quotes. With **no** formatter the
model owns those too — it does not adopt Prettier for the project.

A formatter that fails aborts the command; the model does not start.

## `/pi-fix-remove-comments`

`skills/fix-clean/strip-comments.mjs` walks JS/TS with this project's
`typescript` and removes comment nodes. Functional pragmas stay on a keep list.
Other languages are a model pass with the same keep rules.

```bash
node skills/fix-clean/strip-comments.mjs src
node skills/fix-clean/strip-comments.mjs --write src
node skills/fix-clean/strip-comments.mjs --json src
```

## Config

`config.json` — model per skill:

```json
{
  "fix-clean": "deepseek/deepseek-flash",
  "fix-format": "deepseek/deepseek-flash",
  "maintain-wiki": "deepseek/deepseek-flash",
  "audit-bug": "pi-cursor/grok-4.6",
  "fix-dedupe": "pi-cursor/grok-4.6",
  "audit-security": "pi-cursor/grok-4.6",
  "audit-perf": "pi-cursor/grok-4.6",
  "fix-dead": "pi-cursor/grok-4.6",
  "audit-deps": "pi-cursor/grok-4.6",
  "review-diff": "pi-cursor/grok-4.6"
}
```

Mechanical: `deepseek/deepseek-flash`. Judgement: `pi-cursor/grok-4.6`. No pro,
no vision-exp.

## Deploy

1. Edit here (`pi-modulos/pi-tools/`).
2. Copy to `$PI_CODING_AGENT_DIR/extensions/pi-tools/`.
3. `/reload` in pi.

## Command history

| Era | Pattern | Example |
|-----|---------|---------|
| 2026-08-15 | single word | `/clean`, `/bug` |
| 2026-08-16 | kebab two-word | `/strip-comments`, `/bug-hunt` |
| 2026-08-17 | `pi-{category}-{action}` | `/pi-fix-clean`, `/pi-audit-deps` |
| 2026-08-28 | full words, no abbrev | `/pi-fix-remove-comments` |
| 2026-09-17 | `/pi-review`; `/pi-fix-format` briefly model-free, then restored as skill + optional formatter | |
