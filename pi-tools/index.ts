import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { Model } from "@earendil-works/pi-ai"

type SkillName =
  | "fix-clean"
  | "fix-format"
  | "maintain-wiki"
  | "audit-bug"
  | "fix-dedupe"
  | "audit-security"
  | "audit-perf"
  | "fix-dead"
  | "audit-deps"
  | "review-diff"

type ReviewScope = {
  label: string
  files: string[]
  untracked: string[]
  excluded: string[]
  stat: string
  range: string[]
}

type RunPhase = "idle" | "starting" | "running"

type MessagePart = { type: string; text?: string }
type SessionMessage = {
  role: string
  content?: MessagePart[]
  stopReason?: string
  errorMessage?: string
}

type VerificationCheck = {
  label: string
  command: string
  args: string[]
}

type ChangedFiles = {
  source: string[]
  wiki: string[]
}

type ChangeSnapshot = Map<string, string>

type ScriptCandidates = {
  typecheck: string[]
  test: string[]
  format: string[]
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(MODULE_DIR, "skills")
const CONFIG_PATH = join(MODULE_DIR, "config.json")

const STATUS_KEY = "pi-tools"
const GIT_TIMEOUT_MS = 15_000
const VERIFY_TIMEOUT_MS = 240_000
const FAILURE_TAIL_LINES = 12

const FORMAT_TIMEOUT_MS = 180_000

/**
 * Conventional script names only. A project that names its scripts differently declares them
 * under `scripts` in config.json — this list must not grow to accommodate one repository.
 */
const DEFAULT_SCRIPT_CANDIDATES: ScriptCandidates = {
  typecheck: ["typecheck", "type-check"],
  test: ["test"],
  format: ["format", "fmt"],
}

const PRETTIER_CONFIG_FILES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.json5",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
]
const BIOME_CONFIG_FILES = ["biome.json", "biome.jsonc"]

/** Never put these in a review backlog: agent/provider state, wiki, and lockfiles. */
const REVIEW_EXCLUDED_PREFIXES = [".pi/"]
const REVIEW_EXCLUDED_FILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
]

function isReviewable(path: string): boolean {
  if (REVIEW_EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false
  const basename = path.slice(path.lastIndexOf("/") + 1)
  return !REVIEW_EXCLUDED_FILES.includes(path) && !REVIEW_EXCLUDED_FILES.includes(basename)
}

let runPhase: RunPhase = "idle"
let activeSkill: SkillName | null = null
let activeCommand: string | null = null
let previousModel: Model<any> | null | undefined = null
let baselineChanges: ChangeSnapshot | null = null

function readConfig(): Record<string, unknown> | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>
  } catch {
    return null
  }
}

function loadSkillModel(skillName: string): string | null {
  const config = readConfig()
  if (!config) return null
  const forSkill = config[skillName]
  if (typeof forSkill === "string" && forSkill) return forSkill
  const fallback = config.model
  return typeof fallback === "string" && fallback ? fallback : null
}

function candidateList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const names = value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
  return names.length > 0 ? names : fallback
}

/** Script names the project actually uses, so verification does not guess per-repo conventions. */
function loadScriptCandidates(): ScriptCandidates {
  const configured = readConfig()?.scripts
  if (!configured || typeof configured !== "object") return DEFAULT_SCRIPT_CANDIDATES

  const scripts = configured as Record<string, unknown>
  return {
    typecheck: candidateList(scripts.typecheck, DEFAULT_SCRIPT_CANDIDATES.typecheck),
    test: candidateList(scripts.test, DEFAULT_SCRIPT_CANDIDATES.test),
    format: candidateList(scripts.format, DEFAULT_SCRIPT_CANDIDATES.format),
  }
}

function loadSharedContract(): string {
  const p = join(SKILLS_DIR, "_shared", "CONTRACT.md")
  if (!existsSync(p)) return ""
  return readFileSync(p, "utf-8").trim()
}

