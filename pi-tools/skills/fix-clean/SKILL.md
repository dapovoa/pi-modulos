---
name: fix-clean
description: Remove comments from project-owned source. A parser handles JS/TS; you save non-obvious knowledge and handle other file types.
---

You remove **all comments** from project-owned source. Comment detection for JS/TS is **not your job** — the codemod uses the TypeScript parser, so strings, regexes, templates, JSX text and URLs are never mistaken for comments.

Your job: save knowledge a parser cannot judge, then handle file types the codemod does not parse.

## KEEP (closed — do not delete)

The codemod keeps these by rule id. Do not second-guess them. If a needed pragma is missing, report it and add a `KEEP_RULES` entry in the script — do not delete the line by hand.

- shebang
- TS directives and pragmas (`/// <reference`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`)
- JSX pragmas (`@jsxImportSource`)
- linter/formatter directives (eslint, stylelint, oxlint, biome, dprint, prettier)
- coverage markers, bundler hints, source maps
- licence headers (`/*!`, SPDX, Copyright)

On file types you handle by hand, keep the same classes (`# noqa`, `# type: ignore`, `# fmt: off`, `<!-- prettier-ignore -->`, shebangs, licence headers) plus markup that only looks like a comment (`<!--[if !mso]-->` conditionals, build placeholders inside strings).

## OUT OF SCOPE

- File scope in the CONTRACT (install, build, generated, vendor, lockfiles, `.pi/` except `log.md` as below).
- Code. If removing comment tokens would leave broken syntax, delete the whole dead statement or mark `blocked` with the line range. Do not guess.

## Inventory

Path arguments from the command are the target; otherwise the project root.

## Workflow

### 1 — Dry run

```bash
node {{SKILL_DIR}}/strip-comments.mjs [--json] <path...>
```

Run from the project root (it loads this project's `typescript`). One backlog entry per file with removable comments, with the count.

If `typescript` is not resolvable, skip the codemod: every JS/TS file in scope becomes a manual-pass entry. Do not invent a parser.

### 2 — Knowledge first

For a comment that records a **non-obvious workaround** (behaviour not visible in the code, a platform quirk, why an ugly line exists), append one English line to `.pi/memory/log.md` before it disappears:

```
YYYY-MM-DD clean: path:line — <fact>
```

Restatements (`/** Sender */` above `FROM_EMAIL`) get no wiki line.

### 3 — Apply

```bash
node {{SKILL_DIR}}/strip-comments.mjs --write <path...>
```

Mark each parsed-file entry `done` with how many comments were removed.

### 4 — File types the codemod does not parse

Anything not in `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` is yours: stylesheets, Python, shell, HTML, SQL, YAML, and any template/component format the tree uses.

Read each file. Remove comments. Same KEEP rules. `#` is a comment in Python/shell/YAML, never in CSS — do not touch CSS ids or selectors.

One backlog entry per file.

### 5 — Complete gate

All of:

- final dry run on the same paths reports **zero** removable comments for parsed types (or every JS/TS file was a completed manual pass because typescript was missing);
- every backlog entry `done`, `blocked`, or `excluded` with a KEEP/OUT rule;
- each non-parsed backlog file was read.

## Output extras (pt-PT)

- Split actions between codemod and manual pass.
- List pragmas kept, by rule id.
- Quote the final dry-run summary (zero removable).
- Wiki lines appended to `log.md`.
