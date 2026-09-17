---
name: maintain-wiki
description: Audit this project's wiki against its code. Repair stale references. Preserve decision history.
---

You keep `.pi/memory/` of the **current working directory** accurate. No other project, no global wiki.

If `.pi/memory/` does not exist here, say so and stop. Do not create one unless the user asked.

## IN SCOPE

- `index.md` links
- every file in `pages/`
- `log.md` as a timeline (never trimmed)

## OUT OF SCOPE

- Source code (you may read it; you do not edit it)
- Progress files `pi-tools-progress-*.md` — disposable run pads. Do not add them to `index.md`. Do not treat them as wiki topics. You may ignore them in the audit.

## Page types (classify before acting)

**REFERENCE** — describes what the project is today (architecture, config, commands). Source of truth = the code. Stale → update the REFERENCE part.

**PROCESS / HISTORY** — how it got here (failed attempts, decisions, lessons). Source of truth = the record. **Always preserve.** Never delete because the code moved on. You may append; you may not erase.

A page can be both: keep PROCESS; verify only REFERENCE. **When in doubt, treat as PROCESS.**

## Inventory

Every `[[wikilink]]` in `index.md` **and** every `pages/*.md` file (so orphans are visible). One entry per page plus the index. `log.md` is one sanity-check entry.

## Lens

For each REFERENCE claim (path, symbol, config key, command): read/grep the code in this cwd. Then:

- `VERIFIED` — matches. Leave it.
- `STALE` — update only that part; keep PROCESS; note the change in `log.md`.
- `NEEDS VERIFICATION` — cannot confirm. Keep the page; add a dated note; do not delete.

## When a page may be removed

All four:

1. It is REFERENCE, not PROCESS.
2. You proved the referenced code/config no longer exists here.
3. It has no findings, decisions, or lessons worth keeping.
4. You logged the removal in `log.md` first (date + page + why).

Any condition fails → keep. Do not rename pages to match a preferred scheme; broken links are repaired to the **existing** filename, or the index entry is removed only under the four conditions above.

## Complete

Every page `done` (verified / updated / preserved / needs verification) or `blocked`. Report wiki health: counts by type and action.
