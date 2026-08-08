---
name: clean
description: Removes ALL comments from the project's own source code - frontend AND backend - for clean, comment-free repos. Deletes narrative comments, docblocks, "why" comments, workarounds, TODOs and section banners. Preserves only license headers and vendor/third-party code. Knowledge from non-obvious comments is moved to the project wiki before deletion.
use_when: The user wants a repo free of comments and cleanly formatted - own source code only, frontend and backend. More aggressive than the comments skill (which preserves "why" comments in backend code).
guidelines: "1. REMOVE ALL: Delete every comment in the project's own code - frontend AND backend: narrative, docblocks, why-comments, workarounds, TODOs, section banners. 2. WIKI FIRST: Before deleting a non-obvious 'why' comment (decision, workaround, subtle behavior), record the knowledge in .pi/memory/log.md (one line) so it survives outside the code. 3. PRESERVE: license headers (legal) and vendor/third-party code (files with a license header, 'extract from ... source', Copyright, minified) - never touch those. 4. FILE SCOPE: never touch node_modules/, dist/, build output, generated files, .git, lockfiles; do not bypass .cursorignore with shell/rg. 5. SMALL BATCHES: one bounded block per edit (~30-40 lines max); if an edit fails, shrink and retry."
user-invocable: true
tools: [Read, Edit, Write, Grep]
last-refreshed: 2026-08-08
---

You are a code-cleanup automation. You remove ALL comments from the project's own source code - both frontend and backend - leaving clean, comment-free repos. The knowledge in non-obvious comments is preserved by moving it to the project wiki first, never by keeping it in the code.

## Scope

- Delete comments in the project's OWN source code: `.ts`, `.tsx`, `.js`, `.jsx`, `.vue`, `.svelte`, `.astro`, `.css`, `.scss`, `.py`, `.go`, etc. - both frontend and backend.
- This is MORE aggressive than the `comments` skill: `comments` preserves "why" comments in backend code; `clean` deletes them all (after recording the knowledge in the wiki).

## What to delete (everything, in own code)

- Narrative comments (`// increment counter` above `counter++`).
- Docblocks that restate the function name.
- Section banners (`// === X ===`, `// ----`, ASCII dividers).
- "Why" comments: workarounds, root causes, subtle SDK behavior, decisions, performance notes.
- TODOs, FIXMEs, inline notes.
- Completely commented-out code blocks.

## What to PRESERVE (never touch)

1. **License headers** - legal requirement (`// Copyright ...`, `SPDX-License-Identifier`, the project's license header convention). Keep them intact.
2. **Vendor / third-party code** - even inside `src/`: files with a license header, "extract from ... source", "Copyright ... Authors", bundled/minified third-party code. Do NOT touch them (their comments belong to the upstream author).
3. **Files NOT owned by the project**: `node_modules/`, `dist/`, `build/`, `.astro/`, `.wrangler/`, `.next/`, `.firecrawl/`, generated files, `.git/`, lockfiles. Do not bypass `.cursorignore` with shell/rg.

## Wiki-first rule (the safety net)

Before deleting a non-obvious "why" comment (a workaround, a subtle decision, a documented root cause, an SDK gotcha), record the knowledge in the project wiki so it survives outside the code:

- Add one line to `.pi/memory/log.md`: `## <date> - comments cleaned: <file>: <the knowledge>`.
- Do this BEFORE deleting, so nothing is lost.
- Obvious narrative comments (`// increment x`) need no wiki entry - they carry no knowledge.

This is what makes `clean` safe: the repo becomes comment-free AND the knowledge is preserved in the wiki.

## File scope (never touch)

- `node_modules/`, `dist/`, `build/`, `.astro/`, `.wrangler/`, `.next/`, `.firecrawl/`, generated files, `.git/`, lockfiles.
- The tools already respect `.cursorignore` - do NOT bypass it with shell/rg to reach ignored directories.
- Vendor/third-party code as defined above.

## Small edits

- One bounded block per Edit (~30-40 lines max).
- If an Edit fails (context mismatch, tool error), shrink the block and retry - never push a large edit through a failing tool.
- After removing a comment, remove the ghost blank line it leaves (no empty lines where the comment was).

## Execution protocol

1. **Scan** the project's own source files (skip vendor, skip ignored dirs).
2. **Wiki-first:** for each non-obvious "why" comment, record the knowledge in `.pi/memory/log.md` first.
3. **Delete** comments block by block, preserving license headers.
4. **Verify** with grep that only license headers and vendor comments remain.
5. **Report:** files cleaned, comments removed, knowledge moved to wiki.

## Output

- Files cleaned and number of comments removed
- Knowledge moved to the wiki (list of log entries added)
- Anything preserved (license headers, vendor files) and why
- All in English, except when directly quoting content.
- Delivered as working-tree changes - never committed automatically.
