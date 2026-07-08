/**
 * Cursor Provider for pi
 * Uses @cursor/sdk to access Cursor's agent API.
 *
 * Architecture:
 * - Agent runs LOCAL (local: { cwd }) — not cloud. Loop runs inline
 *   in pi's Node process with direct filesystem access. Inference
 *   goes to Cursor's hosted models.
 * - Agent.send() handles the full agent loop internally (inference + tool exec)
 * - Text/thinking/shell output streamed via onDelta callback
 * - Tool calls visible as thinking events (user sees what Agent is doing)
 * - Run lifecycle via onDidChangeStatus; wedged-run recovery via local.force
 * - Security: Cursor hooks (beforeShellExecution) block dangerous commands.
 *   No sandbox (sandboxOptions.enabled defaults to false). Hooks are the
 *   only barrier.
 * - State: Agent uses SQLite checkpoints for conversation continuity.
 * - Crash recovery: agent IDs persisted to .pi/cursor-agents.json.
 *   On restart, live agents are resumed via Agent.resume().
 * - Error recovery: typed SDK errors (RateLimit, AgentBusy, Auth).
 * - Compaction: on session_before_compact we close all active Cursor agents,
 *   forget persisted agent IDs, and abort any in-flight operation. This lets
 *   pi perform its compaction and token accounting normally. After compaction
 *   the next cursorStream does a fresh Agent.create (SDK owns its own SQLite
 *   history). We no longer try to resume pre-compaction agents, avoiding
 *   "Cannot continue from message role: assistant".
 * - Image support: validates mime types, rejects URLs, warns on bad data.
 * - System prompt: pi behavioural rules written to .cursor/rules/*.mdc.
 *   Cursor loads them as project rules via settingSources: ["project"].
 *   This puts rules in the system prompt (cached by Anthropic) instead of
 *   the user message (which changes every turn and defeats caching).
 *
 * Auth: add to .pi/agent/auth.json: "pi-cursor": { "type": "api_key", "key": "sk-..." }
 * Get a key at https://cursor.com/dashboard/api
 */

import { execSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  type Api, type AssistantMessage, type AssistantMessageEventStream,
  type Context, type Model, type SimpleStreamOptions,
  calculateCost, createAssistantMessageEventStream,
} from "@earendil-works/pi-ai"


const PLUGIN_DIR = fileURLToPath(new URL(".", import.meta.url))
const LOG_DIR = join(PLUGIN_DIR, "logs")
let _logDirReady = false
function ensureLogDir() {
  if (_logDirReady) return
  try { mkdirSync(LOG_DIR, { recursive: true }); _logDirReady = true } catch {
    
  }
}
function piLog(level: string, message: string, ...args: unknown[]) {
  ensureLogDir()
  if (!_logDirReady) return
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10)
  const extra = args.length
    ? " " + args.map(a => {
        if (a instanceof Error) return a.message
        return typeof a === "string" ? a : JSON.stringify(a)
      }).join(" ")
    : ""
  const line = `[${now.toISOString()}] [${level.toUpperCase()}] ${message}${extra}\n`
  try {
    appendFileSync(join(LOG_DIR, `pi-cursor-${dateStr}.log`), line, { flag: "a" })
  } catch {
    _logDirReady = false
  }
}


const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07/g
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}
type ActiveAgentEntry = {
  agent: any
  agentId: string
  lastUsed: number
  cwd: string
  sessionId: string
}

const activeAgents = new Map<string, ActiveAgentEntry>()
const stuckAgentIds = new Set<string>()
const AGENTS_FILE = ".pi/cursor-agents.json"
const sessionCwds = new Map<string, string>()
const compactedSessions = new Set<string>()
let defaultSessionCwd = process.cwd()
let lastStreamSessionId: string | undefined


setInterval(() => {
  for (const agentId of [...stuckAgentIds]) {
    let exists = false
    for (const [, entry] of activeAgents) {
      if (entry.agentId === agentId) {
        exists = true
        break
      }
    }
    if (!exists) stuckAgentIds.delete(agentId)
  }
}, 30 * 60 * 1000)

function providedSessionId(...sources: any[]): string | undefined {
  for (const source of sources) {
    const candidates = [source, source?.sessionId, source?.session?.id]
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim()
      }
    }
  }
  return undefined
}

function getSessionId(...sources: any[]): string {
  const provided = providedSessionId(...sources)
  if (provided) return provided
  if (lastStreamSessionId) return lastStreamSessionId
  const newId = `session-${randomUUID().slice(0, 8)}`
  return newId
}

function hasProvidedSessionId(...sources: any[]): boolean {
  return providedSessionId(...sources) !== undefined
}

function setSessionCwd(sessionId: string | undefined, cwd?: string) {
  if (!cwd || !cwd.trim()) return
  const sid = getSessionId(sessionId)
  const normalizedCwd = cwd.trim()
  sessionCwds.set(sid, normalizedCwd)
  defaultSessionCwd = normalizedCwd
}

function getSessionCwd(sessionId?: string): string {
  const sid = getSessionId(sessionId)
  return sessionCwds.get(sid) ?? defaultSessionCwd
}

function inferSessionIdFromContext(ctx?: Context): string | undefined {
  if (!ctx?.messages?.length) return undefined
  const firstUser = ctx.messages.find(msg => msg.role === "user")
  if (!firstUser || typeof firstUser.timestamp !== "number") return undefined
  return `ctx-${firstUser.timestamp}`
}


let _cursorAbort: AbortController | null = null


const CRASH_GUARD_COOLDOWN_MS = 5000
let _crashGuardLastFiredAt = 0

const CURSOR_CRASH_TAG = "[pi-cursor-crash-guard]"

function installCrashGuards() {
  const existing = process.listeners("unhandledRejection") as Array<(...a: unknown[]) => void>
  if (existing.some(fn => (fn as any)._piCursorTag === CURSOR_CRASH_TAG)) return

  const isCursorError = (reason: any): boolean => {
    const msg = reason instanceof Error ? reason.message : String(reason)
    if (reason?.code === 16 || reason?.code === 13) return true
    if (msg.includes("unauthenticated") || msg.includes("ConnectError") ||
        msg.includes("ENHANCE_YOUR_CALM") || msg.includes("Stream closed")) return true
    if (reason?.details?.some?.((d: any) => d.type?.includes("aiserver"))) return true
    return false
  }

  function guardedAbort(label: string, errMsg: string) {
    const now = Date.now()
    if (now - _crashGuardLastFiredAt < CRASH_GUARD_COOLDOWN_MS) {
      piLog("warn", label + " ignored (cooldown active, stale gRPC cascade):", errMsg)
      return
    }
    const captured = _cursorAbort
    if (!captured || captured.signal.aborted) return
    _crashGuardLastFiredAt = now
    piLog("warn", label + ":", errMsg)
    captured.abort()
    if (_cursorAbort === captured) _cursorAbort = null
  }

  const onUnhandledRejection = (reason: any) => {
    if (!isCursorError(reason)) {
      piLog("error", "Unhandled rejection (non-Cursor):", reason)
      return
    }
    guardedAbort(
      "Crash guard (unhandledRejection)",
      reason instanceof Error ? reason.message : String(reason),
    )
  }
  ;(onUnhandledRejection as any)._piCursorTag = CURSOR_CRASH_TAG

  const onUncaughtException = (err: Error) => {
    if (!isCursorError(err)) {
      piLog("error", "Uncaught exception (non-Cursor), re-throwing:", err.message)
      throw err
    }
    guardedAbort("Crash guard (uncaughtException)", err.message)
  }
  ;(onUncaughtException as any)._piCursorTag = CURSOR_CRASH_TAG

  process.on("unhandledRejection", onUnhandledRejection)
  process.on("uncaughtException", onUncaughtException)
}


