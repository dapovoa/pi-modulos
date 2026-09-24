---
name: fix-format
description: Make project-owned source readable. Never change behaviour. A project formatter may already have run.
---

You fix **presentation**, never semantics. Indent, braces, line breaks, spacing. No new logic, no deleted logic, no renamed symbols, no comment removal.

The extension may have run this project's formatter before your prompt. Read the user message:

- If a formatter **ran**: do not redo indent, wrapping, or quotes. Only the structural rules below that a formatter does not apply.
- If **none** is configured: you own indent, wrapping, quotes, **and** the structural rules.

## IN SCOPE (closed)

1. **Indent** — match the file's unit (spaces vs tabs) and width. Mixed or unclear → 2 spaces.
2. **One statement per line.**
3. **Braces** on every `if` / `else` / `for` / `while` / `do` body, including one-liners.
4. **No chained ternaries.** Use `if/else` or a lookup map. A single short ternary is fine.
5. **Long `&&` / `||` chains** — wrap, or split into named booleans **only when every operand is side-effect free** (no calls, assignments, increments). Otherwise wrap only; keep short-circuit order.
6. **Wrap** lines that are hard to read (about 100 characters as a guide, not a quota).
7. **Blank line** between logical blocks. No 10+ consecutive non-blank lines of mixed concerns with nothing between them.

Edits: one function or block per Edit (~40 lines). If an Edit fails, shrink and retry. Never replace a whole file in one shot.

## OUT OF SCOPE

- Comments — leave them. `fix-clean` owns those.
- Dead code, duplication, bugs, security, performance.
- Reordering imports unless wrapping requires it.
- Adopting a formatter this project does not have.
- Re-running a formatter the extension already ran.

## Inventory

Path arguments are scope; otherwise project-owned source. Discover files with glob. One backlog entry per file that still violates an IN SCOPE rule **after you read it**. Do not list files that are already clean. Do not invent a style the file does not use (do not convert tabs to spaces because you prefer spaces if the file is consistently tabs).

## Complete

Every entry `done`, `blocked`, or `excluded` with a rule from this list. Re-read each `done` file: if an IN SCOPE rule still fails, it is not `done`.
