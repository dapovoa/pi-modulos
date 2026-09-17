# Pi-tools skill contract (all skills)

You are a **skill**, not a messenger. Execute the work. A report without the work is a **failed run**.

These rules apply to every skill. A skill may tighten them. A skill may not loosen them.

## Binary rules

1. **Fix skills edit files.** Audit skills run checks and apply the fixes that skill allows. A report alone is never success.
2. **Closed lists only.** If this skill lists KEEP / SKIP / OUT OF SCOPE, only those cases stay untouched. Everything else in scope is processed.
3. **`excluded` needs per-hit proof:** path + line number + exact line text + the rule from **this** skill's list (name the bullet or keep-id). No file-wide `excluded`.
4. **`complete` is forbidden when:**
   - any backlog entry is `pending` or `in_progress`;
   - a fix skill still has in-scope work and you marked zero `done`;
   - report counts disagree with the progress file Summary.
5. **No soft language** in decisions. Do not write "likely clean", "appears done", "nothing to do" without the proof this skill requires.
6. **Never ask** the user to confirm this skill's core job.

## Who owns what (no overlap)

One issue has one owner. If another skill could claim it, this table wins. The other skill notes it in one line as out of scope and does **not** fix it or open a tracker page.

| Issue | Owner |
|-------|--------|
| Data loss, crash, wrong control flow, silent truncation, races that drop writes | `audit-bug` |
| Untrusted input, missing authz, injection, secrets, internal errors reaching clients | `audit-security` |
| Extra work per request/row, N+1, unbounded growth, hot-path payload/bundle cost | `audit-perf` |
| The same logic living in two places | `fix-dedupe` |
| Unreferenced code or files | `fix-dead` |
| Comments | `fix-clean` |
| Formatting / whitespace | `/pi-fix-format` (no model) |
| Advisories in package manifests and lockfiles | `audit-deps` |
| Wiki vs code | `maintain-wiki` |
| Those judgement lenses, but only on a **diff** | `review-diff` |

`review-diff` may apply a small high-confidence fix inside the changed area. Full-repo sweeps stay on the domain skill. Style is never a finding for any judgement skill.

## Inventory

Discover work from the **repository**, with tools — never from a user feature list, never from hardcoded module names.

**Path arguments** are scope, not inventory. If the command received paths, only those paths (and files under them) are in scope. If it received none, the skill's default scope is the whole project (minus File scope below).

If the extension already wrote the backlog ("Inventory written by the extension"), that list is **frozen**: do not add, drop, or skip entries. Only change status.

Every in-scope item appears in the progress file before deep work.

## File scope (never touch)

Never edit, format, or delete:

- install and vendor trees (`node_modules`, `vendor`, `.venv`, `venv`, `__pycache__`, `.tox`, `.mypy_cache`);
- build and framework output (`dist`, `build`, `out`, `coverage`, `target`, `.next`, `.nuxt`, `.astro`, `.wrangler`, `.svelte-kit`, `.output`, `.turbo`, `.cache`);
- VCS (`.git`);
- lockfiles;
- generated files (header or name says generated / do not edit);
- third-party code inside the tree (licence header, "extract from … source", bundled/minified);
- `.pi/` except `.pi/memory/` — and in `.pi/memory/` you only write what this skill's wiki rules allow.

Do not bypass ignore files (`.gitignore`, `.cursorignore`, `.ignore`) with shell/rg. Ignore extra directories the project itself treats as generated.

`maintain-wiki` and tracker writes are the only skills that edit `.pi/memory/` pages other than this run's progress file. `fix-clean` may append facts to `log.md` as that skill specifies.

## Progress file

Path: `.pi/memory/pages/pi-tools-progress-{skill-id}.md` (skill-id = folder name).

Scratch pad for **this run**, not project documentation. Never add it to `index.md`.

The extension **resets** it on invoke (unless the first argument is `resume`). Do not create it from scratch. Do not `rm` it.

Format: `status | id | notes` with status `pending`, `in_progress`, `done`, `blocked`, or `excluded`.

- **Complete:** pending = 0 → header `status: complete` + Summary counts. Report `Ficheiro de trabalho: … (completo)`.
- **Incomplete:** header `status: incomplete`. Report `(incompleto, X pending)`. Never claim success.
- **Trackers** (bugs, CVEs, named finding pages) are separate. Keep them until the issue is gone from code or manifests. Do not store run backlog there.

## Wiki vs code

1. **Code (or manifests) wins.** Verify every claim with read/grep/glob before editing or concluding the issue still exists.
2. **Wiki is a tracker**, not authority. Use it to avoid duplicate reports — never to skip inspection.
3. **On conflict:** update or remove the wiki entry. Do not change code to match a stale page.
4. **Still present** only after you confirm it today. Gone from code → delete the tracker page and its `index.md` entry.

Read `.pi/memory/index.md` first when the skill tracks findings. One tracker page per open issue, one line (location + root cause + date), English. No run notes on tracker pages.

Never commit or push. Deliver working-tree changes.

## Independent verification

After the run, the extension inspects the working tree and appends a **Verification** section to the progress file. You do not write that section and you cannot influence it.

- It records which source and wiki files this run changed.
- When source changed, it runs the project's configured checks (typecheck/test scripts, or whatever `config.json` maps) and records `pass` / `FAIL`.
- A fix skill that claims work but leaves the tree unchanged is visible there.

Your report must not contradict it. Run the same checks yourself while working when the project has them. A fix that fails those checks is not `done` — repair it or mark `blocked`. If there are no checks, say so; do not invent a toolchain.

## Language

| Layer | Language |
|-------|----------|
| This contract and every `SKILL.md` | English |
| Chat report to the user | European Portuguese (pt-PT) |
| Wiki (`index.md`, `log.md`, `pages/`) | English |
| Progress file | English |

Quote code, paths, and existing wiki text in their original language.

## Final report (always, pt-PT)

1. **Cobertura** — inventory size; done / blocked / excluded / pending (pending = 0 on complete).
2. **Ações** — what you fixed, removed, or audited, with evidence.
3. **Prova** — `git diff --stat` and every edited path. Zero code edits requires line-level proof for every in-scope hit.
4. **Ficheiro de trabalho** — progress path + `completo` / `incompleto`.
5. **Achados** — open tracker pages when this skill uses them.
6. **Blocked** — concrete blocker, not token limits.

## Forbidden

- "No issues" / "repo clean" without full backlog coverage and this skill's verification.
- Stopping because the repo is large — continue, or leave `pending` and `status: incomplete`.
- Asking confirmation for the skill's core job.
- Logging scan notes on tracker pages.
- Deleting the progress file.
- Fixing or tracking an issue another skill owns.
