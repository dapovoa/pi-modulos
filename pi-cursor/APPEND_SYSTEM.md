# Guidelines

Behavioral guidelines to reduce common coding mistakes, on LLM coding pitfalls.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Do not reformat or "improve" **unrelated** code, comments, or blocks you did not need to change.
- Do not refactor things that aren't broken.
- Match existing style in **untouched** code only — never copy a style that is bad (see Code Style & Readability below).
- **Every line you add or change** must already meet Code Style before you finish. Surgical scope does not excuse messy new code.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## Code Style & Readability

The code around you may be messy - that is not a license to match it. Every line you add, edit or move must be clean and readable, regardless of how the surrounding code looks. Never copy the surrounding style when it is bad.

**Formatting:** Consistent 2-space indentation. One statement per line; no chained ternaries (`a ? b : c ? d : e`), no long && / || chains - split into named booleans. Braces always, even for one-line ifs. Max ~100 chars per line; wrap long arguments one per line. Blank lines between logical blocks. If a project formatter (prettier/eslint/biome) is configured, run it and let it decide whitespace; if not, these rules are the standard.

**Delivery (tool edits):** Never write compressed one-line blocks, collapsed indentation, or patches that squeeze multiple statements onto one line. Every line you add or change must already be readable before you finish — do not rely on a later formatter pass. If an edit would be unreadable, split it into smaller blocks instead of shipping spaghetti.

**Structure:** Keep functions short and single-purpose; if one needs a comment to explain its job, split it. Max ~3 levels of indentation; extract helpers beyond that. Early return instead of else nesting. Name things for what they do - verbs for functions, nouns for data; no `data`/`temp`/`x`/`obj` for non-trivial values. No copy-paste of blocks over ~5 lines. Each function reads top-to-bottom; no spaghetti control flow.

**Types (TS):** Prefer explicit types over `any`; define interfaces for shared shapes. No type gymnastics (double casts, `as unknown as`, `@ts-ignore` to silence real errors). Import only what you use.

**Changes:** The code YOU touch becomes clean, even if the surrounding code is not. Format every line you add or change; never reformat unrelated files or unrelated blocks. No dead code, commented-out blocks, or `console.log` leftovers in deliverables. Deliver complete, working code - no stubs or TODOs unless asked.

**File scope (never touch):** never edit `node_modules/`, `dist/`, `build/`, `.astro/`, `.wrangler/`, `.next/`, `.firecrawl/`, generated files, `.git/`, lockfiles, or the REST of `.pi/` outside the wiki: never touch `.pi/cursor-agents.json`, `.pi/pi-block-state.json`, or `.pi/agent/` (provider state, global config with credentials). `.pi/memory/` (the wiki) is yours to edit - register findings there. The `.cursorignore` exclusions are intentional boundaries - do not bypass them with shell/rg. Never edit vendor or third-party code, even inside `src/`: files with a license header, "extract from ... source", "Copyright ... Authors", bundled/minified third-party code - inspect if needed, never modify.

**Frontend: ZERO comments (hard rule):** any file that ships to the frontend (.tsx/.jsx/.vue/.svelte/.astro, .ts/.js imported by UI, bundled .css/.scss, HTML) must contain NO comments - not even "simple" ones, section titles, TODOs, or commented-out code. Document frontend decisions in the project wiki or README, never in the source. Only exception: license headers if the build requires them.

## API and error responses

**Principle:** Clients see safe, generic, or curated text. Internal detail stays in server logs only.

**Backend:**
- Never return raw `err.message`, stack traces, SQL errors, vendor API text, file paths, or internal service names in JSON responses.
- In `catch` blocks: log full detail server-side; respond with a **fixed string** or status-based generic message.
- `5xx`: always a single generic message. Global `onError` handlers must sanitize unhandled exceptions.
- `4xx` validation: only **literal strings written in the route handler** — not values propagated from exceptions or downstream libraries.
- Do not pass `result.error` to the client unless you know it is a curated user-facing string.

**Frontend:**
- Never show `err.message`, `error.message`, or server JSON `message`/`error` fields directly in UI (`toast`, `setError`, alerts).
- Use a central helper that maps **HTTP status → fixed copy**, with an explicit per-call fallback.
- The helper must not prefer server text over status fallbacks for `5xx`. For `4xx`, prefer status fallbacks unless the project documents an explicit allowlist (e.g. auth UX strings).
- Network/offline (`status === 0`): fixed client-side copy only.

**When touching error handling:** fix the central helper first, then call sites — not the reverse.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## Git Safety - highest priority
- Never run git commit or git push without explicit user confirmation.
- Do not assume the user wants changes committed. Ask first.
- This applies to every task and every skill: fixes, refactors, formatting and wiki edits are all delivered as working-tree changes; committing or pushing requires the user's explicit go-ahead.

## LLM Wiki Maintenance

Every project has a wiki in `.pi/memory/` that you maintain. This is your
persistent memory across sessions. Neglecting it causes repeated mistakes.

### Files

| File | Purpose | When to update |
|------|---------|----------------|
| `index.md` | Catalog of all active pages with `[[wikilinks]]` | After creating, renaming, or deleting any page |
| `log.md` | Append-only chronological log | After any non-trivial task - one line: date + what was done |
| `pages/<topic>.md` | One file per active topic | When a topic evolves (new info, decisions, fixes) |

### When to create a page
- A bug was diagnosed and fixed → page with root cause + fix
- A system was configured (hardware, tool, provider, project) → page with setup details
- A workflow or convention was established → page documenting it
- A project or service was set up → page with deploy/domain info

### When to update a page
- Same topic, new information → append, don't duplicate
- A fix replaces an earlier workaround → update, note what changed
- Status changed (e.g., "verified working") → update header/title

### When to remove a page
- Only remove a page that is pure REFERENCE and provably dead (the code it describes no longer exists).
- Never remove PROCESS/HISTORY content: failed attempts, findings, decisions, lessons are the record of the journey and stay even when the code moved on.
- When in doubt, keep the page.
- When removing, update index.md to remove the link and note it in log.md.

### Log format
```
## YYYY-MM-DD - short description
- key detail 1
- key detail 2
```
No repetition of what's already in the page. The log is a timeline, not a mirror.

### Writing rules
- Language: English
- Format: Markdown (headings, lists, code blocks)
- Be factual, not speculative. Only things that actually happened.
- Keep pages focused. One topic per page. If a page grows too long, split it.
- Use `[[wikilinks]]` in index.md to reference pages.

### Summerize
When the user asks for a session summary, invoke `/skill:summerize` instead of
writing a summary manually. The skill creates structured summaries in
`.pi/memory/summaries/YYYY-MM-DD.md` and updates index.md automatically.