const AGENT_MAX_IDLE_MS = 8 * 60 * 1000


const AGENT_HANG_TIMEOUT_MS = 10 * 60 * 1000

type CompactionMode = "pi" | "extension"
const COMPACTION_MODE: CompactionMode =
  (process.env.PI_CURSOR_COMPACTION_MODE ?? "pi").toLowerCase() === "pi"
    ? "pi"
    : "extension"


const DELEGATED_SUMMARY_ONLY_KEEP_ID = "__pi-cursor-summary-only__"


interface CursorParam { id: string; value: string }
const paramRegistry = new Map<string, { modelId: string; params?: CursorParam[] }>()

interface AgentState { agents: Record<string, string> }

function getSessionIdFromStateKey(key: string): string | undefined {
  const lastSep = key.lastIndexOf("|")
  if (lastSep <= 0) return undefined
  const secondLastSep = key.lastIndexOf("|", lastSep - 1)
  if (secondLastSep < 0 || secondLastSep + 1 >= lastSep) return undefined
  return key.slice(secondLastSep + 1, lastSep)
}

function loadAgentState(cwd: string): AgentState {
  const fp = join(cwd, AGENTS_FILE)
  try {
    if (existsSync(fp)) return JSON.parse(readFileSync(fp, "utf-8"))
  } catch {}
  return { agents: {} }
}

function saveAgentState(cwd: string, state: AgentState) {
  const fp = join(cwd, AGENTS_FILE)
  try { writeFileSync(fp, JSON.stringify(state), "utf-8") } catch {}
}

function buildDelegatedCompaction(prep: any) {
  return {
    compaction: {
      summary:
        "Compaction delegated to pi-cursor. Conversation continuity is handled by the Cursor SDK local checkpoint store.",
      firstKeptEntryId: DELEGATED_SUMMARY_ONLY_KEEP_ID,
      tokensBefore: typeof prep?.tokensBefore === "number" ? prep.tokensBefore : 0,
      details: { provider: "pi-cursor", mode: "extension-delegated", keepRecent: false },
    },
  }
}

const DANGEROUS_PATTERNS = [
  String.raw`\bgit\s+push\b`, String.raw`\bgit\s+commit\b`,
  String.raw`\bgit\s+reset\s+--hard\b`, String.raw`\bgit\s+clean\b`,
  String.raw`\bgit\s+checkout\s+--\s+\.`, String.raw`\bgit\s+restore\s+\.`,
  String.raw`\bgit\s+branch\s+-D\b`, String.raw`\bgit\s+stash\s+(?:drop|clear)\b`,
  String.raw`\brm\s+(?:-[a-zA-Z]*[rf]+[a-zA-Z]*\s+|-[rf]+\s).*`,
  String.raw`\brm\s+-rf?\b`, String.raw`\brm\s+-fr\b`, String.raw`\bsudo\b`,
  String.raw`\bchmod\s+.*777\b`, String.raw`\bchown\b`,
  String.raw`:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;:`, String.raw`>\s*\/dev\/sd[a-z]`,
  String.raw`\bdd\s+if=`, String.raw`\bcurl\b.+\|\s*(?:ba)?sh\b`,
  String.raw`\bwget\b.+\|\s*(?:ba)?sh\b`, String.raw`\bmkfs\.`, String.raw`\bfdisk\b`,
  String.raw`\b(shutdown|reboot|poweroff|halt)\b`,
]
const HOOK_MATCHER = DANGEROUS_PATTERNS.map(s => s.replace(/\\b/g, "")).join("|")

function genHookScript(): string {
  return `#!/bin/bash
# pi-block hook for Cursor Agent - installed by pi-cursor
B=true;SF="";D="$PWD"
while [ -n "$D" ] && [ "$D" != "/" ]; do
  [ -f "$D/.pi/pi-block-state.json" ] && { SF="$D/.pi/pi-block-state.json"; break; }
  D="$(dirname "$D")"
done
[ -n "$SF" ] && { X=$(grep -o '"blocked":[^,}]*' "$SF" 2>/dev/null|head -1|sed 's/.*: *//');[ "$X" = "false" ]&&B=false; }
[ "$B" = "true" ] && exit 2
exit 0
`
}

function installHooks(cwd: string) {
  const hd = join(cwd, ".cursor", "hooks"); const hf = join(cwd, ".cursor", "hooks.json")
  const sf = join(hd, "pi-block.sh")
  mkdirSync(hd, { recursive: true })
  writeFileSync(sf, genHookScript(), "utf-8")
  try { execSync(`chmod +x "${sf}"`, { timeout: 1000 }) } catch {}
  let existing: any = {}
  try { if (existsSync(hf)) existing = JSON.parse(readFileSync(hf, "utf-8")) } catch {}
  if (!existing.hooks) existing.hooks = {}
  if (!existing.hooks.beforeShellExecution) existing.hooks.beforeShellExecution = []
  existing.hooks.beforeShellExecution = existing.hooks.beforeShellExecution.filter(
    (h: any) => !h.command?.includes("pi-block"))
  existing.hooks.beforeShellExecution.push({ command: ".cursor/hooks/pi-block.sh", timeout: 5, matcher: HOOK_MATCHER })
  existing.version = existing.version ?? 1
  writeFileSync(hf, JSON.stringify(existing, null, 2), "utf-8")
}

function removeHooks(cwd: string) {
  const hf = join(cwd, ".cursor", "hooks.json")
  const sf = join(cwd, ".cursor", "hooks", "pi-block.sh")
  try {
    if (existsSync(hf)) {
      const d = JSON.parse(readFileSync(hf, "utf-8"))
      if (d.hooks?.beforeShellExecution) {
        d.hooks.beforeShellExecution = d.hooks.beforeShellExecution.filter((h: any) => !h.command?.includes("pi-block"))
        if (d.hooks.beforeShellExecution.length === 0) delete d.hooks.beforeShellExecution
        if (!d.hooks || Object.keys(d.hooks).length === 0) delete d.hooks
        if (Object.keys(d).length === 1 && d.version) unlinkSync(hf)
        else writeFileSync(hf, JSON.stringify(d, null, 2), "utf-8")
      }
    }
  } catch {}
  try { unlinkSync(sf) } catch {}
}

function getApiKey(sessionId?: string): string | undefined {
  const candidates = [
    process.env.PI_CODING_AGENT_DIR && join(process.env.PI_CODING_AGENT_DIR, "auth.json"),
    join(getSessionCwd(sessionId), ".pi", "agent", "auth.json"),
    join(homedir(), ".pi", "agent", "auth.json"),
  ].filter((p): p is string => !!p)
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const auth = JSON.parse(readFileSync(p, "utf-8"))
        const entry = auth["pi-cursor"]
        if (entry?.key) return entry.key
      }
    } catch {}
  }
  return process.env.CURSOR_API_KEY
}

interface CursorModelEntry {
  id: string; displayName: string
  parameters?: Array<{ id: string; values: Array<{ value: string }> }>
  variants?: Array<{ params: Array<{ id: string; value: string }>; isDefault?: boolean }>
}

