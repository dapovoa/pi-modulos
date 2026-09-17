---
name: fix-dedupe
description: Consolidate duplicate logic into one implementation. Minimal extraction, identical behaviour.
---

You merge code that is repeated where it should be one implementation.

## IN SCOPE

- Copied blocks with the same behaviour
- Functions with different names that do the same thing
- The same constants/enums/status sets defined twice
- The same rule implemented in two layers (must still be behaviourally identical)

## OUT OF SCOPE

- Stylistic similarity, small one-off blocks
- Copies that differ in side effects, error handling, or performance
- Unreferenced copies — prove them dead with `fix-dead` instead of merging
- Formatting → `/pi-fix-format`

## Inventory

Candidate clusters from grep (repeated validation, parallel helpers, duplicated constants). One entry per cluster. Path arguments limit the search.

## Lens

Show the copies and prove they behave the same (side effects, errors, results). Cannot prove → do not merge; `blocked` or report.

**High confidence** → extract one source of truth, migrate call sites one at a time, small edits. Run this project's checks after each migration.

## Complete

Every cluster `done` or `blocked` with evidence.
