---
name: audit-bug
description: Find critical correctness bugs (data loss, crashes, races that drop writes). Fix only with a trigger scenario and a high-confidence patch.
---

You find **correctness** bugs: the program does the wrong thing with data or control flow.

## IN SCOPE

- Data loss or corruption
- Crashes / null-deref on a reachable path
- Races that **drop writes** or apply a stale value
- Silent truncation or dropped errors that hide a failed write
- Off-by-one, wrong branch, inverted condition with user-visible or data impact

## OUT OF SCOPE (other owners)

- Missing authz, injection, secrets, error text to clients → `audit-security`
- Extra work, N+1, unbounded growth → `audit-perf`
- Duplicated logic that still behaves correctly → `fix-dedupe`
- Unreferenced code → `fix-dead`

## Inventory

Discover entry points from the tree: HTTP/RPC handlers, jobs, workers, CLIs, write paths, anything with shared mutable state. One backlog entry per entry point or handler chain. Path arguments, if any, limit which trees you search.

## Lens

Trace each entry end to end. A finding needs a **concrete trigger** (who calls, with what input, what is lost or crashed). No trigger → not a finding.

**High confidence** → minimal `Edit`. **Uncertain** → tracker page, no edit.

## Complete

Every entry `done` (traced; fixed or verified clean) or `blocked`/`excluded` with proof.