function loadSkillPrompt(skillName: string): string {
  const skillDir = join(SKILLS_DIR, skillName)
  const p = join(skillDir, "SKILL.md")
  if (!existsSync(p)) throw new Error(`Skill ${skillName} not found at ${p}`)
  const raw = readFileSync(p, "utf-8")
  const m = raw.match(/^---\n[\s\S]*?\n---\n\n?([\s\S]*)$/)
  const body = (m ? m[1].trim() : raw.trim()).replaceAll("{{SKILL_DIR}}", skillDir)
  const contract = loadSharedContract()
  if (!contract) return body
  return `${contract}\n\n---\n\n${body}`
}

function progressFileRel(skillName: string): string {
  return `.pi/memory/pages/pi-tools-progress-${skillName}.md`
}

function progressFilePath(cwd: string, skillName: string): string {
  return join(cwd, progressFileRel(skillName))
}

function parseSkillArgs(args: string | undefined): { resume: boolean; rest: string } {
  if (!args || typeof args !== "string") {
    return { resume: false, rest: "" }
  }
  const trimmed = args.trim()
  if (!trimmed) {
    return { resume: false, rest: "" }
  }
  const lower = trimmed.toLowerCase()
  if (lower === "resume") {
    return { resume: true, rest: "" }
  }
  if (lower.startsWith("resume ")) {
    return { resume: true, rest: trimmed.slice(7).trim() }
  }
  return { resume: false, rest: trimmed }
}

function resetProgressFile(
  cwd: string,
  skillName: string,
  command: string,
  backlog: string[] = [],
): void {
  const path = progressFilePath(cwd, skillName)
  mkdirSync(dirname(path), { recursive: true })
  const started = new Date().toISOString()
  const lines = [
    `# pi-tools run — ${skillName}`,
    "",
    `command: /${command}`,
    `started: ${started}`,
    "status: in_progress",
    "",
    "## Backlog",
    "",
    "Format: `status | id | notes`",
    "",
  ]
  if (backlog.length > 0) {
    lines.push("Inventory written by the extension — do not add or drop entries.", "")
    lines.push(...backlog.map((id) => `pending | ${id} |`))
    lines.push("")
  }
  writeFileSync(path, lines.join("\n"), "utf-8")
}

function appendVerificationSection(cwd: string, skillName: string, lines: string[]): void {
  const path = progressFilePath(cwd, skillName)
  if (!existsSync(path)) return
  const current = readFileSync(path, "utf-8").trimEnd()
  const section = ["", "", "## Verification (extension, not model-reported)", "", ...lines, ""]
  writeFileSync(path, `${current}${section.join("\n")}`, "utf-8")
}

function markProgressAborted(cwd: string, skillName: string, reason: string): void {
  const path = progressFilePath(cwd, skillName)
  if (!existsSync(path)) return
  const current = readFileSync(path, "utf-8").replace(
    /^status: in_progress$/m,
    "status: incomplete",
  )
  writeFileSync(path, current, "utf-8")
  appendVerificationSection(cwd, skillName, [
    "result: aborted — the model never ran this skill",
    reason,
  ])
}

function lastAssistantMessage(messages: readonly SessionMessage[]): SessionMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      return messages[i]
    }
  }
  return null
}

function assistantText(message: SessionMessage): string {
  const parts = Array.isArray(message.content) ? message.content : []
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
    .trim()
}

/**
 * When the model never ran (quota, abort, empty reply), verification must not
 * treat the working tree as a completed empty skill.
 */
function skillDidNotRun(messages: readonly SessionMessage[]): string | null {
  const last = lastAssistantMessage(messages)
  if (!last) {
    return "skill did not run — the model produced no output. Retry the command."
  }

  const failed = last.stopReason === "error" || last.stopReason === "aborted"
  if (failed) {
    const detail = last.errorMessage?.trim()
    if (detail) {
      return `skill did not run — ${detail}`
    }
    return `skill did not run — model stopped (${last.stopReason}). Retry the command.`
  }

  if (!assistantText(last)) {
    return "skill did not run — the model produced no output. Retry the command."
  }

  return null
}

function readPackageScripts(cwd: string): Record<string, string> {
  const path = join(cwd, "package.json")
  if (!existsSync(path)) return {}
  try {
    const pkg = JSON.parse(readFileSync(path, "utf-8"))
    if (!pkg.scripts || typeof pkg.scripts !== "object") return {}
    return pkg.scripts as Record<string, string>
  } catch {
    return {}
  }
}

