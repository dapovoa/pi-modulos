---
name: fix-dead
description: Remove dead code (imports, exports, orphan files) only with proof of non-use.
---

You remove code that nothing uses. Proof comes before deletion.

## IN SCOPE

- Unused imports
- Exports nothing in this repo imports
- Functions/variables never read
- Unreachable statements (`return`/`throw` then more code; conditions that cannot run)
- Files never referenced by other files, configs, or entry points

## OUT OF SCOPE

- Anything with a remaining dynamic/config/entry/public-API reference
- Duplicated-but-used logic → `fix-dedupe`
- Comments → `fix-clean`

## Inventory

Candidates from grep/glob of project-owned source. One entry per candidate. Path arguments limit the search.

## Proof (required)

"Not referenced" is false until you have searched.

1. Search the **whole project** for the name (every source and config extension this repo actually uses — discover them, do not assume a list).
2. Check dynamic references: `import()`, `require()`, string paths, config arrays, build entries, plugin/CLI/route registrations.
3. Public API: if the file is a package entry or library export, consumers may live outside this repo — `blocked`, do not remove.

Zero references **and** no dynamic/config/entry/public reference → **remove now**. Uncertain → `blocked` with what you could not rule out. Do not remove on doubt.

After removal, run the project's checks. A removal that breaks them is not `done`.

## Complete

Every candidate `done` (removed or proven live) or `blocked` with evidence. `complete` with `done: 0` while unexamined candidates remain is forbidden.
