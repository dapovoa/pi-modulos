# pi-tools

Runs our own skills with a **dedicated model per command** instead of the chat model —
same pattern as `/commit` (pi-commit). Each skill has its own model in `config.json`.

Commands use the **`pi-{category}-{action}`** prefix with **full words** (no abbreviations)
so they group in autocomplete (`/pi`) and read clearly in the menu.

All skills share **`skills/_shared/CONTRACT.md`** (injected into every prompt): inventory,
backlog in `.pi/memory/pages/pi-tools-progress-{skill}.md`, full coverage before "clean",
progress file reset on each invoke (proof of last run until next). Optional `resume` arg skips reset.

**Language:** Skill prompts and contract in **English**; final chat report in **pt-PT**;
wiki (`.pi/memory/`) writes in **English** for model consumption. Pi menu descriptions stay pt-PT.

Note: `summerize` is NOT here — it serves the pi chat model via `/skill:summerize`
(see APPEND_SYSTEM), so it stays in `.pi/agent/skills/` and is not a pi-tools command.

## How it works

- Extension commands (`pi.registerCommand`), alphabetical:

  `/pi-audit-bug`, `/pi-audit-dependencies`, `/pi-audit-performance`, `/pi-audit-security`,
  `/pi-fix-dead-code`, `/pi-fix-deduplicate`, `/pi-fix-format`, `/pi-fix-remove-comments`,
  `/pi-maintain-wiki`, `/pi-review`

- `/pi-fix-format` invokes **no model at all** — see Deterministic tier.
- Each other command reads the skill's `SKILL.md` from `skills/<skill-id>/SKILL.md` as the prompt.
  `{{SKILL_DIR}}` in the body is replaced with the skill's absolute directory, so skills can
  reference their own helper scripts wherever the extension is installed.
- It switches to the model configured for that skill (`pi.setModel`), sends the
  skill prompt as a hidden custom message (`display: false`), and restores the
  previous model on `agent_end` — and also on the error path, so a failed command never
  leaves the session on the skill's model.

## Independent verification

The model does not get to declare its own run successful. On `agent_end` the extension:

1. diffs a working-tree snapshot against one taken before the prompt was sent, so only what **this
   run** touched counts, split into source vs `.pi/memory/`. The fingerprint comes from
   `git diff HEAD --numstat` plus untracked paths; mode-only changes report `0/0` and are therefore
   identical in both snapshots — on `agenda`, 144 of its 182 dirty paths are mode-only and must not
   be attributed to a skill;
2. runs the project's `typecheck` (or `tsc --noEmit` when there is a `tsconfig.json`) and `test`
   scripts via `pi.exec` when source files changed;
3. appends a **Verification** section to `pi-tools-progress-{skill}.md` with `pass` / `FAIL` per
   check and the failure tail;
4. notifies the result — including the case where a fix skill changed **nothing**.

This replaces model self-reporting for the parts that can be checked mechanically.

Scripts are picked by name: `typecheck` / `type-check`, then `test` / `test:unit`. A `test` script
that starts a watcher (bare `vitest`, `jest --watch`) will run to the 240 s timeout and be reported
as `FAIL (timeout)` — give such projects a non-watching `test` script or rename the watcher.

## Deploy workflow

1. Edit here in `pi-modulos/pi-tools/` (source of truth).
2. Copy changed files to `$PI_CODING_AGENT_DIR/extensions/pi-tools/`.
3. Run `/reload` in pi.

Never edit the runtime extensions copy without syncing back to `pi-modulos/`.

## Config

`config.json` — model per skill (`provider/model-id`):