function pickScript(scripts: Record<string, string>, candidates: string[]): string | undefined {
  return candidates.find((name) => typeof scripts[name] === "string")
}

function planVerification(cwd: string): VerificationCheck[] {
  const scripts = readPackageScripts(cwd)
  const candidates = loadScriptCandidates()
  const checks: VerificationCheck[] = []

  const typecheckScript = pickScript(scripts, candidates.typecheck)
  if (typecheckScript) {
    checks.push({
      label: `npm run ${typecheckScript}`,
      command: "npm",
      args: ["run", "--silent", typecheckScript],
    })
  } else if (existsSync(join(cwd, "tsconfig.json"))) {
    checks.push({
      label: "tsc --noEmit",
      command: "npx",
      args: ["--no-install", "tsc", "--noEmit"],
    })
  }

  const testScript = pickScript(scripts, candidates.test)
  if (testScript) {
    checks.push({
      label: `npm run ${testScript}`,
      command: "npm",
      args: ["run", "--silent", testScript],
    })
  }

  return checks
}

function hasPrettierConfig(cwd: string): boolean {
  if (PRETTIER_CONFIG_FILES.some((name) => existsSync(join(cwd, name)))) return true
  const path = join(cwd, "package.json")
  if (!existsSync(path)) return false
  try {
    return JSON.parse(readFileSync(path, "utf-8")).prettier !== undefined
  } catch {
    return false
  }
}

/**
 * Only formatters the project has configured. Running prettier with default settings on a project
 * that never adopted it rewrites every file, which is a decision for the user, not for a command.
 */
function planFormatting(cwd: string, paths: string[] = []): VerificationCheck | null {
  const scripts = readPackageScripts(cwd)
  const formatScript = pickScript(scripts, loadScriptCandidates().format)
  if (formatScript) {
    return {
      label: `npm run ${formatScript}`,
      command: "npm",
      args: ["run", "--silent", formatScript],
    }
  }

  const targets = paths.length > 0 ? paths : ["."]
  if (hasPrettierConfig(cwd)) {
    return {
      label: `prettier --write ${targets.join(" ")}`,
      command: "npx",
      args: ["--no-install", "prettier", "--write", ...targets],
    }
  }
  if (BIOME_CONFIG_FILES.some((name) => existsSync(join(cwd, name)))) {
    return {
      label: `biome format --write ${targets.join(" ")}`,
      command: "npx",
      args: ["--no-install", "biome", "format", "--write", ...targets],
    }
  }
  return null
}

async function applyProjectFormatter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  rest: string,
): Promise<{ note: string } | { error: string }> {
  const paths = rest.split(/\s+/).filter((token) => token.length > 0)
  const check = planFormatting(ctx.cwd, paths)
  if (!check) {
    return {
      note:
        "No project formatter configured. You own indent, wrapping, quotes, " +
        "AND the structural rules.",
    }
  }

  ctx.ui.setStatus(STATUS_KEY, `pi-fix-format: ${check.label}`)
  try {
    const result = await pi
      .exec(check.command, check.args, { cwd: ctx.cwd, timeout: FORMAT_TIMEOUT_MS })
      .catch(() => undefined)

    if (!result || result.code !== 0) {
      const detail = result
        ? tailLines(result.stderr || result.stdout).join("\n")
        : "could not start"
      return { error: `${check.label} failed.\n${detail}` }
    }

    ctx.ui.notify(`/pi-fix-format: ${check.label} — done. Structural pass next.`, "info")
    return {
      note:
        `The extension already ran \`${check.label}\`. Do not redo indent, wrapping, ` +
        "or quotes. Only the structural rules the formatter does not apply.",
    }
  } finally {
    ctx.ui.setStatus(STATUS_KEY, undefined)
  }
}

type NumstatEntry = { added: string; deleted: string; path: string }

function parseNumstatEntry(line: string): NumstatEntry | null {
  const columns = line.split("\t")
  if (columns.length < 3) return null
  const path = columns.slice(2).join("\t").trim()
  if (!path) return null
  return { added: columns[0], deleted: columns[1], path }
}

/** `0/0` means the file's content is identical — only its mode changed. Nothing to review there. */
function hasContentChange(entry: NumstatEntry): boolean {
  return !(entry.added === "0" && entry.deleted === "0")
}

