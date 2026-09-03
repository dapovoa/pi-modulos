---
name: fix-clean
description: Surgically remove comments; JSDoc and //; wiki-first for non-obvious why; never touch code.
use_when: The user wants zero comments in own source code (frontend forbidden; backend also comment-free). Use for incremental tidy or full-repo purge.
guidelines: "1. PROGRESS: pi-tools resets progress file on invoke — fill backlog before Edit. 2. INVENTORY: Grep real comments; one line per file with removable comments. 3. SURGICAL: Read each line in context — comment syntax only, never strings/regex/URLs/CSS. 4. DELETE: //, /* */, /** */ (incl. field JSDoc), # narrative — wiki-first for non-obvious why. 5. PRESERVE: license, /// reference, build placeholders, MSO email markup, vendor. 6. done only after per-file grep; excluded only with line proof. 7. Set status complete in progress file; never delete it."
user-invocable: true
tools: [Read, Edit, Write, Grep, Glob]
last-refreshed: 2026-08-30
---

You are a **surgical** comment-removal automation. Delete comment **syntax** only — never code, strings, or logic. Non-obvious knowledge moves to the wiki first.

**Critical:** `/** ... */` on interface fields, types, functions, and exports **is a comment** in this project — remove it (wiki-first if it carries non-obvious why). Do **not** treat JSDoc as "documentation to keep". Do **not** mark a file `excluded` while removable `//` or `/**` lines remain.

## Skill-specific workflow

**Progress file:** `.pi/memory/pages/pi-tools-progress-fix-clean.md` — reset by pi-tools on each invoke; your work log until the next run.

**Inventory (grep first):**

1. Grep own source for comment candidates under `src/`, `worker/`, `scripts/`, `shared/`, root configs — exclude vendor, generated, ignored dirs.
2. One backlog entry per file that still has **removable** comments after you read the matching lines.
3. Do not inflate inventory with files where every hit is a false positive — but **do** list files like `worker/env.ts`, `pageLayout.ts`, `seed-local-data.ts` when they contain `/**` or `//` narrative.

**Lens:** Per file: read each hit in context → classify → wiki-first for non-obvious why → Edit comment lines only → grep-verify file.

**Exit:** Every entry `done` (edited + verified) or `excluded` (line-level proof). Set progress `status: complete` or `status: incomplete`.

## Progress lifecycle (mandatory)

| Phase | Action |
|-------|--------|
| Start | Progress file already reset — fill **Backlog** before the first Edit. |
| During | After each file: `done` or `excluded` with short note. |
| Complete | `pending` = 0 → set `status: complete` + Summary counts → report `Ficheiro de trabalho: ... (completo)`. |
| Incomplete | Set `status: incomplete` → report `(incompleto, N pending)` → never claim repo clean |

**Forbidden:** Edit before backlog exists; `excluded` without reading the line; `done` without post-edit grep; deleting the progress file; adding progress to `index.md`.

## Surgical removal (read before Edit)

For **every** grep hit, read the full line (and neighbors) and classify:

| Class | Action | Examples |
|-------|--------|----------|
| **Removable comment** | Delete comment syntax only | `// Hoje — ...`, `/** R2 bucket ... */` on a field, `// error shown in summary` |
| **False positive (code)** | `excluded` with line cite | `startsWith('//')`, `replace(/^\//`, `includes('://')`, `'*/*'` in headers, `GLOB 'FR DEMO/*'` in SQL strings |
| **False positive (not comment)** | `excluded` | `#!/bin/bash`, `#root` in CSS selectors, shebangs |
| **Preserve** | `excluded` | `/// <reference`, license header, `/*__PUSH_*__*/` in template strings, MSO `<!--[if !mso]-->`, vendor files |

**Never:**

- Delete a line because it **contains** `//` or `/*` inside a **string** or regex.
- Remove MS Outlook conditional HTML in email templates (functional markup, not narrative).
- Edit `*.generated.ts` or other auto-generated files.
- Strip commented-out **code** blocks without reading — if removing `//` from dead code would leave broken syntax, remove the whole dead statement carefully or mark `blocked` with reason.

**When uncertain** whether a line is comment vs code: read more context; if still uncertain, mark `blocked` and report — **do not** Edit.

## What to delete (own code)

- `//` and `/* */` narrative lines.
- `/** ... */` docblocks on fields, functions, types, exports (including `@deprecated` notes — move gist to wiki if needed).
- Section banners, TODOs, FIXMEs, obvious restatements.
- Commented-out code blocks (remove entire dead block, not half a line).

## What to PRESERVE

1. License headers / SPDX at file top.
2. `/// <reference types="..." />` only.
3. Build placeholders inside strings (e.g. `/*__PUSH_NOTIFICATION_DISPLAY__*/`).
4. Auto-generated files — do not open for comment removal.
5. Vendor / third-party (`public/vendor/`, license headers, bundled code).
6. Functional email HTML conditionals (`<!--[if !mso]-->`, `<!--<![endif]-->`).
7. Never touch: `node_modules/`, `dist/`, `build/`, `.git/`, lockfiles, `.pi/agent/`, etc.

## Wiki-first (non-obvious why only)

Before deleting a why-comment (workaround, SDK quirk, security note):

- `YYYY-MM-DD clean: <file>: <knowledge>` in `.pi/memory/log.md`, or a wiki page for large mappings.
- Obvious section labels (`// Hoje`, `/** Remetente */` restating the field name) need no wiki — just delete.

## How to delete (no ghost lines)

1. Remove **only** comment tokens and the comment text — leave code tokens unchanged on the same line.
2. If the line was **only** a comment, delete the whole line and collapse ghost blanks.
3. One bounded block per Edit (~30-40 lines). Shrink on failure.

## Verification (per file, required for `done`)

After Edit on a file, grep that file for `//`, `/*`, `/**`, narrative `#`. Only preserve-category matches may remain. If removable comments remain, continue editing — do not mark `done`.

## Output

**Coverage:** inventory count; `done` / `excluded` / `blocked` / `pending` (pending must be 0 on complete).

- **Ficheiro de trabalho** — path + `completo` / `incompleto`.
- **Prova** — `git diff --stat` and every edited path (zero edits → line cite per `excluded` file).
- **Files edited** — list every path with edits.
- **Wiki** — entries added (if any).
- **Blocked** — uncertain lines not touched.

Delivered as working-tree changes only — never commit.

**Language:** Follow CONTRACT — chat report in **pt-PT**; wiki/log writes in **English**.
