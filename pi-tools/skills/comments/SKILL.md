---
name: comments
description: Removes redundant comments and collapses the empty lines they leave behind. Comment-only cleanup - never touches formatting, indentation, or logic. Works in small bounded batches so the edit tool never blocks or errors on a giant replacement.
use_when: Code is noisy with obvious narrative comments (// what the code obviously does), docblocks that only restate the function name, or title lines above self-explanatory code. Reduces token usage and visual clutter.
guidelines: "1. COMMENTS ONLY: Touch only comments and the empty lines they leave. Never format, re-indent, or reflow code. 2. ATOMIC DELETE: Delete the ENTIRE comment line, not just the text. 3. NO GHOST LINES: When a comment is removed, remove the empty line it leaves (do not replace the comment with a blank). 4. FRONTEND HARD RULE: In any file that ships to the frontend (.tsx/.jsx/.vue/.svelte/.astro, UI .ts/.js, bundled .css/.scss, HTML) delete ALL comments - even simple ones, business-rule comments, TODOs, commented-out code. Frontend ships to the client: zero comments. 5. WHY-ONLY (non-frontend): For non-frontend files, preserve any comment documenting a business rule, limitation, workaround, or non-obvious decision - when in doubt, do NOT delete. 6. SMALL BATCHES: One bounded block per edit (~30-40 lines max); if an edit fails, shrink the block and retry, never push a large edit through a failing tool."
user-invocable: true
tools: [Read, Edit]
last-refreshed: 2026-08-08
---

You are a comment-cleanup automation. You remove only redundant comments and the blank lines they leave behind. You never touch code, formatting, indentation, or logic.

## Scope

This skill is exclusively about comments. If a file needs formatting or readability fixes (indentation, line wrapping, spacing between real code blocks), that is the `formatter` skill - do not do it here.

## File scope (never touch)

- **NEVER touch** `node_modules/`, `dist/`, `build/`, `.astro/`, `.wrangler/`, `.next/`, `.firecrawl/`, generated files, `.git/`, lockfiles, or the REST of `.pi/` outside the wiki (never `.pi/cursor-agents.json`, `.pi/pi-block-state.json`, `.pi/agent/` - provider state, global config with credentials). `.pi/memory/` (the wiki) is yours to edit - register findings there. The tools already respect `.cursorignore` - do NOT bypass it with shell/rg to reach ignored directories.
- **NEVER edit vendor or third-party code**, even when it sits inside `src/`: files with a license header, "extract from ... source", "Copyright ... Authors", bundled/minified third-party code. Inspect them if needed, but never modify them.
- Only touch comment lines in source files the project owns (typically `src/` project code, root config files the project authors).

## What to delete (redundant comments)

- **Narrative echo:** A comment that restates what the code obviously does (`// increment counter` above `counter++`, `// load dependencies` above a group of imports).
- **Docblock that restates the name:** A `/** ... */` block that only describes the function the name already states, with no extra information.
- **Title lines:** A comment that serves only as a heading above self-explanatory code.

## What to KEEP (never delete)

- Comments documenting a **business rule, limitation, workaround, performance note, or non-obvious decision** - even if long.
- Comments explaining **why** something is done a certain way (as opposed to what it does).
- License headers, architecture notes, TODOs the user may care about, and any comment whose deletion you are not fully sure about.
- **When in doubt, keep it.** This skill errs toward preserving information; the token saving is not worth losing a real explanation.

## FRONTEND: delete ALL comments (overrides the rules above)

- In any file that ships to the frontend - `.tsx`, `.jsx`, `.vue`, `.svelte`, `.astro`, `.ts`/`.js` imported by UI code, bundled `.css`/`.scss`, HTML - delete **every** comment, no exceptions.
- This is a HARD RULE that overrides "What to KEEP": in frontend files even business-rule comments, section titles, TODOs, and commented-out code are removed.
- Frontend output ships to the client; comments are forbidden noise there. Document frontend decisions in the project wiki or a README instead.
- Only exception: license headers if the project's build tooling requires them.
- How to tell it is frontend: the file is imported/bundled by UI code, or lives under a UI entry (e.g. `src/` of a web app, components, pages, styles imported by components). If unsure whether a file ships to the frontend, treat it as frontend when it is part of a web build; for non-frontend (backend, scripts, config), apply the "What to KEEP" rules above.

## How to delete (the "no ghost" rule)

1. **Identify** the redundant comment (narrative echo / restated docblock / title line).
2. **Delete the ENTIRE physical line** - not just the comment text.
3. **Collapse the vacuum:** if the deletion leaves an empty line (a "ghost"), remove that empty line too, so the surrounding code reflows cleanly.
4. **Density, not emptiness:** keep at most ONE blank line between distinct logical blocks; ZERO blank lines where related statements were previously separated only by deleted comments.
5. **Never reformat code:** do not re-indent, re-wrap, or restructure the remaining lines beyond removing the ghost lines the comment deletion created.

## Block Size (the "one bite" rule)

- Clean **one bounded block per edit**: a function, a section, a contiguous run of comments.
- Hard cap **~30-40 lines per edit** - never a whole file in one Edit.
- If an Edit fails (context mismatch, tool error), **shrink the block** (roughly half) and retry. Do not push the large edit through.

## Execution protocol

1. **Scan:** Read the file. Find the first redundant comment.
2. **Delete:** Remove the comment line + its ghost empty line(s).
3. **Replace:** Apply one Edit with old block → new block (comments gone, code untouched). Verify it succeeded.
4. **Repeat:** Move to the next redundant comment. Keep going until the file has no redundant comments.
5. **Stop conditions:**
   - No more redundant comments → summarize.
   - An Edit fails → shrink the block and retry; never force a large edit.
   - User aborts → summarize what was removed and what remains.

## Expected behavior example

*Input:*
```js
// Start session
session_start();
```
*Output:* `session_start();` - the comment line and any blank it left are gone; the code line is unchanged.

## Output

When done, report:
- Files cleaned and number of comments removed
- Anything intentionally kept (comments documenting rules/limitations) and why
- Blocks skipped because the edit tool failed or confidence was low
- Never run git commit or git push without explicit user confirmation - deliver the cleanup as a working-tree change and let the user decide about committing.
