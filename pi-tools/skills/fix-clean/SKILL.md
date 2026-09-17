---
name: fix-clean
description: Remove all comments from project-owned source using a deterministic codemod; preserve functional pragmas; save non-obvious knowledge to the wiki before deleting.
use_when: Zero comments in project-owned source (frontend and backend). Full repo or a given path.
guidelines: "1. The codemod decides what is a comment — never grep for comment syntax yourself. 2. Read the dry-run BEFORE writing: knowledge worth keeping goes to log.md first. 3. Pragmas are kept by the script, not by your judgement. 4. Non-JS file types are yours to handle manually. 5. complete requires a final dry-run with zero removable comments."
user-invocable: true
tools: [Read, Edit, Write, Grep, Glob, Shell]
last-refreshed: 2026-09-17
---

You remove **all** comments from project-owned source. Comment detection is **not your job** — a
codemod does it with the TypeScript parser, so strings, regexes, templates, JSX text and URLs are
never mistaken for comments. Your job is the part a parser cannot do: deciding what knowledge is
worth saving before it is deleted, and handling file types the codemod does not parse.

## The codemod

```bash
node {{SKILL_DIR}}/strip-comments.mjs [--write] [--json] <path...>
```

- Run it from the **project root** (it resolves the project's own `typescript`).
- Without `--write` it is a **dry run**: it lists every comment it would remove and every comment it
  keeps, with the rule id that kept it.
- Handles `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`. Skips `node_modules`,
  `dist`, `build`, `out`, `coverage`, `.git`, `.astro`, `.wrangler`, `.next`, `vendor`, and files
  marked `@generated` / `auto-generated` / `do not edit`.
- Keeps functional pragmas by rule: TS directives (`/// <reference`, `@ts-ignore`,
  `@ts-expect-error`, `@ts-nocheck`), JSX pragmas (`@jsxImportSource`), linter and formatter
  directives (`eslint-disable`, `prettier-ignore`, `biome-ignore`, `stylelint-disable`), coverage
  markers (`istanbul ignore`), bundler hints (`@__PURE__`, `webpackChunkName`, `@vite-ignore`),
  source maps, shebangs, and licence headers (`/*!`, `SPDX-License-Identifier`, `Copyright`).
- **Do not second-guess the keep list.** If you believe a pragma is missing from it, say so in the
  report and add it to `KEEP_RULES` in the script — do not delete the line by hand.

## Workflow

### Step 1 — Dry run and backlog

Run the codemod without `--write` over the target paths (whole repo when no path was given).
Write the backlog into `.pi/memory/pages/pi-tools-progress-fix-clean.md`: one entry per file that
has removable comments, with the count.

### Step 2 — Read before deleting

Go through the dry-run list. For any comment that records a **non-obvious workaround** — behaviour
that is not visible in the code itself, a platform quirk, the reason an ugly line exists — append
one line to `.pi/memory/log.md` in English before it disappears:

```
YYYY-MM-DD clean: path:line — <fact>
```

Obvious restatements (`/** Sender */` above `FROM_EMAIL`, `// today`) get no wiki entry.
A comment naming an env var or repeating the function name is not knowledge.

### Step 3 — Apply

Run the codemod again with `--write` on the same paths. Mark each backlog entry `done` with the
number of comments removed.

### Step 4 — File types the codemod does not parse

`.css`, `.scss`, `.py`, `.sh`, `.html`, `.astro`, `.vue`, `.svelte`, `.sql`, `.yml` are **yours**.
Read each file and remove comments by hand, with the same principles:

- Keep the same pragma classes (`stylelint-disable`, `# noqa`, `# type: ignore`, `# fmt: off`,
  `<!-- prettier-ignore -->`, `#!` shebangs, licence headers).
- Keep markup that only looks like a comment: `<!--[if !mso]-->` / `<!--<![endif]-->` conditionals
  in e-mail templates, build placeholders inside strings or templates.
- `#` is a comment in `.py`/`.sh`/`.yml`, never in `.css` — do not touch CSS ids or selectors.
- One backlog entry per file, same `done` / `blocked` / `excluded` rules.

### Step 5 — Complete gate

`status: complete` requires **all** of:

- a final dry run over the same paths reporting **zero** removable comments in parsed file types;
- every backlog entry `done`, `blocked`, or `excluded` with a reason;
- for non-parsed file types, a read-based pass on each backlog file.

If a file is `blocked` (commented-out code you cannot safely delete, ambiguous markup), leave it
with the line number and the reason. Do not force a partial edit.

## Commented-out code

The codemod removes the comment tokens it finds. A commented-out **block of dead code** is a
different problem: delete the whole statement or block, not half of it. When the boundaries are not
obvious, mark the file `blocked` with the line range instead of guessing.

## Output (pt-PT chat report)

1. **Cobertura** — files in backlog; done / excluded / blocked / pending
2. **Ações** — comments removed per file, split between codemod and manual pass
3. **Prova** — final dry-run output (zero removable) and `git diff --stat`
4. **Pragmas preservados** — what the keep list held back, by rule
5. **Ficheiro de trabalho** — path + `completo` / `incompleto`
6. **Wiki** — lines appended to `log.md`
7. **Blocked** — files and reasons

Never commit. Wiki and `log.md` in English per CONTRACT.
