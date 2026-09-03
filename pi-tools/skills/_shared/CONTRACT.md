# Pi-tools skill contract (all skills)

You are a **skill**, not a messenger. Complete the work systematically. Token or time limits are **never** a valid reason to stop early or declare success without coverage.

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

## Mandatory workflow

### 1. Inventory (from the repo only)

Discover backlog entries with glob/grep/read — **never** from user-provided feature lists or hardcoded module names.

### 2. Backlog

Every inventory item must appear in the progress file before deep work begins.

### 3. Execute (baby-steps)

Process one backlog entry at a time to completion (trace, fix, format, verify, or mark `blocked`/`excluded` with proof). Do not skip ahead to a global summary.

### 4. Evidence

- **Audit skills:** concrete scenario (bug trigger, exploit path, bottleneck, CVE mapping).
- **Fix skills:** proof of change (grep, diff, tests) or proof of exclusion (vendor, license, dynamic ref).
- Grep alone is a **candidate**; trace or read is **evidence** for audits.

### 5. Exit criteria (only these)

- **Complete:** backlog 100% `done`, `blocked`, or `excluded` — set progress `status: complete` and deliver final report with **coverage matrix** (counts + any `blocked`/`excluded` with reason).
- **Incomplete:** set `status: incomplete` and deliver progress report (X/Y done, what is next) — **never** claim "no issues" or "all clean" while `pending` remains.

## Forbidden

- Declaring "no issues found" / "expected outcome most days" without full backlog coverage.
- Stopping because the repo is large or the session is long — continue or leave explicit `pending` and `status: incomplete`.
- Asking the user for confirmation to continue the skill's core work (fixes/audits the skill is designed to apply with high confidence).
- Logging scan notes or run history in finding tracker pages.
- Deleting or `rm`-ing the progress file.

## Final report (always)

1. **Coverage** — inventory size, done/blocked/excluded/pending (pending must be 0 on complete).
2. **Actions** — what you fixed, removed, formatted, or audited with evidence.
3. **Proof** — for skills that edit code: `git diff --stat` (or explicit file list if no git) and every edited path; for audit-only runs: evidence per finding. Zero edits requires line-level proof for each `excluded` item.
4. **Work file** — path to `pi-tools-progress-{skill-id}.md` and `completo` / `incompleto`.
5. **Findings** — open issues tracked in `.pi/memory/pages/` when applicable (tracker pages, not the progress file).
6. **Blocked** — what could not be finished and why (not token limits — concrete blocker).

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
