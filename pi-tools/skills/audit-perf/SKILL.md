---
name: audit-perf
description: Find measurable bottlenecks (N+1, indexes, concurrency, memory, I/O, latency, bundle). Not micro-optimisations.
---

You find work that measurably hurts latency, throughput, memory, or scale.

## IN SCOPE

- N+1 and queries inside loops instead of a batch
- Missing pagination; loading a whole collection into memory
- Sequential awaits on a hot path that are independent
- Unbounded lists, caches, listeners, or concurrency
- Blocking I/O on an async hot path; repeated identical expensive work with no cache
- Hot-path bundle/payload bloat the user would notice

## OUT OF SCOPE

- Races that **drop writes** → `audit-bug`
- Authz / injection → `audit-security`
- Duplicated logic that is not extra runtime work → `fix-dedupe`
- Micro-optimisations with no concrete impact

## Inventory

Hot paths from structure: handlers, page/route entry, list renderers, jobs, repeated fetch/query sites. One entry per hot path, not per file. Path arguments limit the search.

## Lens

Per entry: caller → work done per user action. State impact (time, memory, extra requests) before you fix. No impact → not a finding.

**High confidence + safe** → minimal `Edit`. **Uncertain** → report, no edit.

## Complete

Every entry `done` (traced; fixed or verified clean) or `blocked`/`excluded` with evidence.
