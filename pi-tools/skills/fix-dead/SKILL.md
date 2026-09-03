---
name: fix-dead
description: Find and remove dead code (imports, exports, orphan files) only with proof of non-use.
use_when: Suspicious that the codebase has unused imports, orphaned exports, unreferenced functions, unreachable code, dead branches, or files nobody imports. Also before a cleanup pass or when pruning a codebase.
guidelines: "1. WIKI INDEX (tracker): Read .pi/memory/index.md first to avoid duplicate reports; CODE always wins over wiki. 2. PROOF REQUIRED: 'Not referenced' must be proven with grep/glob across ALL files - a missing reference is not evidence until you have searched. 3. HIGH CONFIDENCE = REMOVE: when zero references are proven across the project AND no dynamic/config/entry/public-API reference exists, remove it - do not wait for confirmation. 4. REPORT ONLY WHEN UNCERTAIN: if reachability is doubtful (dynamic calls, string paths, public API, config references), report with evidence instead of removing. 5. CLEANUP: Remove wiki entries for dead code no longer present. Keep .pi/memory/ small - only active findings."
user-invocable: true
tools: [Read, Write, Edit, Grep, Glob]
last-refreshed: 2026-08-15
---

You are a dead-code detection automation. You find code that nothing uses - and you prove it before anything is removed.

## Skill-specific workflow

**Progress file:** `pi-tools-progress-fix-dead.md`

**Inventory:** Candidates — unused imports, orphan exports, unreferenced symbols, orphan files (discover via grep/glob). One entry per candidate.

**Lens:** Full-project grep + dynamic/config/entry checks per candidate.

**Exit:** Every candidate `done` (removed or verified live) or `blocked` (uncertain reachability with evidence). Set progress `status: complete` or `status: incomplete`.

Read `.pi/memory/index.md` first: it tracks dead-code findings from past runs so you do not re-report duplicates. Wiki pages are a **tracker**, not authority — always verify in code before removing.

## Source of truth (wiki vs code)

1. **CODE wins** for current behavior, existence, and reachability. Prove unreferenced status with grep/glob across the project — never trust wiki alone.
2. **Wiki is a tracker**, not authority: index + pages record past findings. Use them to avoid duplicate reports and to know what to re-check — never to skip code inspection.
3. **On conflict** (wiki says dead, code shows references): code is current reality. Delete or update the wiki entry; do not remove live code. If unclear, report the conflict to the user.
4. **Re-verify before remove:** "Still dead" only after zero references confirmed in code today. Code now referenced → delete the wiki page; do not remove the code.

## Goal

Identify code that is not referenced anywhere: unused imports, orphaned exports, unreferenced functions/variables, unreachable code, dead branches, and orphan files. Remove what is provably dead with high confidence; report only what is uncertain.

## What to look for

- **Unused imports**: a module/name imported but never referenced in the file.
- **Orphan exports**: exported but no other file imports it (check ALL files, not just src/).
- **Unreferenced functions/variables**: defined but never called/read anywhere.
- **Unreachable code**: statements after `return`/`throw`, `if (false)`, loops that always break, code in a branch that can never execute.
- **Dead branches**: conditions always false (e.g. a constant compared to itself), enum members never used, switch cases unreachable.
- **Orphan files**: a file never imported by any other file (but check: entry points, configs, scripts, dynamic imports, package.json `files`, build references may reference it).

## Proof requirement (the core rule)

- **"Not referenced" is NOT a fact until you have searched.** Before flagging anything as dead:
  1. `grep` for the name/import across the WHOLE project (all extensions: .ts, .tsx, .js, .jsx, .vue, .svelte, .astro, .css, .json, .html).
  2. Check dynamic references: `import()`, `require()`, string paths, config arrays, build entries, plugin registrations, CLI commands, route registrations.
  3. Check public API surface: if the file/module is a package entry or library API, exports may be used by consumers outside this repo - do not remove without asking.
- **Only when grep across everything shows zero references AND no dynamic/config/entry reference exists can you classify as dead.**
- **When in doubt: report, do not remove.**

## Confidence-driven flow (resolve like audit-bug/fix-format)

1. **Find candidates** (grep for unused imports, scan for orphan exports, trace reachability).
2. **Prove** with grep across the whole project + check dynamic references (`import()`, `require()`, string paths, config arrays, build entries, plugin registrations, CLI commands, route registrations) + public API surface.
3. **High confidence (zero references, no dynamic/config/entry/public reference) -> REMOVE now.** Do not wait for user confirmation - this is the expected behavior, same as `audit-bug` and `fix-format` fix proven issues.
4. **Uncertain reachability -> REPORT with evidence** (the code, where you searched, what you could not rule out) and let the user decide. Do not remove on doubt.
5. After removal, verify: typecheck/build/tests still pass.

## What is NEVER removed

- Code with ANY reference you could not rule out (dynamic import, string path, config, entry point, plugin, route, public API).
- Code in `.pi/` (project wiki - managed by the wiki skill).
- Vendor/third-party code (license header, "extract from ... source", bundled/minified).
- Anything in `node_modules/`, `dist/`, build output, generated files, `.git/`, lockfiles. Do not bypass `.cursorignore` with shell/rg.

## File scope (never touch)

- Never touch `node_modules/`, `dist/`, `build/`, `.astro/`, `.wrangler/`, `.next/`, `.firecrawl/`, generated files, `.git/`, lockfiles, or `.pi/` (managed only by the wiki skill). Do not bypass `.cursorignore` with shell/rg.
- Never edit vendor or third-party code, even inside `src/`: files with a license header, "extract from ... source", bundled/minified third-party code.

## Fix strategy (for provably dead code)

- Remove provably dead code with high confidence — do not wait for user confirmation.
- Apply in SMALL EDITS: one bounded block per Edit (~30-40 lines max). If an Edit fails, shrink and retry.
- Remove the import AND its now-unused references; remove orphan functions/files entirely.
- After removal, verify: typecheck/build/tests still pass. A removal that breaks the build is not complete.
- Avoid broad refactors in the same change.

## Avoiding duplicate work

For each finding, check .pi/memory/index.md and the corresponding page:

- Finding already tracked and still present: do NOT re-report. Note it in your summary.
- Finding already tracked but no longer present: delete the page and remove the entry from index.md.
- Finding not tracked: report (and track it in the wiki).

Keep .pi/memory/ small: only pages for dead code still present, each with the date it was recorded.

## Safety rules

- Do not remove anything you have not proven unreferenced across the whole project.
- Never remove code with uncertain reachability - report it as `blocked` with evidence instead.

## Output

Include **Coverage** (candidates done/blocked/pending; pending must be 0 on complete). If removed:
- What was dead and the proof (where you searched, zero references)
- Root cause (why it became dead - superseded, refactored away, never used)
- Removal and validation (typecheck/build/tests)

If reported only (uncertain reachability), list the candidates with evidence and why you did not remove them (dynamic reference, public API, config/entry point).

**Language:** Follow CONTRACT — chat report in **pt-PT**; wiki tracker pages in **English**.
