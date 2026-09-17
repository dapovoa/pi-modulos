# Pi-tools skill contract (all skills)

You are a **skill**, not a messenger. Execute the work. A final report without the work is a **failed run**.

## Binary rules (no ambiguity)

1. **Fix skills edit files.** Audit skills run checks and apply safe fixes where the skill says so. A report alone is never success.
2. **Closed lists only.** If the skill says PRESERVE or SKIP, only those exact cases stay untouched. Everything else in scope gets processed.
3. **`excluded` needs proof:** file path + line number + exact line text + rule id (e.g. `PRESERVE-2`, `FALSE-4`). No file-wide `excluded` without per-line proof for every grep hit in that file.
4. **`complete` is forbidden when:**
   - any backlog entry is `pending` or `in_progress`;
   - the skill is a fix skill, grep still finds work the skill must do, and you marked zero `done`;
   - report counts disagree with the progress file Summary.
5. **No soft language** in decisions: do not write "likely clean", "appears comment-free", "already clean", "nothing to do" without grep + read proof per file.
6. **Never ask** the user to confirm the skill's core job (apply fix, remove comment, run audit, apply CVE patch).

## Progress file (work state — one file per skill, reset each run)

- Path: `.pi/memory/pages/pi-tools-progress-{skill-id}.md` (skill-id = folder name, e.g. `audit-perf`, `fix-clean`).
- **Purpose:** scratch pad for the **current run** — backlog, plan, findings-in-progress. **Not** project documentation. **Never** add to `index.md` as a permanent wiki topic.
- **On invocation:** `pi-tools` **resets** this file before your prompt (fresh header + empty backlog). You do **not** create it from scratch. **Do not resume** old content unless the user invoked the command with `resume` as the first argument.
- Format: one line per backlog entry: `status | id | notes` where status is `pending`, `in_progress`, `done`, `blocked`, or `excluded`.
- Update after every entry you finish. Continue until every entry is `done`, `blocked`, or `excluded` with evidence.
- On **complete** run (pending = 0):
  1. Set the file header `status: complete` and add a **Summary** section (counts: done / blocked / excluded).
  2. **Never delete** this file — the extension keeps it as proof of the last run until the next invocation resets it.
  3. Remove any `index.md` entry if you added one by mistake.
  4. State in the final report: `Ficheiro de trabalho: .pi/memory/pages/pi-tools-progress-{skill-id}.md (completo)`.
- On **incomplete** run (pending > 0):
  1. Set the file header `status: incomplete` and note what remains.
  2. State in the report: `Ficheiro de trabalho: ... (incompleto, X pending)`.
  3. **Never** claim the skill finished successfully.
- **Never** use bash `rm` on the progress file — deletion is not part of this workflow.
- **Finding trackers** (bugs, CVEs, `deps-cves.md`, etc.) are separate pages — keep those until the issue is gone from code/manifests. Do not store run backlog in tracker pages.

## Independent verification (the extension checks you)

After your run ends, `pi-tools` inspects the working tree itself and appends a **Verification** section to the progress file. You do not write that section and you cannot influence it.

- It records how many source files and wiki files changed.
- When source files changed, it runs the project's `typecheck` (or `tsc --noEmit`) and `test` scripts and records `pass` / `FAIL` per check.
- A fix skill that claims work but leaves the working tree unchanged is visible there — so do not claim edits you did not make.
- Your own report must not contradict it. Run the same checks yourself while working (you have `Shell`): a fix that breaks typecheck or tests is **not** `done` — either repair it or mark the entry `blocked`.

## Mandatory workflow

### 1. Inventory (from the repo only)

Discover backlog entries with glob/grep/read — **never** from user-provided feature lists or hardcoded module names.

### 2. Backlog

Every inventory item must appear in the progress file before deep work begins.

### 3. Execute (baby-steps)

Process one backlog entry at a time to completion (trace, fix, format, verify, or mark `blocked`/`excluded` with proof). Do not skip ahead to a global summary.

### 4. Evidence

- **Audit skills:** concrete scenario (bug trigger, exploit path, bottleneck, CVE mapping) **and** commands run (`npm audit`, etc.) when the skill requires them.
- **Fix skills:** `Edit`/`Write` on source files **or** `blocked`/`excluded` with line proof — not a narrative-only report.
- Grep alone is a **candidate**; read the line before `excluded`.

### 5. Exit criteria (only these)

- **Complete:** backlog 100% `done`, `blocked`, or `excluded` — set progress `status: complete` and deliver final report with **coverage matrix** (counts + any `blocked`/`excluded` with reason).
- **Incomplete:** set `status: incomplete` and deliver progress report (X/Y done, what is next) — **never** claim "no issues" or "all clean" while `pending` remains.

## Forbidden

- Declaring "no issues found" / "repo clean" / "zero removable" without full backlog coverage and skill-specific verification.
- Stopping because the repo is large or the session is long — continue or leave explicit `pending` and `status: incomplete`.
- Asking the user for confirmation to continue the skill's core work.
- Logging scan notes or run history in finding tracker pages.
- Deleting or `rm`-ing the progress file.
- Marking `complete` on a fix skill with `done: 0` while removable items remain in scope (see skill-specific gates).

## Final report (always)

1. **Coverage** — inventory size, done/blocked/excluded/pending (pending must be 0 on complete).
2. **Actions** — what you fixed, removed, formatted, or audited with evidence.
3. **Proof** — `git diff --stat` and every edited path; zero code edits requires line-level proof for **every** grep hit in **every** backlog file.
4. **Work file** — path to `pi-tools-progress-{skill-id}.md` and `completo` / `incompleto`.
5. **Findings** — open issues tracked in `.pi/memory/pages/` when applicable (tracker pages, not the progress file).
6. **Blocked** — what could not be finished and why (concrete blocker, not token limits).

## Language (all skills)

| Layer | Language | Audience |
|-------|----------|----------|
| Skill prompt (this contract + `SKILL.md`) | **English** | Model executing the skill |
| Final chat report to the user | **European Portuguese (pt-PT)** | Human user |
| Wiki (`.pi/memory/index.md`, `log.md`, `pages/`) | **English** | Models and future sessions |
| Progress file (`pi-tools-progress-*`) | **English** | Last-run work log until next reset |

- Write skill instructions, progress notes, and internal reasoning in **English** — not translated Portuguese.
- Deliver summaries, coverage matrices, and explanations in the chat in **pt-PT** (concise, complete sentences).
- Write or update wiki pages, `log.md`, and tracker entries in **English** only (plain text in `log.md` per project rules).
- When quoting code, paths, or existing wiki text, keep the original language.