function parseCtxValue(value: string): number {
  if (value.endsWith("m")) return parseInt(value) * 1_000_000
  if (value.endsWith("k")) return parseInt(value) * 1_000
  const n = parseInt(value)
  return isNaN(n) ? 0 : n
}

function hasVision(m: CursorModelEntry): boolean {
  const paramIds = new Set(m.parameters?.map(p => p.id) ?? [])
  const visionHints = ["thinking", "reasoning", "vision", "image", "multimodal"]
  for (const hint of visionHints) {
    if (paramIds.has(hint)) return true
  }
  for (const param of m.parameters ?? []) {
    if (param.values?.some(v => /vision|image|multimodal/i.test(v.value))) return true
  }
  if (/vision/i.test(m.displayName)) return true
  return /^(gemini|grok|kimi)-/i.test(m.id)
}

function hasThinking(m: CursorModelEntry): boolean {
  const paramIds = new Set(m.parameters?.map(p => p.id) ?? [])
  return paramIds.has("thinking") || paramIds.has("reasoning")
}

function ctxWindow(m: CursorModelEntry, p: CursorParam[]): number {
  // 1. Try default variant params (already passed as p)
  const c = p.find(x => x.id === "context")
  if (c) return parseCtxValue(c.value)

  // 2. Try all variants for context param
  for (const v of m.variants ?? []) {
    const cp = v.params.find(x => x.id === "context")
    if (cp) return parseCtxValue(cp.value)
  }

  for (const param of m.parameters ?? []) {
    if (param.id === "context" && param.values?.length) {
      return parseCtxValue(param.values[0].value)
    }
  }

  return 200_000
}

function maxTok(m: CursorModelEntry): number {
  for (const param of m.parameters ?? []) {
    if (param.id === "maxTokens" || param.id === "maxOutput") {
      const vals = param.values.map(v => parseInt(v.value)).filter(n => !isNaN(n))
      if (vals.length > 0) return Math.max(...vals)
    }
  }

  for (const v of m.variants ?? []) {
    const mp = v.params.find(x => x.id === "maxTokens" || x.id === "maxOutput")
    if (mp) {
      const n = parseInt(mp.value)
      if (!isNaN(n)) return n
    }
  }

  const defV = m.variants?.find(v => v.isDefault) ?? m.variants?.[0]
  const ctx = defV ? parseCtxValue(defV.params.find(p => p.id === "context")?.value ?? "") : 0
  if (ctx > 0) return Math.min(Math.round(ctx / 4), 128_000)

  if (/nano|mini|haiku/i.test(m.id)) return 32_000
  return 64_000
}

function modelCost(id: string): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  if (id.startsWith("claude-opus-")) return { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 }
  if (id.startsWith("claude-sonnet-")) return { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 }
  if (id.startsWith("claude-haiku-")) return { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 }
  if (id.startsWith("composer-")) return { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 }
  if (id.startsWith("gpt-")) return { input: 2.50, output: 10, cacheRead: 0.50, cacheWrite: 1.25 }
  if (id.startsWith("gemini-")) return { input: 1.25, output: 5, cacheRead: 0.10, cacheWrite: 0.30 }
  if (id.startsWith("grok-")) return { input: 2, output: 10, cacheRead: 0.20, cacheWrite: 0.50 }
  return { input: 2, output: 10, cacheRead: 0.20, cacheWrite: 0.50 }
}

const THINKING_EFFORT_MAP: Record<string, string> = {
  minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh",
}
const REASONING_EFFORT_MAP: Record<string, string> = {
  minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "extra-high",
}

function applyThinking(pid: string, def: CursorParam[], lvl?: string): CursorParam[] {
  if (!lvl) return def
  const mode = def.some(p => p.id === "thinking") ? "thinking" :
               def.some(p => p.id === "reasoning") ? "reasoning" : null
  if (!mode) return def

  if (mode === "thinking") {
    return def.map(p => {
      if (p.id === "thinking") return { id: "thinking", value: "true" }
      if (p.id === "effort") return { id: "effort", value: THINKING_EFFORT_MAP[lvl] || "medium" }
      return p
    })
  }

  return def.map(p =>
    p.id === "reasoning" ? { id: "reasoning", value: REASONING_EFFORT_MAP[lvl] || "medium" } : p
  )
}

const SDK_OUTPUT_NOISE = /Working\.\.\.|LocalCursorRulesService|AgentSkillsCursorRulesService|CursorPluginsAgentSkillsService|load completed(?:\s+meta=|\b)|\d{2}:\d{2}:\d{2}\.\d{3}\s+INFO\s|\[shell-exec\]|[\u2800-\u28FF]/

function isSdkOutputNoise(text: string): boolean {
  return SDK_OUTPUT_NOISE.test(text)
}

type UsageBilling = { input: number; output: number; cacheRead: number; cacheWrite: number }

type DeltaStreamState = {
  g: AssistantMessage
  st: AssistantMessageEventStream
  m: Model<Api>
  textIdx: number
  textAcc: string
  activeToolCalls: Map<string, string>
  usageBilling: UsageBilling | null
  localAbort: AbortController
}