function parsePorcelainPath(line: string): string {
  const path = line.slice(3).trim()
  const renameArrow = path.lastIndexOf(" -> ")
  if (renameArrow === -1) return path
  return path.slice(renameArrow + 4).trim()
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | null> {
  const result = await pi
    .exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS })
    .catch(() => undefined)
  if (!result || result.code !== 0) return null
  return result.stdout
}

function nonEmptyLines(output: string): string[] {
  return output.split("\n").filter((line) => line.trim().length > 0)
}

/**
 * Per-path content fingerprint of the working tree. Mode-only changes report as `0/0` in
 * `--numstat`, so they stay identical between snapshots and never count as skill work.
 */
async function snapshotChanges(pi: ExtensionAPI, cwd: string): Promise<ChangeSnapshot> {
  const snapshot: ChangeSnapshot = new Map()

  const numstat = await runGit(pi, cwd, ["diff", "HEAD", "--numstat", "--no-renames"])
  if (numstat === null) return snapshot
  for (const line of nonEmptyLines(numstat)) {
    const entry = parseNumstatEntry(line)
    if (entry) snapshot.set(entry.path, `${entry.added}/${entry.deleted}`)
  }

  const status = await runGit(pi, cwd, ["status", "--porcelain"])
  if (status === null) return snapshot
  for (const line of nonEmptyLines(status)) {
    if (!line.startsWith("??")) continue
    const path = parsePorcelainPath(line)
    if (path) snapshot.set(path, "untracked")
  }

  return snapshot
}

function splitTouchedPaths(before: ChangeSnapshot, after: ChangeSnapshot): ChangedFiles {
  const touched: string[] = []
  for (const [path, fingerprint] of after) {
    if (before.get(path) !== fingerprint) touched.push(path)
  }
  touched.sort()

  return {
    source: touched.filter((path) => !path.startsWith(".pi/memory/")),
    wiki: touched.filter((path) => path.startsWith(".pi/memory/")),
  }
}

async function resolveBranchBase(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  const candidates: string[] = []
  const originHead = await runGit(pi, cwd, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ])
  if (originHead && originHead.trim()) candidates.push(originHead.trim())
  candidates.push("origin/main", "origin/master", "main", "master")

  for (const candidate of candidates) {
    const base = await runGit(pi, cwd, ["merge-base", "HEAD", candidate])
    if (base && base.trim()) return base.trim()
  }
  return null
}

function parseReviewArgs(rest: string): { branch: boolean; tokens: string[] } {
  const tokens = rest.split(/\s+/).filter((token) => token.length > 0)
  const branch = tokens[0]?.toLowerCase() === "branch"
  return { branch, tokens: branch ? tokens.slice(1) : tokens }
}

async function isGitRev(pi: ExtensionAPI, cwd: string, token: string | undefined): Promise<boolean> {
  if (!token) return false
  const out = await runGit(pi, cwd, ["rev-parse", "--verify", "--quiet", token])
  return out !== null && out.trim().length > 0
}

type BranchRange = { range: string; label: string }

async function resolveBranchRange(
  pi: ExtensionAPI,
  cwd: string,
  explicitBase: string | undefined,
): Promise<BranchRange | null> {
  if (explicitBase) {
    const merged = await runGit(pi, cwd, ["merge-base", "HEAD", explicitBase])
    if (merged && merged.trim()) {
      return { range: `${merged.trim()}..HEAD`, label: `branch changes since ${explicitBase}` }
    }
    return {
      range: `${explicitBase}..HEAD`,
      label: `changes vs ${explicitBase} (no common ancestor, comparing trees)`,
    }
  }

  const base = await resolveBranchBase(pi, cwd)
  if (!base) return null
  return { range: `${base}..HEAD`, label: `branch changes since ${base.slice(0, 12)}` }
}