```json
{
  "fix-clean": "deepseek/deepseek-flash",
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

| Category | Commands | Model |
|----------|----------|-------|
| **fix** (mechanical) | `pi-fix-remove-comments` | `deepseek/deepseek-flash` |
| **fix** (technical) | `pi-fix-deduplicate`, `pi-fix-dead-code` | `pi-cursor/grok-4.6` |
| **audit** | `pi-audit-bug`, `pi-audit-security`, `pi-audit-performance`, `pi-audit-dependencies` | `pi-cursor/grok-4.6` |
| **review** | `pi-review` | `pi-cursor/grok-4.6` |
| **maintain** | `pi-maintain-wiki` | `deepseek/deepseek-flash` |
| **deterministic** | `pi-fix-format` | none (runs the project's formatter) |

**Allowed models (pi-tools):** `deepseek/deepseek-flash` (mechanical) and `pi-cursor/grok-4.6` (technical). No pro, no vision-exp.

## Commands

| Command | What it does |
|---------|----------------|
| `/pi-review [branch [ref]] [path...]` | **Default review pass.** Only what changed, four lenses |
| `/pi-audit-bug` | High-severity correctness bugs (full-repo sweep) |
| `/pi-audit-dependencies` | Gatekeeper CVE: audit + patches seguros; majors → migração à parte |
| `/pi-audit-performance` | SQL, latency, memory, bundle (full-repo sweep) |
| `/pi-audit-security` | Vulnerabilities, secrets, API error disclosure (full-repo sweep) |
| `/pi-fix-dead-code` | Dead code (proof before removal) |
| `/pi-fix-deduplicate` | Consolidate repeated code |
| `/pi-fix-format` | Runs the project's configured formatter; no model |
| `/pi-fix-remove-comments [path...]` | Remove ALL comments; knowledge → wiki first |
| `/pi-maintain-wiki` | Audit wiki vs code |

## Scope: review the diff, sweep only on purpose

`/pi-review` is the command to reach for. A per-category full-repo sweep does not converge — a
200-entry backlog never finishes in one session, which is what `resume` and `status: incomplete`
exist to manage. A diff always finishes, and it is where fresh bugs are.

The **extension computes the scope and writes the backlog** into the progress file, so the model
cannot invent, widen or shrink the inventory:

| Invocation | Scope |
|------------|-------|
| `/pi-review` | Uncommitted changes vs `HEAD`, plus untracked files |
| `/pi-review src worker` | The same, limited to those paths |
| `/pi-review branch` | Commits since the merge-base with `origin/HEAD` / `main` / `master` |
| `/pi-review branch origin/react` | Commits since the merge-base with an explicit ref |

Mode-only changes (`0/0` in `--numstat`) are dropped — there is nothing to review in a permission
bit. On `agenda` that is the difference between a 182-file backlog and the 38 files that actually
changed. When the scope is empty the command says so and **never starts the model**.

If `branch` cannot find a base with a common ancestor it says so and asks for an explicit ref;
`agenda`'s `react` branch has unrelated history to `origin/main`, so it needs
`/pi-review branch origin/react`.

The four audit skills remain for deliberate, whole-repo passes on one domain.

## Deterministic tier

Work that a tool does exactly should not be given to a model. Two things moved out:

**Formatting** — `/pi-fix-format` runs the project's own formatter via `pi.exec` and reports how many
files changed. No prompt, no tokens, no risk of a "formatter" editing logic. It looks for a `format`
(or `fmt`) npm script, then a prettier config, then a biome config. With **none of those** it refuses:
adopting a formatter rewrites every file in the repo, and that is the user's decision. Today only
`signaldesk` qualifies (`npm run format`); `agenda` and `dinaferreira` have no formatter configured.

Note this leaves a real gap: prettier normalises whitespace and wrapping, but it does **not** add
braces to single-line `if`s, split long boolean chains, or flag deep nesting and long functions.
Those code-style rules currently have no owner.

**Comment removal** — `skills/fix-clean/strip-comments.mjs` parses each file
with the project's own TypeScript and removes comment nodes, so strings, regexes, templates, JSX
text and URLs are never misread as comments, and functional pragmas (`@ts-ignore`,
`eslint-disable`, `@jsxImportSource`, `webpackChunkName`, source maps, licence headers) are kept by
an explicit `KEEP_RULES` allowlist:

```bash
node skills/fix-clean/strip-comments.mjs src worker        # dry run
node skills/fix-clean/strip-comments.mjs --write src       # apply
node skills/fix-clean/strip-comments.mjs --json src        # machine-readable
```

The model's remaining job in `fix-clean` is the part a parser cannot do: saving non-obvious
knowledge to `log.md` before deletion, and handling file types the codemod does not parse
(`.css`, `.py`, `.sh`, `.html`, `.astro`, `.vue`, `.svelte`, `.sql`, `.yml`).

All edits are delivered as working-tree changes — never committed automatically.

## Command history

| Era | Pattern | Example |
|-----|---------|---------|
| 2026-08-15 | single word | `/clean`, `/bug` |
| 2026-08-16 | kebab two-word | `/strip-comments`, `/bug-hunt` |
| 2026-08-17 | `pi-{category}-{action}` | `/pi-fix-clean`, `/pi-audit-deps` |
| 2026-08-28 | full words, no abbrev | `/pi-fix-remove-comments`, `/pi-audit-dependencies` |
| 2026-09-17 | diff scope + deterministic tier | `/pi-review`; `/pi-fix-format` lost its model and its `SKILL.md` |