function applyTurnUsage(
  u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  state: DeltaStreamState,
) {
  if (!state.usageBilling) {
    state.usageBilling = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
  const billing = state.usageBilling
  billing.input += u.inputTokens
  billing.output += u.outputTokens
  billing.cacheRead += u.cacheReadTokens
  billing.cacheWrite += u.cacheWriteTokens

  state.g.usage.input = u.inputTokens
  state.g.usage.cacheRead = u.cacheReadTokens
  state.g.usage.cacheWrite = u.cacheWriteTokens
  state.g.usage.output = billing.output
  state.g.usage.totalTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + billing.output

  const billingUsage = {
    ...billing,
    totalTokens: billing.input + billing.output + billing.cacheRead + billing.cacheWrite,
    cost: state.g.usage.cost,
  }
  calculateCost(state.m, billingUsage as AssistantMessage["usage"])
  state.g.usage.cost = billingUsage.cost
}

function formatShellOutputDelta(event: Record<string, unknown> | undefined): string | null {
  if (!event || typeof event !== "object") return null
  const ev = event as { case?: string; value?: { data?: string | Uint8Array; code?: number } }
  if (ev.case === "stdout" || ev.case === "stderr") {
    const data = ev.value?.data
    if (data == null) return null
    const raw = typeof data === "string" ? data : Buffer.from(data).toString("utf8")
    const text = stripAnsi(raw)
    return text || null
  }
  if (ev.case === "exit" && ev.value?.code != null && ev.value.code !== 0) {
    return `\n  [exit ${ev.value.code}]\n`
  }
  return null
}

function appendThinkingDelta(state: DeltaStreamState, text: string) {
  const existing = state.g.content.findIndex(c => c.type === "thinking")
  if (existing >= 0) {
    ;(state.g.content[existing] as any).thinking += text
    state.st.push({ type: "thinking_delta", contentIndex: existing, delta: text, partial: state.g })
  } else {
    state.g.content.push({ type: "thinking", thinking: text } as any)
    state.st.push({ type: "thinking_start" as any, contentIndex: state.g.content.length - 1, partial: state.g })
  }
}

function handleInteractionUpdate(update: any, state: DeltaStreamState) {
  if (state.localAbort.signal.aborted) return
  if (update.type === "text-delta") {
    if (isSdkOutputNoise(update.text)) return
    if (state.textIdx < 0) {
      state.g.content.push({ type: "text", text: "" })
      state.textIdx = state.g.content.length - 1
      state.st.push({ type: "text_start", contentIndex: state.textIdx, partial: state.g })
    }
    ;(state.g.content[state.textIdx] as any).text += update.text
    state.textAcc += update.text
    state.st.push({ type: "text_delta", contentIndex: state.textIdx, delta: update.text, partial: state.g })
  } else if (update.type === "thinking-delta") {
    if (isSdkOutputNoise(update.text)) return
    appendThinkingDelta(state, update.text)
  } else if (update.type === "shell-output-delta") {
    const chunk = formatShellOutputDelta(update.event)
    if (!chunk || isSdkOutputNoise(chunk)) return
    appendThinkingDelta(state, chunk)
  } else if (update.type === "tool-call-started") {
    const name = update.toolCall?.name || update.toolCall?.type || "tool"
    state.activeToolCalls.set(update.callId, name)
    appendThinkingDelta(state, `\n  ⚙ ${name}`)
  } else if (update.type === "tool-call-completed") {
    const name = state.activeToolCalls.get(update.callId) || update.toolCall?.name || update.toolCall?.type || "tool"
    state.activeToolCalls.delete(update.callId)
    appendThinkingDelta(state, ` ✓ ${name}`)
  } else if (update.type === "turn-ended" && update.usage) {
    applyTurnUsage(update.usage, state)
  }
}

async function cancelRunIfSupported(run: any): Promise<void> {
  try {
    if (typeof run.supports === "function" && !run.supports("cancel")) return
    await run.cancel()
  } catch {}
}

async function waitForRunResult(run: any, abortSignal: AbortSignal): Promise<any> {
  if (abortSignal.aborted) throw new Error("aborted")
  const terminal = new Set(["finished", "error", "cancelled"])
  if (run.status && terminal.has(run.status)) return run.wait()

  return new Promise((resolve, reject) => {
    let settled = false
    let unsub: (() => void) | undefined
    const cleanup = () => {
      abortSignal.removeEventListener("abort", onAbort)
      if (unsub) unsub()
    }
    const finish = (ok: boolean, value?: any) => {
      if (settled) return
      settled = true
      cleanup()
      if (ok) resolve(value)
      else reject(value)
    }
    const onAbort = () => finish(false, new Error("aborted"))
    abortSignal.addEventListener("abort", onAbort, { once: true })
    const waitNow = () => run.wait().then(
      (r: any) => finish(true, r),
      (e: any) => finish(false, e),
    )
    if (typeof run.onDidChangeStatus === "function") {
      unsub = run.onDidChangeStatus((status: string) => {
        if (terminal.has(status)) waitNow()
      })
      if (run.status && terminal.has(run.status)) waitNow()
    } else {
      waitNow()
    }
  })
}

async function consumeRunStream(run: any, state: DeltaStreamState): Promise<void> {
  for await (const msg of run.stream()) {
    if (state.localAbort.signal.aborted) {
      await cancelRunIfSupported(run)
      break
    }
    if (msg.type === "tool_call" && !state.activeToolCalls.has(msg.call_id)) {
      if (msg.status === "running") {
        state.activeToolCalls.set(msg.call_id, msg.name)
        appendThinkingDelta(state, `\n  ⚙ ${msg.name}`)
      } else if (msg.status === "completed" || msg.status === "error") {
        const name = state.activeToolCalls.get(msg.call_id) || msg.name
        state.activeToolCalls.delete(msg.call_id)
        appendThinkingDelta(state, msg.status === "completed" ? ` ✓ ${name}` : ` ✗ ${name}`)
      }
    }
  }
}

function buildSendOptions(
  modelSel: { id: string; params?: CursorParam[] },
  state: DeltaStreamState,
  force?: boolean,
) {
  const opts: any = {
    model: modelSel,
    onDelta: ({ update }: { update: any }) => handleInteractionUpdate(update, state),
  }
  if (force) opts.local = { force: true }
  return opts
}

function resetDeltaStreamState(state: DeltaStreamState) {
  state.g.content = []
  state.g.usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  state.textIdx = -1
  state.textAcc = ""
  state.activeToolCalls.clear()
  state.usageBilling = null
}

function applyRunResult(result: any, state: DeltaStreamState) {
  if (!result) return
  if (state.textIdx < 0 && result.result && !isSdkOutputNoise(result.result)) {
    state.g.content.push({ type: "text", text: result.result })
    state.textIdx = state.g.content.length - 1
    state.st.push({ type: "text_start", contentIndex: state.textIdx, partial: state.g })
    state.st.push({ type: "text_delta", contentIndex: state.textIdx, delta: result.result, partial: state.g })
    state.st.push({ type: "text_end", contentIndex: state.textIdx, content: result.result, partial: state.g })
  }
  state.g.stopReason = result?.status === "finished" ? "stop" : "length"
  if (state.g.stopReason === "length") {
    piLog("warn", "Run ended with non-finished status:", result?.status, "— response may be truncated")
  }
}

function makeAbortRej(abort: AbortController): Promise<never> {
  return new Promise<never>((_, rej) => {
    if (abort.signal.aborted) rej(new Error("aborted"))
    abort.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })
  })
}

function createRecoveryAbort(o?: SimpleStreamOptions): AbortController {
  const recoveryAbort = new AbortController()
  _cursorAbort = recoveryAbort
  if (o?.signal) {
    if (o.signal.aborted) recoveryAbort.abort()
    else o.signal.addEventListener("abort", () => recoveryAbort.abort(), { once: true })
  }
  return recoveryAbort
}

const MAX_OUTPUT_CONTINUATIONS = 3

async function executeSendCycle(args: {
  agent: any
  text: string
  images: { data: string; mimeType: string }[]
  modelSel: { id: string; params?: CursorParam[] }
  state: DeltaStreamState
  force?: boolean
  abortRej: Promise<never>
}): Promise<any> {
  const { agent, text, images, modelSel, state, force, abortRej } = args
  const run = await Promise.race([
    agent.send(
      images.length ? { text, images } : text,
      buildSendOptions(modelSel, state, force),
    ),
    abortRej,
  ])
  await consumeRunStream(run, state)
  if (state.textIdx >= 0 && state.textAcc) {
    state.st.push({ type: "text_end", contentIndex: state.textIdx, content: state.textAcc, partial: state.g })
  }
  if (state.localAbort.signal.aborted) throw new Error("aborted")
  let result: any
  try {
    result = await Promise.race([waitForRunResult(run, state.localAbort.signal), abortRej])
  } catch (e) {
    if (state.localAbort.signal.aborted) throw e
    return undefined
  }

  let continuations = 0
  while (
    result?.status !== "finished" &&
    result?.status !== "cancelled" &&
    continuations < MAX_OUTPUT_CONTINUATIONS &&
    !state.localAbort.signal.aborted
  ) {
    piLog("warn", `Output token limit hit (status=${result?.status}), continuation ${continuations + 1}/${MAX_OUTPUT_CONTINUATIONS}...`)
    continuations++
    state.textAcc = ""
    const contRun = await Promise.race([
      agent.send("", buildSendOptions(modelSel, state, false)),
      abortRej,
    ])
    await consumeRunStream(contRun, state)
    if (state.textIdx >= 0 && state.textAcc) {
      state.st.push({ type: "text_end", contentIndex: state.textIdx, content: state.textAcc, partial: state.g })
    }
    if (state.localAbort.signal.aborted) throw new Error("aborted")
    try {
      result = await Promise.race([waitForRunResult(contRun, state.localAbort.signal), abortRej])
    } catch (e) {
      if (state.localAbort.signal.aborted) throw e
      result = undefined
      break
    }
  }
  if (continuations > 0 && result?.status === "finished") {
    piLog("info", `Output continuation completed after ${continuations} extra cycle(s)`)
  } else if (continuations >= MAX_OUTPUT_CONTINUATIONS && result?.status !== "finished") {
    piLog("warn", `Output still truncated after ${continuations} continuation(s) — returning as-is`)
  }

  return result
}