async function computeReviewScope(
  pi: ExtensionAPI,
  cwd: string,
  rest: string,
): Promise<ReviewScope | { error: string }> {
  const { branch, tokens } = parseReviewArgs(rest)
  const explicitBase = branch && (await isGitRev(pi, cwd, tokens[0])) ? tokens[0] : undefined
  const paths = explicitBase ? tokens.slice(1) : tokens
  const pathArgs = paths.length > 0 ? ["--", ...paths] : []

  let range: string[] = ["HEAD"]
  let label = "uncommitted changes vs HEAD"
  if (branch) {
    const resolved = await resolveBranchRange(pi, cwd, explicitBase)
    if (!resolved) {
      return {
        error:
          "could not resolve a branch base (no origin/HEAD, main or master with a common " +
          "ancestor). Pass one explicitly: /pi-review branch <ref>",
      }
    }
    range = [resolved.range]
    label = resolved.label
  }

  const numstat = await runGit(pi, cwd, [
    "diff",
    ...range,
    "--numstat",
    "--no-renames",
    ...pathArgs,
  ])
  if (numstat === null) {
    return { error: "git diff failed — is this a git repository?" }
  }

  const tracked = nonEmptyLines(numstat)
    .map(parseNumstatEntry)
    .filter((entry): entry is NumstatEntry => entry !== null)
    .filter(hasContentChange)
    .map((entry) => entry.path)

  const untrackedAll: string[] = []
  if (!branch) {
    const status = await runGit(pi, cwd, ["status", "--porcelain", ...pathArgs])
    for (const line of nonEmptyLines(status ?? "")) {
      if (!line.startsWith("??")) continue
      const path = parsePorcelainPath(line)
      if (path && !tracked.includes(path)) untrackedAll.push(path)
    }
  }
  if (paths.length > 0) {
    label = `${label} (${paths.join(", ")})`
  }

  const changed = [...tracked, ...untrackedAll]
  const stat =
    (await runGit(pi, cwd, ["diff", ...range, "--stat", "--no-renames", ...pathArgs])) ?? ""

  return {
    label,
    files: changed.filter(isReviewable).sort(),
    untracked: untrackedAll.filter(isReviewable).sort(),
    excluded: changed.filter((path) => !isReviewable(path)).sort(),
    stat: stat.trim(),
    range,
  }
}

function tailLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-FAILURE_TAIL_LINES)
    .map((line) => `    ${line}`)
}

async function runVerification(
  pi: ExtensionAPI,
  cwd: string,
  checks: VerificationCheck[],
): Promise<{ report: string[]; failed: string[] }> {
  const report: string[] = []
  const failed: string[] = []

  for (const check of checks) {
    const result = await pi
      .exec(check.command, check.args, { cwd, timeout: VERIFY_TIMEOUT_MS })
      .catch(() => undefined)

    if (!result) {
      failed.push(check.label)
      report.push(`FAIL | ${check.label} | could not start`)
      continue
    }

    const timedOut = result.killed === true
    const passed = result.code === 0 && !timedOut
    const suffix = timedOut ? " (timeout)" : ""
    report.push(`${passed ? "pass" : "FAIL"} | ${check.label} | exit ${result.code}${suffix}`)

    if (!passed) {
      failed.push(check.label)
      report.push(...tailLines(result.stderr || result.stdout))
    }
  }

  return { report, failed }
}

async function verifyRun(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  command: string,
  skillName: SkillName,
  baseline: ChangeSnapshot,
): Promise<void> {
  const changed = splitTouchedPaths(baseline, await snapshotChanges(pi, ctx.cwd))
  const report = [
    `touched by this run: ${changed.source.length} source file(s), ${changed.wiki.length} wiki file(s)`,
    ...changed.source.map((path) => `  source | ${path}`),
  ]

  if (changed.source.length === 0) {
    const wikiOnly = changed.wiki.length > 0
    report.push(
      wikiOnly
        ? "checks skipped — wiki-only run, no source edits to verify"
        : "checks skipped — the run left the working tree unchanged",
    )
    appendVerificationSection(ctx.cwd, skillName, report)
    const message = wikiOnly
      ? `/${command}: wiki-only changes, nothing to verify.`
      : `/${command}: no file changes — check the report claims work was done.`
    ctx.ui.notify(message, wikiOnly ? "info" : "warning")
    return
  }

  const checks = planVerification(ctx.cwd)
  if (checks.length === 0) {
    report.push("checks skipped — no typecheck or test script found in package.json")
    appendVerificationSection(ctx.cwd, skillName, report)
    ctx.ui.notify(
      `/${command}: ${changed.source.length} file(s) changed, no verification available.`,
      "warning",
    )
    return
  }

  ctx.ui.setStatus(STATUS_KEY, `${command}: verifying (${checks.length} check(s))`)
  try {
    const { report: checkReport, failed } = await runVerification(pi, ctx.cwd, checks)
    report.push(...checkReport)
    report.push("", failed.length === 0 ? "result: verified" : `result: FAILED (${failed.join(", ")})`)
    appendVerificationSection(ctx.cwd, skillName, report)

    if (failed.length === 0) {
      ctx.ui.notify(`/${command} done — ${changed.source.length} file(s), checks passed.`, "info")
      return
    }
    ctx.ui.notify(`/${command}: VERIFICATION FAILED — ${failed.join(", ")}.`, "error")
  } finally {
    ctx.ui.setStatus(STATUS_KEY, undefined)
  }
}

