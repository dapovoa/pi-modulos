---
name: review-diff
description: Review only what changed (working tree or branch) through four lenses — correctness, security, performance, duplication. Fix high-confidence issues, report the rest.
use_when: Before committing, before opening a PR, or after finishing a feature. This is the default review pass; the per-domain audit skills are for deliberate full-repo sweeps.
guidelines: "1. The backlog is given to you — do not widen or shrink it. 2. Four lenses on every changed file, in one pass per file. 3. A finding needs a concrete trigger in the changed code, not a category name. 4. Fix only what you are confident about; report the rest with evidence. 5. Unchanged code is context to read, never scope to audit."
user-invocable: true
tools: [Read, Edit, Write, Grep, Glob, Shell]
last-refreshed: 2026-09-17
---

You review **the change**, not the repository. The extension has already computed the scope and
written the backlog into `.pi/memory/pages/pi-tools-progress-review-diff.md`: one entry per changed
file. Your user message carries the same list plus the `git diff` command for the scope.

This is what makes the skill finish. A full-repo sweep does not converge; a diff does.

## Scope rules (binary)

- **The backlog is fixed.** Do not add files, do not drop files, do not "skip trivial ones". Every
  entry ends `done`, `blocked`, or `excluded` with a reason.
- **Unchanged code is context, not scope.** You must read callers, callees and types around a change
  to judge it — that is required. But an issue that exists only in untouched code is **not** yours:
  note it in one line under Fora de âmbito and move on. Do not fix it.
- **A deleted file** is an entry too: check that nothing still references it.
- **A new untracked file** has no diff — read the whole file.

## The four lenses

Apply all four to each file in one pass. Do not make four passes over the backlog.

| Lens | What you are looking for in the change |
|------|----------------------------------------|
| **Correctness** | Data loss, crashes, null/undefined on a real path, lost writes, silent truncation, broken error handling, off-by-one, wrong branch taken |
| **Security** | New or widened trust boundary: unvalidated input reaching a sink, missing auth guard, injection, IDOR, secrets in code or logs, internal error text reaching the client |
| **Performance** | Work added per request or per row: query in a loop, sequential awaits that could be parallel, unbounded list or cache, new heavy import on a hot route |
| **Duplication** | Logic added that already exists elsewhere — the copy you would have to edit twice next time |

Depth belongs to the per-domain skills. Here you go wide over a small scope: the goal is that nothing
in this change ships unlooked-at.

## Evidence bar (same as the audit skills)

- A finding needs a **concrete trigger**: the input, the caller, or the sequence that makes it happen.
  "Could be a race" is not a finding; "two requests for the same slot both pass the check at line 40
  because the read and the write are not atomic" is.
- Naming a category (`XSS`, `N+1`) without pointing at the reachable path in **this change** is not a
  finding. Drop it.
- Style, naming and formatting are **not** findings here. Formatting is `/pi-fix-format`, comments are
  `/pi-fix-remove-comments`.

## Per file

1. Read the diff for the file (`git diff <range> -- <path>`), then read enough of the file and its
   callers to understand what the change actually does.
2. Apply the four lenses.
3. **High confidence + small fix** → `Edit` now, then re-read the result. Keep fixes minimal and
   inside the changed area; no refactors, no drive-by improvements.
4. **Real but uncertain, or a fix that needs a decision** → do not edit. Record it as a finding with
   the trigger and your recommendation.
5. Mark the entry `done` (with what you found, or `clean`), or `blocked` with the concrete blocker.

## Verification

You have `Shell`. After your edits, run the project's typecheck and tests yourself and fix what you
broke. The extension runs them again independently after you finish and writes the result into the
progress file — a run where your report says "verified" and the extension says `FAIL` is a failed run.

If your fix cannot pass verification, revert it and downgrade the item to a reported finding.

## Wiki

- Read `.pi/memory/index.md` first so you do not re-report something already tracked.
- Only issues you did **not** fix get a tracker page, in `.pi/memory/pages/`, one line each with
  location, trigger and today's date. Delete pages whose issue this change resolved.
- Never put run notes in tracker pages, and never add the progress file to `index.md`.

## Output (pt-PT chat report)

1. **Cobertura** — files in backlog; done / blocked / excluded; pending must be 0
2. **Corrigido** — per fix: what it was, the trigger, the fix, and the verification you ran
3. **Achados não corrigidos** — trigger + recommendation + why you did not fix it
4. **Limpo** — files reviewed with nothing found, one line
5. **Fora de âmbito** — issues in untouched code, one line each, not fixed
6. **Verificação** — the commands you ran and their result
7. **Ficheiro de trabalho** — path + `completo` / `incompleto`

Never commit. Wiki and `log.md` in English per CONTRACT.