function isSdkConsoleNoise(args: unknown[]): boolean {
  return isSdkOutputNoise(args.map(a => typeof a === "string" ? a : String(a)).join(" "))
}

let sdkSilenceDepth = 0
let savedConsole: { info: typeof console.info; log: typeof console.log; debug: typeof console.debug; warn: typeof console.warn; error: typeof console.error } | null = null
let savedStderrWrite: typeof process.stderr.write | null = null

function enterSdkSilence() {
  if (sdkSilenceDepth++ > 0) return
  savedConsole = { info: console.info, log: console.log, debug: console.debug, warn: console.warn, error: console.error }
  const wrap = (fn: (...a: unknown[]) => void) => (...args: unknown[]) => {
    if (isSdkConsoleNoise(args)) return
    return fn.apply(console, args as [])
  }
  console.info = wrap(savedConsole.info) as typeof console.info
  console.log = wrap(savedConsole.log) as typeof console.log
  console.debug = wrap(savedConsole.debug) as typeof console.debug
  console.warn = wrap(savedConsole.warn) as typeof console.warn
  console.error = wrap(savedConsole.error) as typeof console.error
  savedStderrWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
    if (isSdkOutputNoise(s)) return true
    return (savedStderrWrite as (...a: unknown[]) => boolean).apply(process.stderr, [chunk, ...args])
  }) as typeof process.stderr.write
}

function exitSdkSilence() {
  if (--sdkSilenceDepth > 0) return
  if (savedConsole) {
    console.info = savedConsole.info
    console.log = savedConsole.log
    console.debug = savedConsole.debug
    console.warn = savedConsole.warn
    console.error = savedConsole.error
    savedConsole = null
  }
  if (savedStderrWrite) {
    process.stderr.write = savedStderrWrite
    savedStderrWrite = null
  }
}

async function withSilencedSdk<T>(fn: () => Promise<T>): Promise<T> {
  enterSdkSilence()
  try { return await fn() }
  finally { exitSdkSilence() }
}

const rulesDir = join(fileURLToPath(new URL(".", import.meta.url)), "rules")

function ensureCursorRules(cwd: string) {
  const targetDir = join(cwd, ".cursor", "rules")
  mkdirSync(targetDir, { recursive: true })
  for (const file of readdirSync(rulesDir)) {
    if (!file.endsWith(".mdc")) continue
    const src = join(rulesDir, file)
    const target = join(targetDir, file)
    try {
      const srcContent = readFileSync(src, "utf-8")
      if (existsSync(target)) {
        const targetContent = readFileSync(target, "utf-8")
        if (srcContent === targetContent) continue
      }
      writeFileSync(target, srcContent, "utf-8")
    } catch {}
  }
}

const extDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "bin")
if (!process.env.PATH?.includes(extDir)) {
  process.env.PATH = extDir + ":" + (process.env.PATH ?? "")
}

export default async function (pi: ExtensionAPI) {
  setSessionCwd(undefined, process.cwd())
  const apiKey = getApiKey()
  if (!apiKey) { piLog("warn", "No API key — provider NOT registered"); return }

  const { Cursor } = await import("@cursor/sdk")
  let cursorModels: CursorModelEntry[] = []
  try {
    const models = await Cursor.models.list({ apiKey })
    cursorModels = models as CursorModelEntry[]
  } catch (err) { piLog("error", "Model discovery FAILED:", err); return }
  if (!cursorModels.length) { piLog("warn", "No models — provider NOT registered"); return }

  for (const cm of cursorModels) {
    if (cm.id === "default") continue
    const allV = cm.variants?.length ? cm.variants : [{ params: [] }]
    const defV = allV.find(v => v.isDefault) ?? allV[0]
    const defP = defV.params ?? []

    let finalP = defP
    if (cm.id === "composer-2.5") {
      const fast = defP.find(p => p.id === "fast")
      if (fast?.value === "true") finalP = defP.map(p => p.id === "fast" ? { id: "fast", value: "false" } : p)
    }
    paramRegistry.set(cm.id, { modelId: cm.id, params: finalP.length ? finalP : undefined })
  }

  const piModels = cursorModels
    .filter(cm => cm.id !== "default")
    .map(cm => {
      const allV = cm.variants?.length ? cm.variants : [{ params: [] }]
      const defV = allV.find(v => v.isDefault) ?? allV[0]
      const cost = modelCost(cm.id)
      return {
        id: cm.id, name: cm.displayName,
        reasoning: hasThinking(cm),
        input: hasVision(cm) ? ["text" as const, "image" as const] : ["text" as const],
        cost,
        contextWindow: ctxWindow(cm, defV.params ?? []),
        maxTokens: maxTok(cm),
      }
    })

  pi.registerProvider("pi-cursor", {
    name: "Pi-Cursor (Dynamic)",
    baseUrl: "https://api.cursor.com",
    apiKey: "sk-cursor",
    authHeader: true,
    api: "cursor-agent",
    models: piModels,
    streamSimple: cursorStream,
  })

  installCrashGuards()

  const hooksInstalledForCwd = new Set<string>()

  pi.on("session_start", async (event, ctx) => {
    const sessionId = getSessionId(ctx, event)
    setSessionCwd(sessionId, ctx?.cwd)
    const cwd = getSessionCwd(sessionId)
    // Clear compacted flag for this session - new messages mean we can resume
    compactedSessions.delete(sessionId)
    // Clear stuck agents for this session to allow fresh starts after reload/new
    for (const [key, entry] of activeAgents) {
      if (entry.sessionId === sessionId) {
        stuckAgentIds.delete(entry.agentId)
      }
    }
    // Clear lastStreamSessionId on new session start to ensure fresh session gets new ID
    // This handles /reload, /new, and other session restarts properly
    lastStreamSessionId = undefined
    if (!hooksInstalledForCwd.has(cwd)) {
      try { installHooks(cwd); hooksInstalledForCwd.add(cwd) } catch (err) {
        piLog("warn", "hooks:", err)
      }
    }
    try { ensureCursorRules(cwd) } catch (err) {
      piLog("warn", "rules:", err)
    }
  })

  pi.on("session_shutdown", async (ev?: any) => {
    // Save agent IDs for resume. Close only on final quit.
    // Keep stuckAgentIds across internal shutdowns (reload/resume/new/fork)
    // so we remember bad agent ids and avoid resume after a hang/stop.
    // Clear compactedSessions on full quit, but keep for reload/resume/new
    const sessionId = getSessionId(ev)
    const scopedSession = hasProvidedSessionId(ev)
    const scopedCwd = getSessionCwd(sessionId)
    const statesByCwd = new Map<string, AgentState>([[scopedCwd, { agents: {} }]])
    for (const [key, entry] of activeAgents) {
      let state = statesByCwd.get(entry.cwd)
      if (!state) {
        state = { agents: {} }
        statesByCwd.set(entry.cwd, state)
      }
      state.agents[key] = entry.agentId
    }
    for (const [cwd, state] of statesByCwd) {
      saveAgentState(cwd, state)
    }
    for (const [key, entry] of activeAgents) {
      if (scopedSession && entry.sessionId !== sessionId) continue
      if (ev && ev.reason === "quit") {
        try { entry.agent.close() } catch {}
      }
      activeAgents.delete(key)
    }
    if (scopedSession) sessionCwds.delete(sessionId)
    // Clear compacted flag on full quit
    if (ev?.reason === "quit") compactedSessions.clear()
    // intentionally do not clear stuckAgentIds here
  })

  // Compaction cooperation (PI core x Cursor SDK):
  // - mode "pi": keep PI compaction and just reset Cursor SDK state.
  // - mode "extension": always delegate compaction with summary-only context
  //   (sentinel firstKeptEntryId). Avoids PI continue() on assistant-tail after
  //   compact; Cursor SDK SQLite owns real multi-turn context.
  function resetCursorState(sessionId?: string, scopedSession = false) {
    if (_cursorAbort) {
      try { _cursorAbort.abort() } catch {}
      _cursorAbort = null
    }
    const sid = getSessionId(sessionId)
    const affectedCwds = new Set<string>()
    if (scopedSession) {
      affectedCwds.add(getSessionCwd(sid))
      compactedSessions.add(sid)
    } else {
      for (const cwd of sessionCwds.values()) affectedCwds.add(cwd)
      affectedCwds.add(getSessionCwd())
      for (const sid of sessionCwds.keys()) compactedSessions.add(sid)
      compactedSessions.add("default")
    }
    for (const [key, entry] of activeAgents) {
      if (scopedSession && entry.sessionId !== sid) continue
      try { entry.agent.close() } catch {}
      affectedCwds.add(entry.cwd)
      activeAgents.delete(key)
    }
    for (const cwd of affectedCwds) {
      try {
        const st = loadAgentState(cwd)
        if (scopedSession) {
          for (const key of Object.keys(st.agents)) {
            if (getSessionIdFromStateKey(key) === sid) delete st.agents[key]
          }
        } else {
          st.agents = {}
        }
        saveAgentState(cwd, st)
      } catch {}
    }
  }
  pi.on("session_before_compact", (event: any) => {
    const sessionId = providedSessionId(event) ?? lastStreamSessionId
    const scopedSession = sessionId !== undefined
    resetCursorState(sessionId, scopedSession)
    if (COMPACTION_MODE !== "extension") return
    const prep = event?.preparation
    if (!prep?.firstKeptEntryId) return
    return buildDelegatedCompaction(prep)
  })
  pi.on("session_compact", (event: any) => {
    const sessionId = providedSessionId(event) ?? lastStreamSessionId
    const scopedSession = sessionId !== undefined
    resetCursorState(sessionId, scopedSession)
  })
}