type SkillLaunch = {
  backlog: string[]
  context: string
}

/**
 * Builds the concrete task context. For review-diff the extension owns the inventory, so the model
 * cannot invent or shrink the backlog; every other skill still discovers its own.
 */
async function prepareLaunch(
  pi: ExtensionAPI,
  cwd: string,
  skillName: SkillName,
  rest: string,
): Promise<SkillLaunch | { error: string }> {
  if (skillName !== "review-diff") {
    return { backlog: [], context: rest ? ` ${rest}` : "" }
  }

  const scope = await computeReviewScope(pi, cwd, rest)
  if ("error" in scope) return scope
  if (scope.files.length === 0) {
    return { error: `nothing to review — ${scope.label} is empty` }
  }

  const lines = [
    "",
    "",
    `Scope: ${scope.label}.`,
    `Read each change with: git diff ${scope.range.join(" ")} -- <path>`,
    "",
    `Backlog (${scope.files.length} file(s), already written to the progress file by the extension —`,
    "do not add or drop entries):",
    ...scope.files.map((path) => `- ${path}`),
  ]

  if (scope.untracked.length > 0) {
    lines.push(
      "",
      "These are new and untracked, so git diff shows nothing — read the whole file:",
      ...scope.untracked.map((path) => `- ${path}`),
    )
  }

  if (scope.excluded.length > 0) {
    lines.push(
      "",
      "Excluded from review (.pi/ and lockfiles) — do not open them:",
      ...scope.excluded.map((path) => `- ${path}`),
    )
  }

  if (scope.stat) {
    lines.push("", "Diff stat:", scope.stat)
  }

  return { backlog: scope.files, context: lines.join("\n") }
}

const COMMAND_NAMES: Record<string, SkillName> = {
  "pi-audit-bug": "audit-bug",
  "pi-audit-dependencies": "audit-deps",
  "pi-audit-performance": "audit-perf",
  "pi-audit-security": "audit-security",
  "pi-fix-dead-code": "fix-dead",
  "pi-fix-deduplicate": "fix-dedupe",
  "pi-fix-format": "fix-format",
  "pi-fix-remove-comments": "fix-clean",
  "pi-maintain-wiki": "maintain-wiki",
  "pi-review": "review-diff",
}

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  "pi-audit-bug": "Bugs graves; inventário + traces; corrige com prova",
  "pi-audit-dependencies": "Supply-chain: patches CVE auto; majors = migração",
  "pi-audit-performance": "Perf: inventário + traces; corrige bottlenecks",
  "pi-audit-security": "Segurança; fronteiras + cenário de exploit",
  "pi-fix-dead-code": "Remove código morto com prova",
  "pi-fix-deduplicate": "Unifica código repetido",
  "pi-fix-format": "Estilo estrutural; formatador do projeto primeiro se existir",
  "pi-fix-remove-comments": "Apaga comentários com precisão; why → wiki",
  "pi-maintain-wiki": "Alinha wiki com código; preserva histórico",
  "pi-review": "Revê só o que mudou (bug, segurança, perf, duplicação)",
}

