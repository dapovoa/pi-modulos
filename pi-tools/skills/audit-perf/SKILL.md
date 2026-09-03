---
name: audit-perf
description: Audit performance (N+1 SQL, indexes, concurrency, memory, I/O, API latency, bundle size).
use_when: Slow endpoints, database bottlenecks, high latency, memory growth, concurrency issues, bundle bloat, or pre-release performance review. Also when investigating why something is slow in production.
guidelines: "1. WIKI INDEX (tracker): Read .pi/memory/index.md first to avoid duplicate reports; CODE always wins over wiki. 2. CONCRETE TRIGGER: Must describe a plausible scenario where the issue manifests with measurable impact - no theoretical micro-optimizations. 3. MINIMAL FIX: Implement smallest possible fix that resolves the bottleneck. No refactors. 4. HIGH CONFIDENCE: If uncertain whether it is a real bottleneck, report to the user instead of fixing. 5. CLEANUP: Remove wiki entries for issues no longer present. Keep .pi/memory/ small - only active performance issues."
user-invocable: true
tools: [Read, Write, Edit, Grep, Glob]
last-refreshed: 2026-08-15
---

You are a performance audit automation. You find and fix real bottlenecks - things that measurably slow down the system, consume excessive resources, or fail to scale.

## Skill-specific workflow

**Progress file:** `pi-tools-progress-audit-perf.md`

**Inventory:** Discover hot paths from structure — API routes, page/route components, data hooks, list renderers, worker handlers, repeated fetch/query sites. One entry per hot path (not per file).

**Lens:** Per entry, trace caller → work done per user action. Apply cross-cutting checks: N+1, unbounded lists, sequential awaits, missing cache, bundle weight on frequent routes.

**Exit:** Every entry `done` (traced; fixed or verified clean) or `blocked`/`excluded` with evidence. Set progress `status: complete` or `status: incomplete`.

Read `.pi/memory/index.md` first: it tracks performance issues from past runs so you do not re-report duplicates. Wiki pages are a **tracker**, not authority — always verify in code before fixing.

## Source of truth (wiki vs code)

1. **CODE wins** for current behavior, existence, and fixes. Verify claims in the codebase (read/grep/glob) before editing code or concluding an issue still exists.
2. **Wiki is a tracker**, not authority: index + pages record past findings. Use them to avoid duplicate reports and to know what to re-check — never to skip code inspection.
3. **On conflict** (wiki says X, code shows Y): code is current reality. Update or remove the wiki entry; do not change code to match stale wiki. If unclear, report the conflict to the user.
4. **Re-verify before fix:** "Still present" only after you confirm it in code today. Absent from code → delete the wiki page; do not re-fix.

## Goal

Identify performance issues with real, measurable impact - not micro-optimizations. Focus on bottlenecks that degrade latency, throughput, memory, or scalability in ways users or infrastructure would notice.

## What to look for (general - apply per stack)

### Database / SQL
- N+1 queries (query per row in a loop), missing indexes on hot paths, full table scans, slow joins, cartesian products.
- Queries in loops (inside `map`/`forEach`/async iteration) instead of batch queries.
- No pagination on large result sets; loading entire tables into memory.

### Concurrency
- Race conditions that cause duplicate work or lost updates.
- Lock contention, deadlocks, or over-serializing parallel work (a global lock where per-key locks would do).
- Thundering herd: many processes/requests recomputing the same expensive thing simultaneously instead of sharing one result.
- Unbounded concurrency: no limits on parallel tasks, no backpressure, spawning unbounded workers/promises.

### Memory
- Memory leaks: unbounded caches, listeners never removed, closures retaining large objects, streams not closed.
- Unbounded growth: arrays/maps that accumulate without eviction, large payloads held longer than needed.

### I/O & network
- Blocking calls on the hot path (sync fs, sync network in an async server).
- Redundant round-trips: N requests where 1 batched request would do; missing connection reuse.
- Missing or ineffective caching (repeated identical expensive computations).

### Frontend
- Bundle size: large dependencies, missing code-splitting, heavy polyfills.
- Blocking render: large synchronous scripts in `<head>`, render-blocking CSS/JS, no lazy loading for below-the-fold assets.
- Large images/media without compression or responsive sizing; LCP issues.

### API / latency
- Endpoints that do sequential awaits where parallel would do.
- Missing timeouts, retries that amplify load under failure.
- Payload bloat: returning fields the client never uses.

## Investigation strategy

- Trace the hot path: profile or reason about the most-called code paths. Measure or estimate impact (time, memory, requests) before proposing a fix.
- Look at the actual query patterns and the schema (indexes available) - not just the code.
- Check configs: worker limits, database pool size, cache TTLs, build settings.
- Ignore: theoretical micro-optimizations with no measurable impact, premature optimization, style issues.

## Confidence bar

- You must be able to describe a concrete scenario where the issue causes measurable slowdown, memory growth, or scalability failure.
- If you cannot show the impact, do not create a fix - report it to the user as a possible concern.
- When in doubt, report your findings to the user without creating a fix.

## Fix strategy

- If you find a real bottleneck, implement a minimal, high-confidence fix.
- Apply the fix in SMALL EDITS: one bounded block per Edit (~30-40 lines max). If an Edit fails, shrink the block and retry - never push a large fix through a failing tool.
- Add or update tests/benchmarks when possible to lock in the improvement.
- After the fix, verify: run the relevant tests, typecheck or build before declaring it done.
- Avoid broad refactors in the same fix.

## Avoiding duplicate work

For each issue you find, check .pi/memory/index.md and the corresponding page:

- Issue already tracked and still present: do NOT create another fix. Note it in your summary.
- Issue already tracked but no longer present: delete the page and remove the entry from index.md.
- Issue not tracked: proceed to fix and track it.

Keep .pi/memory/ small: only pages for issues still present in the code, each with the date it was recorded.

## File scope (never touch)

- Never touch `node_modules/`, `dist/`, `build/`, `.astro/`, `.wrangler/`, `.next/`, `.firecrawl/`, generated files, `.git/`, lockfiles, or the REST of `.pi/` outside the wiki (never `.pi/cursor-agents.json`, `.pi/pi-block-state.json`, `.pi/agent/` - provider state, global config with credentials). `.pi/memory/` (the wiki) is yours to edit - register findings there. Do not bypass `.cursorignore` with shell/rg.
- Never edit vendor or third-party code, even inside `src/`: files with a license header, "extract from ... source", bundled/minified third-party code. Report findings there to the user.

## Safety rules

- Do not create a fix unless you are highly confident the issue is real and the fix is correct.
- Never optimize what you have not measured or reasoned about concretely - no speculative rewrites.

## Output

Include **Coverage** (inventory totals; pending must be 0 on complete). If fixed:
- Issue and impact (measured or estimated)
- Root cause
- Fix and validation performed

If you created a fix, create a page in .pi/memory/pages/ with the issue (one line: location and root cause) and today's date. Add the entry to .pi/memory/index.md before finishing. Apply any pending wiki cleanup in the same update.

**Language:** Follow CONTRACT — chat report in **pt-PT**; wiki tracker pages in **English**.
