---
name: review-diff
description: Review only what changed, through correctness, security, performance, and duplication. Fix high-confidence issues; report the rest.
---

You review **the change**, not the repository. The extension has already written the backlog into the progress file: one entry per changed file. The user message has the same list and the `git diff` command for the scope.

A full-repo sweep does not belong here — use the domain audit skill.

## Scope (binary)

- **The backlog is frozen.** Every entry ends `done`, `blocked`, or `excluded` with a reason.
- **Unchanged code is context, not scope.** Read callers and types to judge the change. An issue that exists only in untouched code goes under Fora de âmbito — one line, not fixed, no tracker page.
- A **deleted** file is an entry: check that nothing still references it.
- A **new untracked** file has no diff — read the whole file.
- Formatting, naming, and comments are **not** findings. Those are `/pi-fix-format` and `/pi-fix-remove-comments`.

## The four lenses (one pass per file)

| Lens | In this change, look for |
|------|--------------------------|
| Correctness | Data loss, crash, null on a real path, lost writes, silent truncation, broken error handling, off-by-one, wrong branch |
| Security | New or widened trust boundary: unvalidated input, missing authz, injection, IDOR, secrets, internal error text to the client |
| Performance | Work added per request or per row: query in a loop, sequential awaits that could be parallel, unbounded list or cache, heavy import on a hot path |
| Duplication | Logic added that already exists elsewhere — the copy you would have to edit twice next time |

## Evidence

A finding needs a **concrete trigger** in **this change**: the input, caller, or sequence that makes it happen. Naming a category without a reachable path is not a finding — drop it.

## Per file

1. Read the diff (`git diff <range> -- <path>`), then enough of the file and its callers to know what the change does.
2. Apply all four lenses.
3. **High confidence + small fix** → `Edit` now, inside the changed area. No refactors, no drive-by cleanup.
4. **Real but uncertain, or needs a decision** → do not edit. Record the trigger and a recommendation.
5. Mark `done` (what you found, or `clean`) or `blocked` with the concrete blocker.

If a fix fails the project's checks, revert it and downgrade to a reported finding.

## Wiki

Only issues you did **not** fix get a tracker page. Delete pages whose issue this change resolved.

## Output extras (pt-PT)

- **Corrigido** — trigger, fix, checks you ran.
- **Achados não corrigidos** — trigger, recommendation, why not fixed.
- **Limpo** — files with nothing found, one line each.
- **Fora de âmbito** — issues in untouched code, one line each.