export default function (pi: ExtensionAPI) {
  async function restorePreviousModel(): Promise<void> {
    if (!previousModel) return
    const model = previousModel
    previousModel = null
    await pi.setModel(model)
  }

  function resetRunState(): void {
    runPhase = "idle"
    activeSkill = null
    activeCommand = null
    baselineChanges = null
  }

  async function applySkillModel(ctx: ExtensionContext, skillName: SkillName): Promise<void> {
    const skillModelId = loadSkillModel(skillName)
    if (!skillModelId) {
      ctx.ui.notify(`No model configured for ${skillName}, using current.`, "warning")
      return
    }

    const separator = skillModelId.indexOf("/")
    const provider = separator > 0 ? skillModelId.slice(0, separator) : undefined
    const modelId = separator > 0 ? skillModelId.slice(separator + 1) : skillModelId
    const model = provider ? ctx.modelRegistry.find(provider, modelId) : undefined
    if (!model) {
      ctx.ui.notify(`Model "${skillModelId}" not found, using current.`, "warning")
      return
    }

    previousModel = ctx.model
    const ok = await pi.setModel(model)
    if (!ok) {
      ctx.ui.notify(`${skillModelId} unavailable, using current.`, "warning")
    }
  }

  pi.on("before_agent_start", () => {
    if (runPhase !== "starting") return
    runPhase = "running"
  })

  pi.on("agent_end", async (event, ctx) => {
    if (runPhase !== "running") return
    const command = activeCommand
    const skillName = activeSkill
    const baseline = baselineChanges ?? new Map<string, string>()
    resetRunState()
    await restorePreviousModel()
    if (!command || !skillName) return

    const aborted = skillDidNotRun(event.messages as readonly SessionMessage[])
    if (aborted) {
      markProgressAborted(ctx.cwd, skillName, aborted)
      ctx.ui.notify(`/${command}: ${aborted}`, "error")
      return
    }

    await verifyRun(pi, ctx, command, skillName, baseline)
  })

  for (const [name, skillName] of Object.entries(COMMAND_NAMES)) {
    pi.registerCommand(name, {
      description: COMMAND_DESCRIPTIONS[name] ?? skillName,
      handler: async (args, ctx) => {
        try {
          if (!ctx.isIdle()) {
            ctx.ui.notify(`/${name}: waiting for agent to finish...`, "info")
            await ctx.waitForIdle()
          }

          const prompt = loadSkillPrompt(skillName)
          const { resume, rest } = parseSkillArgs(
            args && typeof args === "string" ? args : undefined,
          )

          const launch = await prepareLaunch(pi, ctx.cwd, skillName, rest)
          if ("error" in launch) {
            ctx.ui.notify(`/${name}: ${launch.error}`, "warning")
            return
          }

          const rel = progressFileRel(skillName)
          if (resume) {
            ctx.ui.notify(`/${name}: resume — keeping ${rel}`, "info")
          } else {
            resetProgressFile(ctx.cwd, skillName, name, launch.backlog)
            const inventory =
              launch.backlog.length > 0 ? ` (${launch.backlog.length} entries)` : ""
            ctx.ui.notify(`/${name}: reset ${rel}${inventory}`, "info")
          }

          baselineChanges = await snapshotChanges(pi, ctx.cwd)

          let context = launch.context
          if (skillName === "fix-format" && !resume) {
            const formatted = await applyProjectFormatter(pi, ctx, rest)
            if ("error" in formatted) {
              resetRunState()
              markProgressAborted(ctx.cwd, skillName, `formatter failed: ${formatted.error}`)
              ctx.ui.notify(`/${name}: ${formatted.error}`, "error")
              return
            }
            context = `${context}\n\n${formatted.note}`
          }

          await applySkillModel(ctx, skillName)

          activeSkill = skillName
          activeCommand = name
          runPhase = "starting"
          const userMsg = resume
            ? `Run the ${skillName} skill (resume — progress file was not reset).${context}`
            : `Run the ${skillName} skill.${context}`
          pi.sendMessage({
            customType: `pi-tools-${skillName}`,
            content: prompt,
            display: false,
          })
          pi.sendUserMessage(userMsg)
        } catch (e: unknown) {
          resetRunState()
          await restorePreviousModel()
          ctx.ui.notify(`/${name}: ${e instanceof Error ? e.message : String(e)}`, "error")
        }
      },
    })
  }
}