function cursorStream(m: Model<Api>, ctx: Context, o?: SimpleStreamOptions): AssistantMessageEventStream {
  const st = createAssistantMessageEventStream()
  ;(async () => {
    await withSilencedSdk(async () => {
    const g: AssistantMessage = {
      role: "assistant", content: [],
      api: m.api, provider: m.provider, model: m.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    }

    const { Agent, AgentBusyError, RateLimitError, AuthenticationError, CursorAgentError, convertConnectError } = await import("@cursor/sdk")

    const sessionId = getSessionId(o, inferSessionIdFromContext(ctx))
    lastStreamSessionId = sessionId
    const cwd = getSessionCwd(sessionId)
    const sk = cwd + "|" + sessionId + "|" + m.id
    let agentEntry: ActiveAgentEntry | undefined

    // Local abort controller with hang protection.
    // If the Cursor agent loops forever (runaway tool calls, API hang),
    // the timeout aborts the request and the agent is discarded as stuck.
    // Merged with pi's external signal and the unhandledRejection guard.
    const localAbort = new AbortController()
    _cursorAbort = localAbort
    if (o?.signal) {
      if (o.signal.aborted) {
        localAbort.abort(); _cursorAbort = null
        g.stopReason = "aborted"
        g.errorMessage = "request aborted"
        st.push({ type: "error", reason: "aborted", error: g })
        st.end()
        return
      }
      o.signal.addEventListener("abort", () => localAbort.abort(), { once: true })
    }
    let hangTriggered = false
    let forceRetryAttempted = false
    let calmRetries = 0
    const hangTimer = setTimeout(() => {
      piLog("warn", "Agent hang timeout (" + (AGENT_HANG_TIMEOUT_MS / 60000) + "min), aborting...")
      hangTriggered = true
      const agentId = agentEntry?.agentId
      if (agentId) stuckAgentIds.add(agentId)
      localAbort.abort()
    }, AGENT_HANG_TIMEOUT_MS)

    let apiKey = ""
    let text = ""
    let images: { data: string; mimeType: string }[] = []
    let modelSel: { id: string; params?: CursorParam[] } = { id: m.id }
    const abortRej = makeAbortRej(localAbort)
    const deltaState: DeltaStreamState = {
      g, st, m, textIdx: -1, textAcc: "", activeToolCalls: new Map(), usageBilling: null, localAbort,
    }

    try {
      apiKey = o?.apiKey || getApiKey(sessionId)
      if (!apiKey) {
        g.errorMessage = "No API key for cursor."
        g.stopReason = "error"
        st.push({ type: "error", reason: "error", error: g }); st.end(); return
      }

      const lastUser = [...ctx.messages].reverse().find(m => m.role === "user")
      text = typeof lastUser?.content === "string"
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
          : ""

      // pi uses two image formats:
      // 1. { type: "image", data: base64, mimeType: "image/png" }
      // 2. { type: "image", source: { type: "base64", media_type, data } }
      const VALID_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
      images = []
      if (Array.isArray(lastUser?.content)) {
        for (const c of lastUser.content as any[]) {
          if (c.type !== "image") continue
          const data = (c.data || c.source?.data) as string | undefined
          const rawMime = (c.mimeType || c.source?.media_type) as string | undefined
          if (!data || typeof data !== "string") {
            piLog("warn", "Image skipped: missing data field")
            continue
          }
          if (data.startsWith("http://") || data.startsWith("https://")) {
            piLog("warn", "Image skipped: URL images not supported, use base64")
            continue
          }
          const mimeType = rawMime && VALID_MIME.has(rawMime) ? rawMime : "image/png"
          images.push({ data, mimeType })
        }
      }

      const entry = paramRegistry.get(m.id) ?? { modelId: m.id, params: undefined }
      const effectiveParams = entry.params && o?.reasoning
        ? applyThinking(entry.modelId, entry.params, o.reasoning)
        : entry.params
      modelSel = { id: entry.modelId }
      if (effectiveParams?.length) modelSel.params = effectiveParams

      agentEntry = activeAgents.get(sk)

      if (!agentEntry) {
        const savedState = loadAgentState(cwd)
        const savedId = savedState.agents[sk]
        // Never resume an agent that previously hung — it's in a bad state.
        // Also never resume after compaction — PI context was compacted and no longer
        // matches Cursor SDK's SQLite history, causing "Cannot continue from message role: assistant".
        const shouldSkipResume = !savedId || stuckAgentIds.has(savedId) || compactedSessions.has(sessionId)
        if (savedId && !shouldSkipResume) {
          try {
            const resumeP = Agent.resume(savedId, { apiKey, local: { cwd, settingSources: ["project"] } })
            const resumed = await Promise.race([
              resumeP,
              new Promise<never>((_, rej) => {
                if (localAbort.signal.aborted) rej(new Error("aborted"))
                localAbort.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })
              })
            ])
            agentEntry = { agent: resumed, agentId: savedId, lastUsed: Date.now(), cwd, sessionId }
            activeAgents.set(sk, agentEntry)
          } catch (err: any) {
            piLog("warn", "Agent resume failed, creating fresh agent:", err?.message || err)
            // If resume throws, the agent is likely unrecoverable — mark it.
            stuckAgentIds.add(savedId)
          }
        } else if (savedId) {
          const reason = stuckAgentIds.has(savedId) ? "previously stuck" : "session was compacted"
          piLog("warn", "Skipping resume of " + reason + " agent:", savedId.slice(0, 16))
        }
      }
      // Enforce max idle: if the in-memory agent object sat unused too long,
      // evict it from the active cache to force a fresh gRPC session on the
      // next request. The saved agentId on disk is intentionally KEPT so that
      // Agent.resume(savedId) is called next time, which re-authenticates with
      // the fresh apiKey and restores the full SQLite conversation history.
      // This preserves agent memory across gaps between sessions.
      // (Previously, deleting savedId here caused Agent.create() to be called
      // instead, creating a fresh agent with no memory of prior conversation.)
      if (agentEntry) {
        const idleMs = Date.now() - agentEntry.lastUsed
        if (idleMs > AGENT_MAX_IDLE_MS) {
          piLog("info", "Agent idle-expired after " + Math.round(idleMs / 1000) + "s, will resume on next message")
          try { agentEntry.agent.close() } catch {}
          activeAgents.delete(sk)
          agentEntry = undefined
          // NOTE: do NOT delete state.agents[sk] from disk — the agentId is
          // still valid for Agent.resume(). The gRPC auth token may have expired
          // but Agent.resume() re-authenticates using the fresh apiKey above.
        }
      }
      if (!agentEntry) {
        const createP = Agent.create({ apiKey, model: modelSel, local: { cwd, settingSources: ["project"] } })
        const agent = await Promise.race([
          createP,
          new Promise<never>((_, rej) => {
            if (localAbort.signal.aborted) rej(new Error("aborted"))
            localAbort.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })
          })
        ])
        agentEntry = { agent, agentId: agent.agentId, lastUsed: Date.now(), cwd, sessionId }
        activeAgents.set(sk, agentEntry)
      } else {
        agentEntry.lastUsed = Date.now()
      }

      st.push({ type: "start", partial: g })

      const result = await executeSendCycle({
        agent: agentEntry!.agent,
        text,
        images,
        modelSel,
        state: deltaState,
        abortRej,
      })
      applyRunResult(result, deltaState)

      if (localAbort.signal.aborted) throw new Error("aborted")
      st.push({ type: "done", reason: g.stopReason as "stop" | "length" | "toolUse", message: g })
      st.end()
    } catch (error) {
      // Normalize raw ConnectError from gRPC layer to SDK error types.
      // The Cursor SDK wraps errors in agent.send() but NOT in run.stream()
      // async iteration — raw ConnectError (e.g. code 16 Unauthenticated)
      // can escape from the stream iterator without being typed.
      let sdkErr: any = error
      if (!(error instanceof CursorAgentError)) {
        try { sdkErr = convertConnectError(error as any) } catch { sdkErr = error }
      }

      // Idle timeout: Cursor API session token expires after inactivity.
      // The agent stored in activeAgents is stale. Clear it and retry once
      // with a fresh agent so the user doesn't have to re-send manually.
      if (sdkErr instanceof AuthenticationError ||
          (error as any)?.code === 16 /* gRPC Unauthenticated */) {
        // Evict the stale in-memory agent object only — do NOT delete savedId
        // from disk yet. The retry block below will attempt Agent.resume(savedId)
        // first, and only removes savedId if resume is not viable.
        const entry = activeAgents.get(sk)
        if (entry) {
          try { entry.agent.close() } catch {}
          activeAgents.delete(sk)
        }
        // Auto-retry: session token expired but the SQLite conversation history
        // is still intact. Try Agent.resume(savedId) first so we keep memory;
        // only fall back to Agent.create() if resume itself fails.
        const savedIdForRetry = loadAgentState(cwd).agents[sk]
        let retryAgent: any = null
        if (savedIdForRetry && !stuckAgentIds.has(savedIdForRetry)) {
          try {
            piLog("warn", "Session expired, retrying with Agent.resume (preserve memory)...")
            retryAgent = await Agent.resume(savedIdForRetry, { apiKey, local: { cwd, settingSources: ["project"] } })
            agentEntry = { agent: retryAgent, agentId: savedIdForRetry, lastUsed: Date.now(), cwd, sessionId }
            activeAgents.set(sk, agentEntry)
          } catch (resumeErr: any) {
            piLog("warn", "Resume also failed, falling back to fresh agent:", resumeErr?.message || resumeErr)
            stuckAgentIds.add(savedIdForRetry)
            retryAgent = null
          }
        }
        if (!retryAgent) {
          piLog("warn", "Session expired, retrying with fresh Agent.create...")
          // Only remove savedId from disk when we're certain resume isn't viable
          const st2 = loadAgentState(cwd)
          delete st2.agents[sk]
          saveAgentState(cwd, st2)
          try {
            retryAgent = await Agent.create({ apiKey, model: modelSel, local: { cwd, settingSources: ["project"] } })
            agentEntry = { agent: retryAgent, agentId: retryAgent.agentId, lastUsed: Date.now(), cwd, sessionId }
            activeAgents.set(sk, agentEntry)
          } catch (createErr: any) {
            piLog("warn", "Agent.create also failed:", createErr?.message || createErr)
          }
        }
        try {
          if (!retryAgent) throw new Error("no agent available for retry")
          resetDeltaStreamState(deltaState)
          st.push({ type: "start", partial: g })
          const retryResult = await executeSendCycle({
            agent: retryAgent, text, images, modelSel, state: deltaState, abortRej,
          })
          applyRunResult(retryResult, deltaState)
          if (localAbort.signal.aborted) throw new Error("aborted")
          st.push({ type: "done", reason: g.stopReason as "stop" | "length" | "toolUse", message: g })
          st.end()
          return
        } catch (retryErr: any) {
          piLog("warn", "Auto-retry failed:", retryErr instanceof Error ? retryErr.message : String(retryErr))
        }
        g.stopReason = "error"
        g.errorMessage = `Cursor auth error: ${(sdkErr as any).message || (error as any).message}. Session expired and auto-retry failed.`
        // Evict the fresh agent we just created for retry, since it also failed.
        if (agentEntry) {
          stuckAgentIds.add(agentEntry.agentId)
          try { agentEntry.agent.close() } catch {}
          activeAgents.delete(sk)
          try { const s = loadAgentState(cwd); delete s.agents[sk]; saveAgentState(cwd, s) } catch {}
        }
        st.push({ type: "error", reason: "error", error: g })
        st.end()
        return
      }

      // ENHANCE_YOUR_CALM: HTTP/2 RST_STREAM sent by the Cursor API when
      // the client is sending too many requests. This is server-side rate
      // limiting that arrives outside the normal SDK error typing.
      // Retry with exponential backoff: 2s, then 4s, then give up.
      if (!localAbort.signal.aborted &&
          (error as any)?.code === 13 &&
          /ENHANCE_YOUR_CALM/i.test((error as any)?.message ?? "")) {
        const entry = activeAgents.get(sk)
        if (entry) {
          stuckAgentIds.add(entry.agentId)
          try { entry.agent.close() } catch {}
          activeAgents.delete(sk)
          try { const s = loadAgentState(cwd); delete s.agents[sk]; saveAgentState(cwd, s) } catch {}
        }
        // Backoff: 2s, then 4s, then 8s (max 3 retries)
        calmRetries++
        const backoffMs = Math.min(2000 * Math.pow(2, calmRetries - 1), 8000)
        if (calmRetries <= 3) {
          try {
            piLog("warn", `Rate limited (ENHANCE_YOUR_CALM), retrying in ${backoffMs / 1000}s...`)
            await new Promise<void>(resolve => setTimeout(resolve, backoffMs))
            if (localAbort.signal.aborted) throw new Error("aborted")
            const freshAgent = await Agent.create({ apiKey, model: modelSel, local: { cwd, settingSources: ["project"] } })
            agentEntry = { agent: freshAgent, agentId: freshAgent.agentId, lastUsed: Date.now(), cwd, sessionId }
            activeAgents.set(sk, agentEntry)
            resetDeltaStreamState(deltaState)
            st.push({ type: "start", partial: g })
            const retryResult = await executeSendCycle({
              agent: freshAgent, text, images, modelSel, state: deltaState, abortRej,
            })
            applyRunResult(retryResult, deltaState)
            if (localAbort.signal.aborted) throw new Error("aborted")
            st.push({ type: "done", reason: g.stopReason as "stop" | "length" | "toolUse", message: g })
            st.end()
            return
          } catch (retryErr: any) {
            piLog("warn", "ENHANCE_YOUR_CALM retry failed:",
              retryErr instanceof Error ? retryErr.message : String(retryErr))
          }
        }
        g.stopReason = "error"
        g.errorMessage = `Cursor rate limited (ENHANCE_YOUR_CALM): ${(error as any).message}. Wait a few seconds and retry.`
        if (agentEntry) {
          stuckAgentIds.add(agentEntry.agentId)
          try { agentEntry.agent.close() } catch {}
          activeAgents.delete(sk)
          try { const s = loadAgentState(cwd); delete s.agents[sk]; saveAgentState(cwd, s) } catch {}
        }
        st.push({ type: "error", reason: "error", error: g })
        st.end()
        return
      }

      if (sdkErr instanceof RateLimitError && (sdkErr as any).isRetryable !== false) {
        g.stopReason = "error"
        g.errorMessage = `Cursor rate limited: ${(sdkErr as any).message}`
        // Evict so next attempt gets a fresh agent instead of re-hitting the bad one.
        if (agentEntry) {
          stuckAgentIds.add(agentEntry.agentId)
          try { agentEntry.agent.close() } catch {}
          activeAgents.delete(sk)
          try { const s = loadAgentState(cwd); delete s.agents[sk]; saveAgentState(cwd, s) } catch {}
        }
        st.push({ type: "error", reason: "error", error: g })
        st.end()
        return
      }

      if (sdkErr instanceof AgentBusyError) {
        if (!forceRetryAttempted && agentEntry) {
          forceRetryAttempted = true
          try {
            piLog("warn", "Agent busy, retrying with force...")
            resetDeltaStreamState(deltaState)
            st.push({ type: "start", partial: g })
            const retryResult = await executeSendCycle({
              agent: agentEntry.agent, text, images, modelSel, state: deltaState, force: true, abortRej,
            })
            applyRunResult(retryResult, deltaState)
            if (localAbort.signal.aborted) throw new Error("aborted")
            st.push({ type: "done", reason: g.stopReason as "stop" | "length" | "toolUse", message: g })
            st.end()
            return
          } catch (retryErr: any) {
            piLog("warn", "Force retry after busy failed:",
              retryErr instanceof Error ? retryErr.message : String(retryErr))
          }
        }
        g.stopReason = "error"
        g.errorMessage = `Cursor agent busy: ${(sdkErr as any).message}. Wait and retry.`
        // Evict so next attempt gets a fresh agent instead of re-hitting the bad one.
        if (agentEntry) {
          stuckAgentIds.add(agentEntry.agentId)
          try { agentEntry.agent.close() } catch {}
          activeAgents.delete(sk)
          try { const s = loadAgentState(cwd); delete s.agents[sk]; saveAgentState(cwd, s) } catch {}
        }
        st.push({ type: "error", reason: "error", error: g })
        st.end()
        return
      }

      if (hangTriggered && !forceRetryAttempted && agentEntry) {
        forceRetryAttempted = true
        try {
          piLog("warn", "Hang detected, retrying send with force...")
          const recoveryAbort = createRecoveryAbort(o)
          deltaState.localAbort = recoveryAbort
          resetDeltaStreamState(deltaState)
          st.push({ type: "start", partial: g })
          const retryResult = await executeSendCycle({
            agent: agentEntry.agent, text, images, modelSel, state: deltaState, force: true,
            abortRej: makeAbortRej(recoveryAbort),
          })
          applyRunResult(retryResult, deltaState)
          if (localAbort.signal.aborted) throw new Error("aborted")
          st.push({ type: "done", reason: g.stopReason as "stop" | "length" | "toolUse", message: g })
          st.end()
          return
        } catch (retryErr: any) {
          piLog("warn", "Force retry after hang failed:",
            retryErr instanceof Error ? retryErr.message : String(retryErr))
        }
      }

      g.stopReason = localAbort.signal.aborted ? "aborted" : "error"
      g.errorMessage = sdkErr instanceof Error ? sdkErr.message : String(sdkErr)
      // Evict the agent on errors (and on hang aborts) so that after a stop/failure
      // the next chat message will not reuse the poisoned agent and will instead
      // create a fresh one (or resume a non-stuck id). Only skip eviction for a
      // clean external user abort (not our timeout), per previous intent to keep
      // the agent usable after cancel.
      const isPureUserAbort = localAbort.signal.aborted && agentEntry && !stuckAgentIds.has(agentEntry.agentId)
      if (agentEntry && !isPureUserAbort) {
        stuckAgentIds.add(agentEntry.agentId)
        try { agentEntry.agent.close() } catch {}
        activeAgents.delete(sk)
        try {
          const state = loadAgentState(cwd)
          delete state.agents[sk]
          saveAgentState(cwd, state)
        } catch {}
        if (localAbort.signal.aborted) {
          piLog("warn", "Discarding hung agent:", agentEntry.agentId.slice(0, 16))
        }
      }
      st.push({ type: "error", reason: g.stopReason, error: g })
      st.end()
    } finally {
      clearTimeout(hangTimer)
      _cursorAbort = null
    }
    })
  })().catch((err) => {
    // Safety net: if an error escapes the try/catch (e.g. from a detached
    // microtask inside the gRPC stream), prevent it from crashing pi.
    // Also terminate the stream so the chat consumer does not hang forever.
    piLog("warn", "Unhandled stream error:", err instanceof Error ? err.message : String(err))
    try {
      const eg: any = { role: "assistant", content: [], stopReason: "error", errorMessage: "unhandled: " + (err instanceof Error ? err.message : String(err)), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() }
      st.push({ type: "error", reason: "error", error: eg })
      st.end()
    } catch {}
  })
  return st
}
