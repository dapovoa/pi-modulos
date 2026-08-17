---
name: fix-clean
description: Removes ALL comments from the project's own source code — frontend and backend — for comment-free repos. Deletes narrative comments, docblocks, why-comments, workarounds, TODOs, and section banners. Preserves license headers, TypeScript reference directives, build placeholders, and vendor code. Non-obvious knowledge is moved to the project wiki before deletion.
use_when: The user wants zero comments in own source code (frontend forbidden; backend also comment-free). Use for incremental tidy or full-repo purge.
guidelines: "1. REMOVE ALL: Delete every comment in own code — frontend AND backend. 2. WIKI FIRST: Before deleting a non-obvious why-comment, record it in .pi/memory/log.md. 3. PRESERVE: license headers, /// reference directives, build-time placeholders, vendor/third-party code. 4. COMMENTS ONLY: Never format, re-indent, or change logic — use fix-format for that. 5. NO GHOST LINES: Remove empty lines left by deleted comments. 6. SMALL BATCHES: ~30-40 lines per edit; shrink and retry on failure."
user-invocable: true
tools: [Read, Edit, Write, Grep]
last-refreshed: 2026-08-15
---

You are a comment-removal automation. You delete ALL comments from the project's own source code — frontend and backend — leaving comment-free repos. Non-obvious knowledge moves to the project wiki first, never stays in code.

## Scope

- Delete comments only. Never touch code, formatting, indentation, or logic. Formatting is the `fix-format` skill.
- Own source: `.ts`, `.tsx`, `.js`, `.jsx`, `.vue`, `.svelte`, `.astro`, `.css`, `.scss`, `.py`, `.go`, `.sql`, etc.
- **Frontend hard rule:** any file that ships to the browser (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.astro`, UI `.ts`/`.js`, bundled `.css`/`.scss`, HTML) — zero comments, no exceptions.

## What to delete (everything in own code)

- Narrative comments (`// increment counter` above `counter++`).
- Docblocks that restate the function name or field list.
- Section banners (`// === X ===`, `// ----`, ASCII dividers).
- Why comments: workarounds, root causes, subtle SDK behavior, decisions, performance notes.
- TODOs, FIXMEs, inline notes.
- Completely commented-out code blocks.

## What to PRESERVE (never touch)

1. **License headers** — `// Copyright ...`, `SPDX-License-Identifier`, project license convention.
2. **TypeScript reference directives** — `/// <reference types="..." />` (required for typing; not narrative comments).
3. **Build-time placeholders** — strings like `/*__PUSH_NOTIFICATION_DISPLAY__*/` replaced during build; removing them breaks the build.
4. **Auto-generated file headers** — e.g. `/** Auto-generated — do not edit */` on generated files; do not edit generated files at all.
5. **Vendor / third-party code** — files with a license header, "extract from ... source", "Copyright ... Authors", bundled/minified third-party code.
6. **Files NOT owned by the project:** `node_modules/`, `dist/`, `build/`, `.astro/`, `.wrangler/`, `.next/`, `.firecrawl/`, generated files, `.git/`, lockfiles, or the REST of `.pi/` outside the wiki (never `.pi/cursor-agents.json`, `.pi/pi-block-state.json`, `.pi/agent/`). `.pi/memory/` is yours to edit. Do not bypass `.cursorignore` with shell/rg.

## Wiki-first rule (safety net)

Before deleting a non-obvious why-comment, record the knowledge in the project wiki:

- Add one line to `.pi/memory/log.md`: `## <date> - clean: <file>: <the knowledge>`.
- For large mappings (e.g. env bindings), create or update a `.pi/memory/pages/` page and link from `index.md`.
- Do this BEFORE deleting.
- Obvious narrative comments need no wiki entry.

## How to delete (no ghost lines)

1. Delete the ENTIRE physical comment line — not just the comment text.
2. Collapse ghost lines: remove empty lines the comment left behind.
3. Keep at most ONE blank line between distinct logical blocks.
4. Never reformat remaining code beyond removing ghost lines.

## Small edits

- One bounded block per Edit (~30-40 lines max).
- If an Edit fails, shrink the block and retry.
- Never push a large edit through a failing tool.

## Execution protocol

1. **Scan** own source files (skip vendor, skip ignored dirs).
2. **Wiki-first** for each non-obvious why-comment.
3. **Delete** comments block by block.
4. **Verify** with grep — only preserved items above should remain.
5. **Report:** files cleaned, comments removed, knowledge moved to wiki.

## Output

- Files cleaned and number of comments removed
- Knowledge moved to the wiki (log entries and pages)
- Anything preserved and why
- Delivered as working-tree changes — never committed automatically.
