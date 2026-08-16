import { execSync, fork, type ChildProcess } from "node:child_process"
import { AsyncLocalStorage } from "node:async_hooks"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { type ExtensionAPI, estimateTokens } from "@earendil-works/pi-coding-agent"
import {
  type Api, type AssistantMessage, type AssistantMessageEventStream,
  type Context, type Model, type SimpleStreamOptions,
  calculateCost, createAssistantMessageEventStream,
} from "@earendil-works/pi-ai"
import type { SDKAgent as CursorSdkAgent } from "@cursor/sdk"
import {
  Agent,
  AgentBusyError as CursorAgentBusyError,
  AuthenticationError as CursorAuthenticationError,
  CursorAgentError as CursorAgentErrorClass,
  RateLimitError as CursorRateLimitError,
  convertConnectError as cursorConvertConnectError,
  Cursor as CursorApi,
} from "@cursor/sdk"
const PLUGIN_DIR = fileURLToPath(new URL(".", import.meta.url))

let sdkAuthenticationError = CursorAuthenticationError
let sdkModule: any = {
  Agent,
  AgentBusyError: CursorAgentBusyError,
  AuthenticationError: CursorAuthenticationError,
  CursorAgentError: CursorAgentErrorClass,
  RateLimitError: CursorRateLimitError,
  convertConnectError: cursorConvertConnectError,
  Cursor: CursorApi,
}
const SDK_MODULE_PATH = join(PLUGIN_DIR, "node_modules", "@cursor", "sdk", "dist", "esm", "index.js")
const SDK_HOST_PATH = join(PLUGIN_DIR, "sdk-host.mjs")

type HostPending = {
  resolve: (v: any) => void
  reject: (e: any) => void
  onDelta?: (update: any) => void
  streamPush?: (msg: any) => void
  streamEnd?: () => void
}

class HostRun {
  status: string | undefined
  private result: any
  private streamBuf: any[] = []
  private streamWaiters: Array<(v: { done: boolean; value?: any }) => void> = []
  private ended = false
  private resultWaiters: Array<(r: any) => void> = []

  pushStream(msg: any) {
    if (this.streamWaiters.length) {
      this.streamWaiters.shift()!({ done: false, value: msg })
    } else {
      this.streamBuf.push(msg)
    }
  }

  finish(result: any) {
    this.result = result
    this.status = result?.status
    this.ended = true
    while (this.streamWaiters.length) {
      this.streamWaiters.shift()!({ done: true })
    }
    while (this.resultWaiters.length) {
      this.resultWaiters.shift()!(result)
    }
  }

  fail(err: Error) {
    this.ended = true
    this.status = "error"
    this.result = { status: "error", error: { message: err.message } }
    while (this.streamWaiters.length) {
      this.streamWaiters.shift()!({ done: true })
    }
    while (this.resultWaiters.length) {
      this.resultWaiters.shift()!(this.result)
    }
  }

  async *stream() {
    for (;;) {
      if (this.streamBuf.length) {
        yield this.streamBuf.shift()
        continue
      }
      if (this.ended) return
      const next = await new Promise<{ done: boolean; value?: any }>((res) => {
        this.streamWaiters.push(res)
      })
      if (next.done) return
      yield next.value
    }
  }

  wait() {
    if (this.ended) return Promise.resolve(this.result)
    return new Promise((res) => this.resultWaiters.push(res))
  }

  async cancel() {
    try {
      await sdkHost.call("cancel", { runId: this.reqId })
    } catch {}
  }

  constructor(readonly reqId: string) {}
}

class HostAgent {
  constructor(readonly agentId: string) {}

  async send(message: string | { text: string; images?: any[] }, options?: any) {
    const text = typeof message === "string" ? message : message.text
    const images = typeof message === "string" ? [] : (message.images ?? [])
    const reqId = "h" + (++sdkHost.seq)
    const run = new HostRun(reqId)
    sdkHost.sendRun(
      {
        agentId: this.agentId,
        text,
        images,
        model: options?.model,
        streamingBehavior: options?.streamingBehavior,
        force: !!options?.local?.force,
      },
      {
        onDelta: options?.onDelta
          ? (update: any) => options.onDelta({ update })
          : undefined,
        run,
      },
    )
    return run
  }

  close() {
    sdkHost.call("close", { agentId: this.agentId }).catch(() => {})
  }

  async reload() {}
}

const sdkHost = {
  child: null as ChildProcess | null,
  pending: new Map<string, HostPending>(),
  seq: 0,

  spawn() {
    this.kill()
    const child = fork(SDK_HOST_PATH, [], {
      execArgv: [],
      env: { ...process.env, PI_CURSOR_SDK_ENTRY: SDK_MODULE_PATH },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    })
    child.stderr?.on("data", (buf) => {
      const s = String(buf).trim()
      if (s) piLog("warn", "sdk-host:", s.slice(0, 400))
    })
    child.on("message", (msg: any) => this.onMessage(msg))
    child.on("error", (e) => {
      piLog("error", "sdk-host spawn error:", e.message)
      if (this.child === child) this.child = null
    })
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null
      const err = new Error(`sdk-host exited code=${code} signal=${signal}`)
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    })
    this.child = child
    piLog("info", "sdk-host spawned pid=" + child.pid)
  },

  kill() {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.removeAllListeners()
      child.kill("SIGKILL")
    } catch {}
  },

  async restart() {
    closeAllActiveAgents()
    this.spawn()
    await this.call("ping", {})
    piLog("info", "sdk-host ready (fresh Node process, fresh Cursor token cache)")
  },

  ensure() {
    if (this.child?.connected) return
    this.spawn()
  },

  onMessage(msg: any) {
    if (msg?.op === "fatal") {
      piLog("error", "sdk-host fatal:", msg.error)
      return
    }
    const p = this.pending.get(msg?.id)
    if (!p) return
    if (msg.kind === "delta") {
      p.onDelta?.(msg.update)
      return
    }
    if (msg.kind === "stream") {
      p.streamPush?.(msg.msg)
      return
    }
    this.pending.delete(msg.id)
    if (msg.ok) {
      p.streamEnd?.()
      p.resolve(msg)
    } else {
      const e = new Error(msg.error?.message || "sdk-host error")
      ;(e as any).code = msg.error?.code
      e.name = msg.error?.name || "Error"
      p.reject(e)
    }
  },

  call(op: string, payload: any): Promise<any> {
    this.ensure()
    const id = "h" + (++this.seq)
    const timeoutMs = op === "send" ? 15 * 60 * 1000 : 30_000
    return new Promise((resolve, reject) => {
      if (!this.child?.connected) {
        reject(new Error("sdk-host not connected"))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error("sdk-host timeout op=" + op))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.child.send({ id, op, payload })
    })
  },

  sendRun(
    payload: any,
    hooks: { onDelta?: (u: any) => void; run: HostRun },
  ): string {
    this.ensure()
    const id = hooks.run.reqId
    const run = hooks.run
    this.pending.set(id, {
      resolve: (msg) => run.finish(msg.result),
      reject: (e) => run.fail(e instanceof Error ? e : new Error(String(e))),
      onDelta: hooks.onDelta,
      streamPush: (m) => run.pushStream(m),
      streamEnd: () => {},
    })
    if (!this.child?.connected) {
      run.fail(new Error("sdk-host not connected"))
      return id
    }
    this.child.send({ id, op: "send", payload })
    return id
  },
}

const sdkAgent = {
  async create(opts: any) {
    const r = await sdkHost.call("create", opts)
    return new HostAgent(r.agentId)
  },
  async resume(agentId: string, opts: any) {
    const r = await sdkHost.call("resume", { agentId, opts })
    return new HostAgent(r.agentId)
  },
  async listRuns(agentId: string, opts: any) {
    const r = await sdkHost.call("listRuns", { agentId, opts })
    return r.result
  },
  messages: {
    async list(agentId: string, opts: any) {
      const r = await sdkHost.call("messagesList", { agentId, opts })
      return r.result
    },
  },
}

async function reloadSdk(): Promise<boolean> {
  try {
    await sdkHost.restart()
    return true
  } catch (e: any) {
    piLog("warn", "sdk-host restart failed:", e?.message || String(e))
    return false
  }
}
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
  agent: CursorSdkAgent
  agentId: string
  lastUsed: number
  tokenAt: number
  cwd: string
  sessionId: string
}

function makeAgentEntry(
  agent: CursorSdkAgent,
  agentId: string,
  cwd: string,
  sessionId: string,
): ActiveAgentEntry {
  const now = Date.now()
  return { agent, agentId, lastUsed: now, tokenAt: now, cwd, sessionId }
}

const activeAgents = new Map<string, ActiveAgentEntry>()

function closeAllActiveAgents(): void {
  for (const [sk, entry] of [...activeAgents]) {
    persistAgentId(entry.cwd, sk, entry.agentId)
    try {
      entry.agent.close()
    } catch {}
    activeAgents.delete(sk)
  }
}
const stuckAgentIds = new Set<string>()
const AGENTS_FILE = ".pi/cursor-agents.json"
const sessionCwds = new Map<string, string>()
let defaultSessionCwd = process.cwd()
let lastStreamSessionId: string | undefined
const _stuckCleanupInterval = setInterval(() => {
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
    let managedSessionId: unknown
    try { managedSessionId = source?.sessionManager?.getSessionId?.() } catch {}
    const candidates = [source, source?.sessionId, source?.session?.id, managedSessionId]
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

type ActiveRunAbort = {
  controller: AbortController
  sessionId: string
  lastCrashGuardAt: number
}

const activeRunAborts = new Map<string, ActiveRunAbort>()
const cursorRunContext = new AsyncLocalStorage<string>()
const CRASH_GUARD_COOLDOWN_MS = 5000

function registerRunAbort(runToken: string, sessionId: string, controller: AbortController) {
  activeRunAborts.set(runToken, { controller, sessionId, lastCrashGuardAt: 0 })
}

function unregisterRunAbort(runToken: string) {
  activeRunAborts.delete(runToken)
}

const CURSOR_CRASH_TAG = "[pi-cursor-crash-guard]"

function installCrashGuards() {
  const existing = process.listeners("unhandledRejection") as Array<(...a: unknown[]) => void>
  if (existing.some(fn => (fn as any)._piCursorTag === CURSOR_CRASH_TAG)) return

  const isCursorError = (reason: any): boolean => {
    const msg = reason instanceof Error ? reason.message : String(reason)
    if (reason?.code === 8 || reason?.code === 16 || reason?.code === 13 || reason?.code === 14) return true
    if (/resource_exhausted|unauthenticated|ConnectError|ENHANCE_YOUR_CALM|Stream closed|unavailable|ETIMEDOUT|ECONNRESET/i.test(msg)) return true
    if (reason?.details?.some?.((d: any) => d.type?.includes("aiserver"))) return true
    return false
  }

  function guardedAbort(label: string, errMsg: string) {
    const contextualToken = cursorRunContext.getStore()
    let runToken = contextualToken
    let active = runToken ? activeRunAborts.get(runToken) : undefined
    if (!active && activeRunAborts.size === 1) {
      const only = activeRunAborts.entries().next().value as [string, ActiveRunAbort] | undefined
      if (only) [runToken, active] = only
    }
    if (!runToken || !active) {
      if (activeRunAborts.size > 1) {
        piLog("warn", label + " could not be associated with one run; leaving concurrent chats isolated:", errMsg)
      }
      return
    }
    const now = Date.now()
    if (now - active.lastCrashGuardAt < CRASH_GUARD_COOLDOWN_MS) {
      piLog("warn", label + " ignored (cooldown active, stale gRPC cascade):", errMsg)
      return
    }
    const captured = active.controller
    if (!captured || captured.signal.aborted) return
    active.lastCrashGuardAt = now
    piLog("warn", label + ":", errMsg)
    captured.abort()
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
const AGENT_MAX_IDLE_MS = 60 * 60 * 1000
const AGENT_HANG_TIMEOUT_MS = 10 * 60 * 1000

interface CursorParam { id: string; value: string }
const paramRegistry = new Map<string, { modelId: string; params?: CursorParam[] }>()

interface AgentState { agents: Record<string, string> }

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

function persistAgentId(cwd: string, sk: string, agentId: string) {
  const state = loadAgentState(cwd)
  state.agents[sk] = agentId
  saveAgentState(cwd, state)
}

const FALLBACK_CONTEXT_MAX_CHARS = 60_000

async function buildCursorConversationSeed(
  Agent: { messages: { list: any } },
  savedId: string,
  cwd: string,
): Promise<string> {
  try {
    const msgs = await sdkAgent.messages.list(savedId, { runtime: "local", cwd })
    if (!msgs?.length) return ""
    const seed = turnsToSeedText(msgs)
    if (!seed) return ""
    return `[Previous Cursor conversation]\n${seed.length > FALLBACK_CONTEXT_MAX_CHARS ? seed.slice(0, FALLBACK_CONTEXT_MAX_CHARS) + "\n[... truncated ...]" : seed}\n[/Previous Cursor conversation]\n\n`
  } catch (e: any) {
    piLog("warn", "Cursor conversation re-seed unavailable:", e?.message || String(e))
    return ""
  }
}

function turnsToSeedText(msgs: any[]): string {
  const parts: string[] = []
  for (const entry of msgs ?? []) {
    const turn = entry?.message?.turn?.value
    if (!turn) continue
    const userText = turn?.userMessage?.text
    if (typeof userText === "string" && userText.trim()) {
      parts.push(`User: ${userText}`)
    }
    for (const step of turn?.steps ?? []) {
      const asst = step?.assistantMessage?.text
      if (typeof asst === "string" && asst.trim()) {
        parts.push(`Assistant: ${asst}`)
      }
    }
  }
  return parts.join("\n\n")
}

function messageText(msg: any): string {
  const c = msg?.content
  if (typeof c === "string") return c.trim()
  if (!Array.isArray(c)) return ""
  return c
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n")
    .trim()
}

function buildFallbackContext(ctx: Context): string {
  const msgs = (ctx?.messages ?? []) as any[]
  let lastUser = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "user") { lastUser = i; break }
  }
  const prior: string[] = []
  for (const msg of lastUser >= 0 ? msgs.slice(0, lastUser) : msgs) {
    if (msg?.role !== "user" && msg?.role !== "assistant") continue
    const text = messageText(msg)
    if (!text) continue
    prior.push(`${msg.role === "user" ? "User" : "Assistant"}: ${text}`)
  }
  if (!prior.length) return ""

  const tail: string[] = []
  let budget = FALLBACK_CONTEXT_MAX_CHARS - prior[0].length
  for (let i = prior.length - 1; i >= 1 && budget > prior[i].length; i--) {
    tail.unshift(prior[i])
    budget -= prior[i].length
  }
  const omitted = prior.length - 1 - tail.length
  const body = omitted > 0
    ? [prior[0], `[... ${omitted} earlier message(s) omitted ...]`, ...tail]
    : [prior[0], ...tail]
  return `[Previous conversation context]\n${body.join("\n\n")}\n[/Previous conversation context]\n\n`
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

const PROJECT_MEMORY_MAX_CHARS = 2000
const projectMemoryCache = new Map<string, { mtimeMs: number; text: string }>()

function buildProjectMemoryBlock(cwd: string): string {
  try {
    const p = join(cwd, ".pi", "memory", "index.md")
    const st = statSync(p)
    const cached = projectMemoryCache.get(cwd)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.text
    const content = readFileSync(p, "utf8").slice(0, PROJECT_MEMORY_MAX_CHARS).trim()
    const text = content
      ? `[Project wiki index (.pi/memory/index.md — read log.md and pages/ for detail)]\n${content}\n\n`
      : ""
    projectMemoryCache.set(cwd, { mtimeMs: st.mtimeMs, text })
    return text
  } catch {
    return ""
  }
}

const LOCAL_TOOLS_GUIDANCE =
  "[Environment & tool guidance]\n" +
  "- Your read, grep, glob and shell tools access the REAL local files of this machine (this project's directory). Use them to inspect the codebase.\n" +
  "- Cloud 'search' tools cannot see local files; do not rely on them to explore this project.\n" +
  "- The .cursorignore exclusions (node_modules/, dist/, .astro/, .wrangler/, .firecrawl/, build output, generated files) are INTENTIONAL boundaries. The tools already respect them; do NOT bypass them with shell/rg to reach ignored directories. Only inspect source files the project owns.\n" +
  "- Vendor or third-party code embedded in the project (files with a license header, 'extract from ... source', bundled/minified third-party code) is NOT ours to edit: inspect it but never modify it.\n" +
  "- Policy: never run dangerous shell commands: git push/commit/reset --hard, rm -rf, sudo, chmod 777, chown, dd, mkfs, fdisk, curl|sh, wget|sh, shutdown/reboot/poweroff/halt. They are blocked.\n" +
  "- If this project has .pi/memory/, it keeps a project wiki (index.md catalog, log.md history, pages/ topics) that you maintain: read .pi/memory/index.md for project memory, and REGISTER your findings there (log.md after any non-trivial task, pages for bugs/decisions) - never leave knowledge only in this conversation. But the REST of .pi/ is internal: never edit .pi/cursor-agents.json, .pi/pi-block-state.json, or .pi/agent/ (provider state, global config with credentials like auth.json). Only .pi/memory/ (the wiki) is yours to edit.\n\n"

function genHookScript(): string {
  return `#!/bin/bash
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
  const visionHints = ["vision", "image", "multimodal"]
  for (const hint of visionHints) {
    if (paramIds.has(hint)) return true
  }
  for (const param of m.parameters ?? []) {
    if (param.values?.some(v => /vision|image|multimodal/i.test(v.value))) return true
  }
  if (/vision/i.test(m.displayName)) return true
  return /^(gemini|grok|kimi|claude-)/i.test(m.id)
}

function hasThinking(m: CursorModelEntry): boolean {
  const paramIds = new Set(m.parameters?.map(p => p.id) ?? [])
  return paramIds.has("thinking") || paramIds.has("reasoning")
}

function ctxWindow(m: CursorModelEntry, p: CursorParam[]): number {
  const c = p.find(x => x.id === "context")
  if (c) return parseCtxValue(c.value)

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

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const

type DeltaStreamState = {
  g: AssistantMessage
  st: AssistantMessageEventStream
  m: Model<Api>
  textIdx: number
  textAcc: string
  activeToolCalls: Map<string, string>
  usageBilling: UsageBilling | null
  contextTokens: number
  localAbort: AbortController
  resetHangTimer?: () => void
}

function estimatePiContextTokens(ctx: Context): number {
  let total = 0
  for (const msg of (ctx?.messages ?? []) as any[]) total += estimateTokens(msg)
  return total
}

function applyTurnUsage(
  u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  state: DeltaStreamState,
) {
  if (!state.usageBilling) {
    state.usageBilling = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
  const billing = state.usageBilling
  billing.input += Math.max(0, u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens)
  billing.output += u.outputTokens
  billing.cacheRead += u.cacheReadTokens
  billing.cacheWrite += u.cacheWriteTokens

  const billingUsage = {
    ...billing, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  calculateCost(state.m, billingUsage)
  state.g.usage.cost = billingUsage.cost

  state.g.usage.input = state.contextTokens
  state.g.usage.output = billing.output
  state.g.usage.cacheRead = 0
  state.g.usage.cacheWrite = 0
  state.g.usage.totalTokens = state.contextTokens + estimateTokens(state.g as any)
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
  state.resetHangTimer?.()
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

async function waitForRunResult(run: any, abortSignal: AbortSignal, apiKey: string, modelSel: { id: string; params?: CursorParam[] }, cwd: string, sessionId: string, sk: string): Promise<any> {
  if (abortSignal.aborted) throw new Error("aborted")
  const terminal = new Set(["finished", "error", "cancelled"])
  if (run.status && terminal.has(run.status)) {
    try {
      return await run.wait()
    } catch (e: any) {
      if (e instanceof Error && (e.name === "AuthenticationError" || e.message?.includes("Unauthenticated") || (e as any)?.code === 16)) {
        throw new sdkAuthenticationError(e.message)
      }
      throw e
    }
  }

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
    const waitNow = async () => {
      try {
        const r = await run.wait()
        finish(true, r)
      } catch (e: any) {
        if (e instanceof Error && (e.name === "AuthenticationError" || e.message?.includes("Unauthenticated") || (e as any)?.code === 16)) {
          finish(false, new sdkAuthenticationError(e.message))
        } else {
          finish(false, e)
        }
      }
    }
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
  try {
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
  } catch (e: any) {
    if (e instanceof Error && (e.name === "AuthenticationError" || e.message?.includes("Unauthenticated") || (e as any)?.code === 16)) {
      throw new sdkAuthenticationError(e.message)
    }
    throw e
  }
}

function buildSendOptions(
  modelSel: { id: string; params?: CursorParam[] },
  state: DeltaStreamState,
  force?: boolean,
  isContinuation?: boolean,
) {
  const opts: any = {
    model: modelSel,
    onDelta: ({ update }: { update: any }) => handleInteractionUpdate(update, state),
    streamingBehavior: isContinuation ? "followUp" : "steer",
  }
  if (force) opts.local = { force: true }
  return opts
}

function resetDeltaStreamState(state: DeltaStreamState) {
  state.g.content = []
  state.g.usage = { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }
  state.g.stopReason = "stop"
  state.g.errorMessage = undefined
  state.textIdx = -1
  state.textAcc = ""
  state.activeToolCalls.clear()
  state.usageBilling = null
}

function hasThinkingOrToolOutput(state: DeltaStreamState): boolean {
  return state.g.content.some(
    c => c.type === "thinking" && (c as any).thinking?.trim().length > 0
  )
}

const AUTH_RESULT_RE = /authenticat|unauthenticated|invalid.*key|session.*expired|logged?\s*(in|out)/i
const ACTIVE_RUN_RE = /already has active run/i
const AUTH_RETRY_BACKOFF_MS = [3_000, 9_000, 25_000]
const MAX_AUTH_PARK_ATTEMPTS = 3
const SDK_TOKEN_MAX_AGE_MS = 50 * 60 * 1000
const SDK_ENABLE_AGENT_RETRIES = true
const AUTH_PARK_INTERVAL_MS = 60_000

const WARMUP_BACKOFF_MS = [5_000, 15_000, 30_000]
const RESOURCE_EXHAUSTED_RE = /resource_exhausted/i
const RESOURCE_EXHAUSTED_BACKOFF_BASE_MS = 10_000
const RESOURCE_EXHAUSTED_BACKOFF_JITTER_MS = 5_000
const MAX_IN_TURN_RETRY_WAIT_MS = 30_000
const RESOURCE_EXHAUSTED_CIRCUIT_MS = 60_000
const resourceExhaustedUntil = new Map<string, number>()

function isResourceExhaustedError(value: any): boolean {
  const code = value?.code ?? value?.error?.code ?? value?.cause?.code
  const msg = value?.message ?? value?.error?.message ?? value?.cause?.message ?? ""
  return code === 8 || code === "8" || code === "resource_exhausted" || RESOURCE_EXHAUSTED_RE.test(String(msg))
}

function resourceExhaustedBackoffMs(): number {
  return RESOURCE_EXHAUSTED_BACKOFF_BASE_MS + Math.floor(Math.random() * RESOURCE_EXHAUSTED_BACKOFF_JITTER_MS)
}

function extractRetryAfterMs(...errs: any[]): number | undefined {
  for (const err of errs) {
    let cur: any = err
    while (cur) {
      const n = Number(cur?.metadata?.get?.("retryafterms"))
      if (Number.isFinite(n) && n > 0) return n
      cur = cur?.cause
    }
  }
  return undefined
}

function openResourceExhaustedCircuit(sk: string, hintMs?: number): number {
  const until = Date.now() + Math.max(RESOURCE_EXHAUSTED_CIRCUIT_MS, hintMs ?? 0)
  resourceExhaustedUntil.set(sk, until)
  return until
}

function resourceExhaustedPauseMessage(detail: string, circuitUntil: number, sk: string): string {
  let remainingSec = Math.ceil((circuitUntil - Date.now()) / 1000)
  if (remainingSec <= 0) {
    const until = openResourceExhaustedCircuit(sk)
    remainingSec = Math.max(1, Math.ceil((until - Date.now()) / 1000))
  }
  return `Cursor resource exhausted: ${detail}. This chat/model is paused for ${remainingSec}s; other chats remain available.`
}

async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("aborted"))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

const SYNTHETIC_FAILURE_LABEL: Record<string, string> = {
  auth_error: "Cursor auth error",
  resource_exhausted: "Cursor resource exhausted",
}

function isAuthLikeError(e: any): boolean {
  const msg = e?.message ?? String(e ?? "")
  return e instanceof sdkAuthenticationError || e?.code === 16
    || /unauthenticated/i.test(msg) || AUTH_RESULT_RE.test(msg)
    || msg.startsWith(SYNTHETIC_FAILURE_LABEL.auth_error)
}

async function probeFreshAgentAuth(
  createAgent: () => Promise<CursorSdkAgent>,
  modelSel: { id: string; params?: CursorParam[] },
  abortRej: Promise<never>,
): Promise<boolean> {
  let probe: CursorSdkAgent | undefined
  const work = (async () => {
    try {
      probe = await createAgent()
      const run = await probe.send("", { model: modelSel, streamingBehavior: "followUp" } as any)
      for await (const _ of run.stream()) {}
      const result = await run.wait()
      if (result?.status === "finished") return true
      const msg = result?.error?.message ?? ""
      piLog(
        "warn",
        `Auth probe non-finished: status=${result?.status ?? "?"} msg=${msg.slice(0, 160)}`,
      )
      return false
    } catch (e: any) {
      piLog("warn", "Auth probe failed:", e?.message || String(e))
      return false
    }
  })()
  try {
    return await Promise.race([work, abortRej])
  } catch (e: any) {
    piLog("warn", "Auth probe aborted/raced:", e?.message || String(e))
    return false
  } finally {
    try { probe?.close() } catch {}
  }
}

function isActiveRunError(resultOrMsg: any): boolean {
  const msg = typeof resultOrMsg === "string"
    ? resultOrMsg
    : resultOrMsg?.error?.message ?? resultOrMsg?.message ?? ""
  return ACTIVE_RUN_RE.test(msg)
}

function isNonTruncationError(result: any): boolean {
  if (result?.status !== "error") return false
  const msg = result?.error?.message ?? ""
  return AUTH_RESULT_RE.test(msg)
    || isResourceExhaustedError(result)
    || isActiveRunError(msg)
}

function applyRunResult(result: any, state: DeltaStreamState) {
  if (!result) return
  if (result.status === "context_exhausted") {
    state.g.stopReason = "error"
    state.g.errorMessage = "context window exceeded"
    return
  }
  if (state.textIdx < 0 && result.result && !isSdkOutputNoise(result.result)) {
    state.g.content.push({ type: "text", text: result.result })
    state.textIdx = state.g.content.length - 1
    state.st.push({ type: "text_start", contentIndex: state.textIdx, partial: state.g })
    state.st.push({ type: "text_delta", contentIndex: state.textIdx, delta: result.result, partial: state.g })
    state.st.push({ type: "text_end", contentIndex: state.textIdx, content: result.result, partial: state.g })
  }
  const syntheticLabel = SYNTHETIC_FAILURE_LABEL[result?.status]
  if (syntheticLabel) {
    state.g.stopReason = "error"
    const msg = result?.error?.message || ""
    state.g.errorMessage = msg ? `${syntheticLabel}: ${msg}` : syntheticLabel
    piLog("warn", `Run failed with status=${result.status}:`, msg)
    return
  }
  const hasOutput = state.textIdx >= 0 && state.textAcc.trim().length > 0
  const hasToolWork = hasThinkingOrToolOutput(state)
  if (result?.status === "finished" && !hasOutput && !hasToolWork) {
    state.g.stopReason = "error"
    state.g.errorMessage = "Cursor agent returned an empty finished run (corrupted agent state); will recreate the agent"
    piLog("warn", `Run status=finished with zero output/thinking/tools (corrupted agent state): model=${result.model?.id ?? "?"} requestId=${result.requestId ?? "?"} durationMs=${result.durationMs ?? "?"} usage=${JSON.stringify(result.usage ?? null)}`)
    return
  }
  if (result?.status === "finished" || hasOutput || hasToolWork) {
    state.g.stopReason = "stop"
    if (result?.status === "finished") {
      piLog("info", `Run finished: model=${result.model?.id ?? "?"} params=${JSON.stringify(result.model?.params ?? [])} requestId=${result.requestId ?? "?"} durationMs=${result.durationMs ?? "?"} usage=${JSON.stringify(result.usage ?? null)}`)
    }
  } else if (result?.status === "error") {
    state.g.stopReason = "error"
    const sdkErrMsg = result?.error?.message || ""
    state.g.errorMessage = sdkErrMsg
      ? `Cursor agent error: ${sdkErrMsg}`
      : "Cursor agent error (not output truncation)"
    piLog("warn", "Run status=error with no output, result:", JSON.stringify(result).slice(0, 500))
  } else if (result?.status === "cancelled") {
    state.g.stopReason = "aborted"
    state.g.errorMessage = "run cancelled"
  } else {
    state.g.stopReason = "length"
    piLog("warn", "Run ended with non-finished status:", result?.status, "— response may be truncated")
  }
}

function pushTerminalEvent(st: AssistantMessageEventStream, g: AssistantMessage) {
  if (g.stopReason === "error" || g.stopReason === "aborted") {
    st.push({ type: "error", reason: g.stopReason, error: g })
  } else {
    st.push({ type: "done", reason: g.stopReason as "stop" | "length" | "toolUse", message: g })
  }
  st.end()
}

function makeAbortRej(abort: AbortController): Promise<never> {
  return new Promise<never>((_, rej) => {
    if (abort.signal.aborted) rej(new Error("aborted"))
    abort.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })
  })
}

function createRecoveryAbort(
  o: SimpleStreamOptions | undefined,
  runToken: string,
  sessionId: string,
): AbortController {
  const recoveryAbort = new AbortController()
  registerRunAbort(runToken, sessionId, recoveryAbort)
  if (o?.signal) {
    if (o.signal.aborted) recoveryAbort.abort()
    else o.signal.addEventListener("abort", () => recoveryAbort.abort(), { once: true })
  }
  return recoveryAbort
}

const MAX_OUTPUT_CONTINUATIONS = 3

async function executeSendCycle(args: {
  agent: CursorSdkAgent
  text: string
  images: { data: string; mimeType: string }[]
  modelSel: { id: string; params?: CursorParam[] }
  state: DeltaStreamState
  force?: boolean
  abortRej: Promise<never>
  apiKey?: string
  cwd?: string
  sessionId?: string
  sk?: string
}): Promise<any> {
  const { agent, text, images, modelSel, state, force, abortRej, apiKey, cwd, sessionId, sk } = args
  let run: any
  try {
    run = await Promise.race([
      agent.send(
        images.length ? { text, images } : text,
        buildSendOptions(modelSel, state, force, false),
      ),
      abortRej,
    ])
  } catch (e: any) {
    const isAuthError = e instanceof sdkAuthenticationError || e?.code === 16 || /unauthenticated/i.test(e?.message ?? "")
    if (isAuthError && apiKey && cwd && sessionId && sk) {
      throw new sdkAuthenticationError(e.message)
    }
    throw e
  }
  try {
    await consumeRunStream(run, state)
  } catch (e: any) {
    const isAuthError = e instanceof sdkAuthenticationError || e?.code === 16 || /unauthenticated/i.test(e?.message ?? "")
    if (isAuthError && apiKey && cwd && sessionId && sk) {
      throw new sdkAuthenticationError(e.message)
    }
    throw e
  }
  if (state.textIdx >= 0 && state.textAcc) {
    state.st.push({ type: "text_end", contentIndex: state.textIdx, content: state.textAcc, partial: state.g })
  }
  if (state.localAbort.signal.aborted) throw new Error("aborted")
  let result: any
  try {
    result = await Promise.race([waitForRunResult(run, state.localAbort.signal, apiKey || "", modelSel, cwd || "", sessionId || "", sk || ""), abortRej])
  } catch (e) {
    if (state.localAbort.signal.aborted) throw e
    if (e instanceof sdkAuthenticationError || (e as any)?.code === 16) {
      throw e
    }
    piLog("warn", "waitForRunResult failed:", e instanceof Error ? e.message : String(e))
    return { status: "error" }
  }

  if (result?.status === "error") {
    piLog("warn", "Agent returned status=error, result:", JSON.stringify(result).slice(0, 500))
  }

  if (isActiveRunError(result) && !force && !state.localAbort.signal.aborted) {
    piLog("warn", "Agent already has active run, retrying once with force (keep memory)...")
    try {
      run = await Promise.race([
        agent.send(
          images.length ? { text, images } : text,
          buildSendOptions(modelSel, state, true, false),
        ),
        abortRej,
      ])
      await consumeRunStream(run, state)
      if (state.textIdx >= 0 && state.textAcc) {
        state.st.push({
          type: "text_end",
          contentIndex: state.textIdx,
          content: state.textAcc,
          partial: state.g,
        })
      }
      result = await Promise.race([
        waitForRunResult(
          run,
          state.localAbort.signal,
          apiKey || "",
          modelSel,
          cwd || "",
          sessionId || "",
          sk || "",
        ),
        abortRej,
      ])
    } catch (e: any) {
      if (state.localAbort.signal.aborted) throw e
      if (e instanceof sdkAuthenticationError || e?.code === 16) {
        throw e
      }
      piLog("warn", "Force retry after active run failed:", e instanceof Error ? e.message : String(e))
    }
  }

  let continuations = 0
  while (
    result?.status !== "finished" &&
    result?.status !== "cancelled" &&
    !isNonTruncationError(result) &&
    continuations < MAX_OUTPUT_CONTINUATIONS &&
    !state.localAbort.signal.aborted
  ) {
    piLog("warn", `Run not finished (status=${result?.status}), continuation ${continuations + 1}/${MAX_OUTPUT_CONTINUATIONS}...`)
    continuations++
    const contRun = await Promise.race([
      agent.send("", buildSendOptions(modelSel, state, false, true)),
      abortRej,
    ])
    await consumeRunStream(contRun, state)
    if (state.textIdx >= 0 && state.textAcc) {
      state.st.push({ type: "text_end", contentIndex: state.textIdx, content: state.textAcc, partial: state.g })
    }
    if (state.localAbort.signal.aborted) throw new Error("aborted")
    try {
      result = await Promise.race([waitForRunResult(contRun, state.localAbort.signal, apiKey || "", modelSel, cwd || "", sessionId || "", sk || ""), abortRej])
    } catch (e) {
      if (state.localAbort.signal.aborted) throw e
      if (e instanceof sdkAuthenticationError || (e as any)?.code === 16) {
        throw e
      }
      result = undefined
      break
    }
    if (result?.status === "error") {
      piLog("warn", `Continuation ${continuations}/${MAX_OUTPUT_CONTINUATIONS} returned status=error — keeping partial output`)
      break
    }
  }

  if (result?.status === "error" && result?.error?.message && AUTH_RESULT_RE.test(result.error.message)) {
    piLog("warn", "Auth error detected in result:", result.error.message)
    return { status: "auth_error", error: result.error }
  }

  if (result?.status === "error" && isResourceExhaustedError(result)) {
    piLog("warn", `Resource exhausted in result: model=${result.model?.id ?? "?"} params=${JSON.stringify(result.model?.params ?? [])} requestId=${result.requestId ?? "?"} durationMs=${result.durationMs ?? "?"} errorCode=${result.error?.code ?? "?"}`)
    return { status: "resource_exhausted", error: result.error, model: result.model, requestId: result.requestId, durationMs: result.durationMs }
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

const rulesDir = join(PLUGIN_DIR, "rules")
const _rulesSrcMtime = new Map<string, number>()

function ensureCursorRules(cwd: string) {
  const targetDir = join(cwd, ".cursor", "rules")
  mkdirSync(targetDir, { recursive: true })
  for (const file of readdirSync(rulesDir)) {
    if (!file.endsWith(".mdc")) continue
    const src = join(rulesDir, file)
    const target = join(targetDir, file)
    try {
      const srcStat = statSync(src)
      const cachedSrcMtime = _rulesSrcMtime.get(file)
      if (cachedSrcMtime === srcStat.mtimeMs && existsSync(target)) {
        const targetStat = statSync(target)
        if (targetStat.mtimeMs >= srcStat.mtimeMs) continue
      }
      _rulesSrcMtime.set(file, srcStat.mtimeMs)
      const srcContent = readFileSync(src, "utf-8")
      if (existsSync(target)) {
        const targetContent = readFileSync(target, "utf-8")
        if (srcContent === targetContent) continue
      }
      writeFileSync(target, srcContent, "utf-8")
    } catch {}
  }
}

const extDir = join(PLUGIN_DIR, "..", "..", "bin")
if (!process.env.PATH?.includes(extDir)) {
  process.env.PATH = extDir + ":" + (process.env.PATH ?? "")
}

const CURSOR_MODELS_CACHE = join(PLUGIN_DIR, "cursor-models.json")

function saveModelsCache(models: CursorModelEntry[]) {
  try { writeFileSync(CURSOR_MODELS_CACHE, JSON.stringify(models), "utf-8") } catch {}
}

function loadModelsCache(): CursorModelEntry[] | undefined {
  try {
    if (!existsSync(CURSOR_MODELS_CACHE)) return undefined
    const data = JSON.parse(readFileSync(CURSOR_MODELS_CACHE, "utf-8"))
    if (!Array.isArray(data) || !data.length) return undefined
    piLog("info", "Loaded", data.length, "models from cache")
    return data
  } catch { return undefined }
}

export default async function (pi: ExtensionAPI) {
  setSessionCwd(undefined, process.cwd())
  const apiKey = getApiKey()
  if (!apiKey) { piLog("warn", "No API key — provider NOT registered"); return }

  if (!(await reloadSdk())) {
    piLog("error", "Failed to load @cursor/sdk — provider NOT registered")
    return
  }
  const Cursor = sdkModule.Cursor
  if (!Cursor?.models?.list) {
    piLog("error", "Cursor.models.list missing after SDK load — provider NOT registered")
    return
  }
  let cursorModels: CursorModelEntry[] = []
  try {
    const models = await Promise.race([
      Cursor.models.list({ apiKey }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("models.list timeout (no internet?)")), 10_000)),
    ])
    cursorModels = models as CursorModelEntry[]
    if (cursorModels.length) saveModelsCache(cursorModels)
  } catch (err) {
    piLog("warn", "Model discovery FAILED (offline?):", err)
    cursorModels = loadModelsCache() ?? []
    if (!cursorModels.length) {
      piLog("error", "No cached models — provider NOT registered. Connect to internet and restart.")
      return
    }
    piLog("info", "Using cached models from previous successful fetch")
  }
  if (!cursorModels.length) { piLog("warn", "No models — provider NOT registered"); return }

  const flippedFast: string[] = []
  for (const cm of cursorModels) {
    const allV = cm.variants?.length ? cm.variants : [{ params: [] }]
    const defV = allV.find(v => v.isDefault) ?? allV[0]
    const defP = defV.params ?? []

    let finalP = defP
    const fast = defP.find(p => p.id === "fast")
    if (fast?.value === "true") {
      finalP = defP.map(p => p.id === "fast" ? { id: "fast", value: "false" } : p)
      flippedFast.push(cm.id)
    }
    if (cm.id === "default") continue
    paramRegistry.set(cm.id, { modelId: cm.id, params: finalP.length ? finalP : undefined })
  }
  if (flippedFast.length) {
    piLog("info", `Forced fast=false on ${flippedFast.length} model(s) whose default variant had fast=true: ${flippedFast.join(", ")}`)
  }
  piLog("info", `SDK transport auto-retry is ON (enableAgentRetries=${SDK_ENABLE_AGENT_RETRIES}): the SDK retries stalls/connection failures internally (2x, 10x endless; server errors 3x) before our recovery layer sees them`)

  const piModels = cursorModels
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
    for (const [key, entry] of activeAgents) {
      if (entry.sessionId === sessionId) {
        stuckAgentIds.delete(entry.agentId)
      }
    }
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

  pi.on("session_shutdown", async (ev: any, ctx) => {
    const sessionId = getSessionId(ctx, ev)
    const scopedSession = hasProvidedSessionId(ctx, ev)
    for (const [key, entry] of activeAgents) {
      persistAgentId(entry.cwd, key, entry.agentId)
    }
    for (const [key, entry] of activeAgents) {
      if (scopedSession && entry.sessionId !== sessionId) continue
      if (ev && ev.reason === "quit") {
        try { entry.agent.close() } catch {}
      }
      activeAgents.delete(key)
    }
    if (scopedSession) sessionCwds.delete(sessionId)
    if (ev?.reason === "quit") {
      clearInterval(_stuckCleanupInterval)
      for (const cwd of hooksInstalledForCwd) {
        try { removeHooks(cwd) } catch {}
      }
    }
  })

  pi.on("session_before_compact", (event: any, ctx) => {
    const sessionId = providedSessionId(ctx, event)
    if (!sessionId) {
      piLog("warn", "Compaction abort skipped: session id unavailable")
      return
    }
    for (const active of activeRunAborts.values()) {
      if (active.sessionId !== sessionId) continue
      try { active.controller.abort() } catch {}
    }
  })
  pi.on("session_compact", (event: any, ctx) => {
    const sessionId = providedSessionId(ctx, event)
    if (!sessionId) {
      piLog("warn", "Agent recycling skipped after compaction: session id unavailable")
      return
    }
    for (const [key, entry] of [...activeAgents]) {
      if (entry.sessionId !== sessionId) continue
      piLog("info", "Session compacted, recycling Cursor agent:", entry.agentId.slice(0, 16))
      evictAgent(key, entry.cwd, entry)
    }
  })
}

function releaseAgent(sk: string, agentEntry?: ActiveAgentEntry) {
  if (!agentEntry) return
  try { agentEntry.agent.close() } catch {}
  activeAgents.delete(sk)
}

function evictAgent(sk: string, cwd: string, agentEntry?: ActiveAgentEntry) {
  if (agentEntry) {
    stuckAgentIds.add(agentEntry.agentId)
    try { agentEntry.agent.close() } catch {}
    activeAgents.delete(sk)
    try {
      const s = loadAgentState(cwd)
      delete s.agents[sk]
      saveAgentState(cwd, s)
    } catch {}
  }
}

async function retrySendWithAgent(
  agent: CursorSdkAgent,
  args: {
    text: string; images: { data: string; mimeType: string }[]
    modelSel: { id: string; params?: CursorParam[] }
    deltaState: DeltaStreamState; st: AssistantMessageEventStream
    localAbort: AbortController; abortRej: Promise<never>
    force?: boolean
    apiKey?: string
    cwd?: string
    sessionId?: string
    sk?: string
  },
) {
  const { text, images, modelSel, deltaState, st, localAbort, abortRej, force, apiKey, cwd, sessionId, sk } = args
  resetDeltaStreamState(deltaState)
  st.push({ type: "start", partial: deltaState.g })
  const result = await executeSendCycle({
    agent, text, images, modelSel, state: deltaState, abortRej, force, apiKey, cwd, sessionId, sk,
  })
  const syntheticLabel = SYNTHETIC_FAILURE_LABEL[result?.status]
  if (syntheticLabel) {
    throw new Error(`${syntheticLabel}: ${result?.error?.message || "retry failed"}`)
  }
  applyRunResult(result, deltaState)
  if (localAbort.signal.aborted) throw new Error("aborted")
  pushTerminalEvent(st, deltaState.g)
}

async function warmUpAgent(
  agent: CursorSdkAgent,
  modelSel: { id: string; params?: CursorParam[] },
  apiKey: string,
  cwd: string,
  sessionId: string,
  sk: string,
  localAbort: AbortController,
  abortRej: Promise<never>,
  resetHangTimer: (() => void) | undefined,
  createFreshAgent: () => Promise<CursorSdkAgent>,
): Promise<"ready" | "aborted" | "escalate"> {
  for (let attempt = 1; ; attempt++) {
    if (localAbort.signal.aborted) return "aborted"
    resetHangTimer?.()
    const parked = attempt > WARMUP_BACKOFF_MS.length
    try {
      const run = await Promise.race([
        agent.send("", { model: modelSel, streamingBehavior: "followUp" }),
        abortRej,
      ])
      for await (const _ of run.stream()) {}
      const result = await waitForRunResult(run, localAbort.signal, apiKey, modelSel, cwd, sessionId, sk)
      const msg = result?.error?.message ?? ""
      if (result?.status === "finished" || !AUTH_RESULT_RE.test(msg)) return "ready"
      piLog("warn", `Warm-up auth-rejected (attempt ${attempt}), still waiting for Cursor auth...`)
    } catch (e: any) {
      if (localAbort.signal.aborted) return "aborted"
      if (!isAuthLikeError(e)) return "ready"
      piLog("warn", `Warm-up auth error (attempt ${attempt}), still waiting for Cursor auth...`)
    }
    if (parked && await probeFreshAgentAuth(createFreshAgent, modelSel, abortRej)) {
      return "escalate"
    }
    const waitMs = parked ? AUTH_PARK_INTERVAL_MS : WARMUP_BACKOFF_MS[attempt - 1]
    try {
      await waitForRetry(waitMs, localAbort.signal)
    } catch {
      return "aborted"
    }
  }
}

async function freshApiKeyWorks(apiKey: string): Promise<boolean> {
  try {
    const baseUrl = process.env.CURSOR_BACKEND_URL || "https://api2.cursor.sh"
    const res = await fetch(`${baseUrl}/auth/exchange_user_api_key`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return false
    const body = await res.json().catch(() => null)
    return !!(body?.accessToken && body?.refreshToken)
  } catch {
    return false
  }
}

async function recoverFromAuthError(args: {
  savedId?: string
  initialError?: string
  text: string
  images: { data: string; mimeType: string }[]
  modelSel: { id: string; params?: CursorParam[] }
  deltaState: DeltaStreamState
  st: AssistantMessageEventStream
  localAbort: AbortController
  abortRej: Promise<never>
  resolveApiKey: () => string | undefined
  cwd: string
  sessionId: string
  sk: string
}): Promise<{ ok: boolean; lastError?: string; agentEntry?: ActiveAgentEntry }> {
  const {
    savedId, text, images, modelSel, deltaState, st,
    localAbort, abortRej, resolveApiKey, cwd, sessionId, sk,
  } = args
  let lastError = args.initialError
  let canResume = !!savedId && !stuckAgentIds.has(savedId)
  let agentEntry: ActiveAgentEntry | undefined
  let sendPayload = text
  piLog("warn", "Auth error: restarting sdk-host (fresh Node process)...")
  try {
    await sdkHost.restart()
  } catch (e: any) {
    piLog("warn", "sdk-host restart failed:", e?.message || String(e))
  }
  const createFresh = (apiKey: string) =>
    sdkAgent.create({
      apiKey,
      model: modelSel,
      local: { cwd, settingSources: ["project"], enableAgentRetries: SDK_ENABLE_AGENT_RETRIES },
    })

  for (let attempt = 1; ; attempt++) {
    const parked = attempt > AUTH_RETRY_BACKOFF_MS.length
    if (parked && attempt > AUTH_RETRY_BACKOFF_MS.length + MAX_AUTH_PARK_ATTEMPTS) {
      const key = resolveApiKey()
      const keyOk = key ? await freshApiKeyWorks(key) : false
      if (keyOk) {
        lastError = "Cursor backend kept rejecting auth; API key is valid. Retry the message."
      }
      piLog(
        "error",
        `Auth recovery gave up after ${attempt - 1} attempts. keyExchangeOk=${keyOk}`,
      )
      return { ok: false, lastError, agentEntry }
    }
    const backoffMs = parked ? AUTH_PARK_INTERVAL_MS : AUTH_RETRY_BACKOFF_MS[attempt - 1]
    piLog("warn", parked
      ? `Auth still rejected, parked; probing again in ${backoffMs / 1000}s (attempt ${attempt})...`
      : `Auth error, retrying in ${backoffMs / 1000}s (attempt ${attempt}/${AUTH_RETRY_BACKOFF_MS.length})...`)
    try {
      await waitForRetry(backoffMs, localAbort.signal)
    } catch {
      return { ok: false, lastError, agentEntry }
    }
    deltaState.resetHangTimer?.()
    const apiKey = resolveApiKey()
    if (!apiKey) return { ok: false, lastError: lastError ?? "no API key available", agentEntry }

    let agent: CursorSdkAgent | undefined
    if (canResume && savedId) {
      try {
        piLog("warn", "Trying sdkAgent.resume to preserve memory...")
        agent = await sdkAgent.resume(savedId, { apiKey, local: { cwd, settingSources: ["project"], enableAgentRetries: SDK_ENABLE_AGENT_RETRIES } })
        agentEntry = makeAgentEntry(agent, savedId, cwd, sessionId)
      } catch (resumeErr: any) {
        piLog("warn", "Resume failed, falling back to sdkAgent.create:", resumeErr?.message || resumeErr)
        try {
          const diag = await sdkAgent.listRuns(savedId, { runtime: "local", cwd, limit: 5 })
          const states = (diag?.items ?? []).map((r: any) => `${r.status}${r.errorCode ? "/" + r.errorCode : ""}`).join(", ")
          piLog("warn", `Local store of ${savedId.slice(0, 16)}: ${diag?.items?.length ?? 0} run(s) [${states || "none"}]`)
        } catch (diagErr: any) {
          piLog("warn", "Local store inspection failed:", diagErr?.message || String(diagErr))
        }
        stuckAgentIds.add(savedId)
        canResume = false
        agent = undefined
      }
    }
    if (!agent) {
      try {
        agent = await createFresh(apiKey)
        agentEntry = makeAgentEntry(agent, agent.agentId, cwd, sessionId)
        persistAgentId(cwd, sk, agent.agentId)
      } catch (createErr: any) {
        lastError = createErr?.message || String(createErr)
        piLog("warn", "sdkAgent.create also failed:", lastError)
        if (localAbort.signal.aborted || !isAuthLikeError(createErr)) return { ok: false, lastError, agentEntry }
        continue
      }
    }
    activeAgents.set(sk, agentEntry!)
    try {
      await retrySendWithAgent(agent, {
        text: sendPayload, images, modelSel, deltaState, st, localAbort, abortRej, apiKey, cwd, sessionId, sk,
      })
      piLog("info", `Auth recovery succeeded on attempt ${attempt}`)
      return { ok: true, agentEntry }
    } catch (retryErr: any) {
      lastError = retryErr instanceof Error ? retryErr.message : String(retryErr)
      piLog("warn", `Auth recovery attempt ${attempt} failed:`, lastError)
      if (localAbort.signal.aborted) return { ok: false, lastError, agentEntry }
      if (!isAuthLikeError(retryErr)) {
        releaseAgent(sk, agentEntry)
        return { ok: false, lastError }
      }
      if (parked && canResume && savedId
          && await probeFreshAgentAuth(
            () => createFresh(apiKey),
            modelSel, abortRej)) {
        piLog("warn", "Fresh agent auth probe passed while the resumed session keeps being rejected; abandoning the dead session...")
        stuckAgentIds.add(savedId)
        canResume = false
      }
    }
    releaseAgent(sk, agentEntry)
    agentEntry = undefined
  }
}

function cursorStream(m: Model<Api>, ctx: Context, o?: SimpleStreamOptions): AssistantMessageEventStream {
  const st = createAssistantMessageEventStream()
  const runToken = randomUUID()
  ;(async () => {
    await cursorRunContext.run(runToken, () => withSilencedSdk(async () => {
    const g: AssistantMessage = {
      role: "assistant", content: [],
      api: m.api, provider: m.provider, model: m.id,
      usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
      stopReason: "stop", timestamp: Date.now(),
    }

    const { Agent, AgentBusyError, RateLimitError, AuthenticationError, CursorAgentError, convertConnectError } = sdkModule

    const sessionId = getSessionId(o, inferSessionIdFromContext(ctx))
    lastStreamSessionId = sessionId
    const cwd = getSessionCwd(sessionId)
    const sk = cwd + "|" + sessionId + "|" + m.id
    let agentEntry: ActiveAgentEntry | undefined
    let localAbort: AbortController = new AbortController()
    if (o?.signal) {
      if (o.signal.aborted) {
        localAbort.abort()
        g.stopReason = "aborted"
        g.errorMessage = "request aborted"
        st.push({ type: "error", reason: "aborted", error: g })
        st.end()
        return
      }
      o.signal.addEventListener("abort", () => localAbort.abort(), { once: true })
    }
    registerRunAbort(runToken, sessionId, localAbort)
    let hangTriggered = false
    let forceRetryAttempted = false
    let m1RetryAttempted = false
    let calmRetries = 0
    let hangTimer: ReturnType<typeof setTimeout>
    const resetHangTimer = () => {
      clearTimeout(hangTimer)
      hangTimer = setTimeout(() => {
        piLog("warn", "Agent hang timeout (" + (AGENT_HANG_TIMEOUT_MS / 60000) + "min), aborting...")
        hangTriggered = true
        const agentId = agentEntry?.agentId
        if (agentId) stuckAgentIds.add(agentId)
        localAbort.abort()
      }, AGENT_HANG_TIMEOUT_MS)
    }
    resetHangTimer()

    let apiKey = ""
    let text = ""
    let images: { data: string; mimeType: string }[] = []
    let modelSel: { id: string; params?: CursorParam[] } = { id: m.id }
    let abortRej = makeAbortRej(localAbort)
    let agentIsFresh = false
    let priorSavedId: string | undefined
    const fallbackContext = buildFallbackContext(ctx)
    let sendText = ""
    const deltaState: DeltaStreamState = {
      g, st, m, textIdx: -1, textAcc: "", activeToolCalls: new Map(), usageBilling: null,
      contextTokens: estimatePiContextTokens(ctx), localAbort, resetHangTimer,
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
      if (text) text = LOCAL_TOOLS_GUIDANCE + buildProjectMemoryBlock(cwd) + text

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

      const circuitUntil = resourceExhaustedUntil.get(sk) ?? 0
      if (circuitUntil > Date.now()) {
        const retryInSeconds = Math.max(1, Math.ceil((circuitUntil - Date.now()) / 1000))
        g.stopReason = "error"
        g.errorMessage = `Cursor resource exhausted for this chat/model. Retry in ${retryInSeconds}s; other chats remain available.`
        st.push({ type: "error", reason: "error", error: g })
        st.end()
        return
      }
      if (circuitUntil) resourceExhaustedUntil.delete(sk)

      const preWarmAgent = activeAgents.get(sk)
      agentEntry = activeAgents.get(sk)

      if (!agentEntry) {
        const savedState = loadAgentState(cwd)
        const savedId = savedState.agents[sk]
        const shouldSkipResume = !savedId || stuckAgentIds.has(savedId)
        if (savedId && !shouldSkipResume) {
          try {
            const resumeP = sdkAgent.resume(savedId, { apiKey, local: { cwd, settingSources: ["project"], enableAgentRetries: SDK_ENABLE_AGENT_RETRIES } })
            const resumed = await Promise.race([
              resumeP,
              new Promise<never>((_, rej) => {
                if (localAbort.signal.aborted) rej(new Error("aborted"))
                localAbort.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })
              })
            ])
            agentEntry = makeAgentEntry(resumed, savedId, cwd, sessionId)
            activeAgents.set(sk, agentEntry)
          } catch (err: any) {
            const isAuthError = err instanceof AuthenticationError || err?.code === 16 || /unauthenticated/i.test(err?.message ?? "")
            if (isAuthError) {
              piLog("warn", "Auth error on resume, retrying with fresh API key...")
              apiKey = o?.apiKey || getApiKey(sessionId)
              if (apiKey) {
                try {
                  const freshResumeP = sdkAgent.resume(savedId, { apiKey, local: { cwd, settingSources: ["project"], enableAgentRetries: SDK_ENABLE_AGENT_RETRIES } })
                  const freshResumed = await Promise.race([
                    freshResumeP,
                    new Promise<never>((_, rej) => {
                      if (localAbort.signal.aborted) rej(new Error("aborted"))
                      localAbort.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })
                    })
                  ])
                  agentEntry = makeAgentEntry(freshResumed, savedId, cwd, sessionId)
                  activeAgents.set(sk, agentEntry)
                  piLog("info", "Agent resume succeeded after auth retry")
                } catch (freshErr: any) {
                  piLog("warn", "Fresh resume also failed:", freshErr?.message || freshErr)
                  stuckAgentIds.add(savedId)
                }
              }
            }
            piLog("warn", "Agent resume failed, creating fresh agent:", err?.message || err)
            stuckAgentIds.add(savedId)
            priorSavedId = savedId
          }
        } else if (savedId) {
          const reason = stuckAgentIds.has(savedId) ? "previously stuck" : "session was compacted"
          piLog("warn", "Skipping resume of " + reason + " agent:", savedId.slice(0, 16))
          priorSavedId = savedId
        }
      }
      if (agentEntry) {
        const idleMs = Date.now() - agentEntry.lastUsed
        const tokenMs = Date.now() - agentEntry.tokenAt
        const idleExpired = idleMs > AGENT_MAX_IDLE_MS
        const tokenAged = tokenMs > SDK_TOKEN_MAX_AGE_MS
        if (idleExpired || tokenAged) {
          const savedIdBeforeRestart = agentEntry.agentId
          persistAgentId(cwd, sk, savedIdBeforeRestart)
          if (idleExpired) {
            piLog("info", "Agent idle-expired after " + Math.round(idleMs / 1000) + "s, resuming from disk...")
          } else {
            piLog(
              "info",
              "SDK access token aged " + Math.round(tokenMs / 1000)
                + "s (JWT TTL ~1h); restarting sdk-host...",
            )
            await sdkHost.restart()
          }
          try { agentEntry.agent.close() } catch {}
          activeAgents.delete(sk)
          agentEntry = undefined
          const savedState = loadAgentState(cwd)
          const savedId = savedState.agents[sk] || savedIdBeforeRestart
          if (savedId) {
            try {
              const resumeP = sdkAgent.resume(savedId, { apiKey, local: { cwd, settingSources: ["project"], enableAgentRetries: SDK_ENABLE_AGENT_RETRIES } })
              const resumed = await Promise.race([
                resumeP,
                new Promise<never>((_, rej) => {
                  if (localAbort.signal.aborted) rej(new Error("aborted"))
                  localAbort.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })
                })
              ])
              agentEntry = makeAgentEntry(resumed, savedId, cwd, sessionId)
              activeAgents.set(sk, agentEntry)
              piLog("info", "Agent resumed from disk after idle expiry")
            } catch (err: any) {
              const isAuthError = err instanceof AuthenticationError || err?.code === 16 || /unauthenticated/i.test(err?.message ?? "")
              if (isAuthError) {
                piLog("warn", "Auth error on idle-expired resume, retrying with fresh API key...")
                apiKey = o?.apiKey || getApiKey(sessionId)
                if (apiKey) {
                  try {
                    const freshResumeP = sdkAgent.resume(savedId, { apiKey, local: { cwd, settingSources: ["project"], enableAgentRetries: SDK_ENABLE_AGENT_RETRIES } })
                    const freshResumed = await Promise.race([
                      freshResumeP,
                      new Promise<never>((_, rej) => {
                        if (localAbort.signal.aborted) rej(new Error("aborted"))
                        localAbort.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })
                      })
                    ])
                    agentEntry = makeAgentEntry(freshResumed, savedId, cwd, sessionId)
                    activeAgents.set(sk, agentEntry)
                    piLog("info", "Idle-expired agent resume succeeded after auth retry")
                  } catch (freshErr: any) {
                    piLog("warn", "Fresh idle-expired resume also failed:", freshErr?.message || freshErr)
                    stuckAgentIds.add(savedId)
                  }
                }
              }
              if (!agentEntry) {
                piLog("warn", "Idle-expired agent resume failed, will create fresh:", err?.message || err)
                if (isAuthError) {
                  stuckAgentIds.add(savedId)
                }
                priorSavedId = savedId
              }
            }
          }
        }
      }
      if (!agentEntry) {
        let createSucceeded = false
        try {
          const createP = sdkAgent.create({ apiKey, model: modelSel, local: { cwd, settingSources: ["project"], enableAgentRetries: SDK_ENABLE_AGENT_RETRIES } })
          const agent = await Promise.race([
            createP,
            new Promise<never>((_, rej) => {
              if (localAbort.signal.aborted) rej(new Error("aborted"))
              localAbort.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })
            })
          ])
          agentEntry = makeAgentEntry(agent, agent.agentId, cwd, sessionId)
          activeAgents.set(sk, agentEntry)
          agentIsFresh = true
          persistAgentId(cwd, sk, agent.agentId)
          createSucceeded = true
        } catch (err: any) {
          const isAuthError = err instanceof AuthenticationError || err?.code === 16 || /unauthenticated/i.test(err?.message ?? "")
          if (isAuthError) {
            piLog("warn", "Auth error on sdkAgent.create, retrying with fresh API key...")
            apiKey = o?.apiKey || getApiKey(sessionId)
            if (apiKey) {
              try {
                const freshCreateP = sdkAgent.create({ apiKey, model: modelSel, local: { cwd, settingSources: ["project"], enableAgentRetries: SDK_ENABLE_AGENT_RETRIES } })
                const freshAgent = await Promise.race([
                  freshCreateP,
                  new Promise<never>((_, rej) => {
                    if (localAbort.signal.aborted) rej(new Error("aborted"))
                    localAbort.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })
                  })
                ])
                agentEntry = makeAgentEntry(freshAgent, freshAgent.agentId, cwd, sessionId)
                activeAgents.set(sk, agentEntry)
                agentIsFresh = true
                persistAgentId(cwd, sk, freshAgent.agentId)
                createSucceeded = true
                piLog("info", "sdkAgent.create succeeded after auth retry")
              } catch (freshErr: any) {
                piLog("warn", "Fresh sdkAgent.create also failed:", freshErr?.message || freshErr)
                throw new AuthenticationError(freshErr?.message || "Authentication failed after retry")
              }
            } else {
              throw new AuthenticationError("No API key available after auth error")
            }
          } else {
            throw err
          }
        }
        if (!createSucceeded && !agentEntry) {
          throw new Error("Failed to create agent")
        }
      } else {
        agentEntry.lastUsed = Date.now()
      }

      const agentChanged = !preWarmAgent || preWarmAgent.agent !== agentEntry?.agent
      if (agentChanged && !agentIsFresh && agentEntry && !localAbort.signal.aborted) {
        piLog("info", "Resumed agent cold-start: warming up to clear Cursor auth...")
        const warm = await warmUpAgent(agentEntry.agent, modelSel, apiKey, cwd, sessionId, sk, localAbort, abortRej, deltaState.resetHangTimer,
          () => sdkAgent.create({ apiKey, model: modelSel, local: { cwd, settingSources: ["project"], enableAgentRetries: SDK_ENABLE_AGENT_RETRIES } }))
        if (warm === "aborted") {
          g.stopReason = "aborted"
          g.errorMessage = "aborted"
          st.push({ type: "error", reason: "aborted", error: g })
          st.end()
          return
        }
        if (warm === "escalate") {
          piLog("warn", "Resumed session dead server-side; switching to a fresh agent (re-seeded)...")
          priorSavedId = agentEntry.agentId
          evictAgent(sk, cwd, agentEntry)
          const freshAgent = await sdkAgent.create({ apiKey, model: modelSel, local: { cwd, settingSources: ["project"], enableAgentRetries: SDK_ENABLE_AGENT_RETRIES } })
          agentEntry = makeAgentEntry(freshAgent, freshAgent.agentId, cwd, sessionId)
          activeAgents.set(sk, agentEntry)
          persistAgentId(cwd, sk, freshAgent.agentId)
          agentIsFresh = true
        }
      }

      if (agentChanged && !agentIsFresh && agentEntry && fallbackContext) {
        try {
          const msgs = await sdkAgent.messages.list(agentEntry.agentId, { runtime: "local", cwd })
          if (!msgs?.length) {
            piLog("warn", "Resumed agent has empty local conversation; seeding pi context")
            agentIsFresh = true
          }
        } catch (e: any) {
          piLog("warn", "Could not inspect resumed conversation:", e?.message || String(e))
        }
      }

      st.push({ type: "start", partial: g })

      let seedText = ""
      if (agentIsFresh) {
        if (priorSavedId) {
          const realSeed = await buildCursorConversationSeed(sdkAgent, priorSavedId, cwd)
          if (realSeed) {
            seedText = realSeed
            piLog("info", `Fresh agent re-seeded with ${realSeed.length} chars of real Cursor conversation (was: ${fallbackContext.length} chars pi summary)`)
          }
        }
        if (!seedText && fallbackContext) {
          seedText = fallbackContext
          piLog("info", `Fresh agent seeded with ${fallbackContext.length} chars of pi context`)
        }
        if (!seedText) {
          piLog("warn", "Fresh agent has no seed (empty pi context and no prior Cursor conversation)")
        }
      }
      sendText = seedText ? seedText + text : text
      piLog(
        "info",
        `send session=${sessionId.slice(0, 8)} model=${m.id} `
          + `agent=${(agentEntry?.agentId ?? "none").slice(0, 16)} `
          + `fresh=${agentIsFresh} seedChars=${seedText.length}`,
      )

      const result = await executeSendCycle({
        agent: agentEntry!.agent,
        text: sendText,
        images,
        modelSel,
        state: deltaState,
        abortRej,
        apiKey,
        cwd,
        sessionId,
        sk,
      })
      if (result?.status === "auth_error") {
        piLog("warn", "Auth error in result, attempting transparent recovery...")
        const savedIdForAuthRetry = agentEntry?.agentId
        releaseAgent(sk, agentEntry)
        agentEntry = undefined
        const recovery = await recoverFromAuthError({
          savedId: savedIdForAuthRetry, initialError: result?.error?.message,
          text: sendText, images, modelSel, deltaState, st, localAbort, abortRej,
          resolveApiKey: () => o?.apiKey || getApiKey(sessionId),
          cwd, sessionId, sk,
        })
        if (recovery.ok) return
        agentEntry = recovery.agentEntry
        releaseAgent(sk, agentEntry)
        agentEntry = undefined
        if (localAbort.signal.aborted) {
          g.stopReason = "aborted"
          g.errorMessage = "aborted"
          st.push({ type: "error", reason: "aborted", error: g })
          st.end()
          return
        }
        g.stopReason = "error"
        const lastAuthErr = recovery.lastError || "session expired"
        g.errorMessage = lastAuthErr.startsWith("Cursor") ? lastAuthErr : `Cursor auth error: ${lastAuthErr}`
        st.push({ type: "error", reason: "error", error: g })
        st.end()
        return
      }

      if (result?.status === "resource_exhausted") {
        if (agentEntry && !localAbort.signal.aborted) {
          const backoffMs = resourceExhaustedBackoffMs()
          piLog("warn", `Resource exhausted (requestId=${result?.requestId ?? "?"}), retrying once in ${Math.ceil(backoffMs / 1000)}s for this chat/model...`)
          await waitForRetry(backoffMs, localAbort.signal)
          if (!localAbort.signal.aborted) {
            try {
              await retrySendWithAgent(agentEntry.agent, { text: sendText, images, modelSel, deltaState, st, localAbort, abortRej, apiKey, cwd, sessionId, sk })
              resourceExhaustedUntil.delete(sk)
              return
            } catch (retryErr: any) {
              piLog("warn", "Resource exhausted retry failed:", retryErr instanceof Error ? retryErr.message : String(retryErr))
            }
          }
        }
        const circuitUntil = openResourceExhaustedCircuit(sk)
        releaseAgent(sk, agentEntry)
        agentEntry = undefined
        g.stopReason = "error"
        g.errorMessage = resourceExhaustedPauseMessage(result?.error?.message || "", circuitUntil, sk)
        st.push({ type: "error", reason: "error", error: g })
        st.end()
        return
      }

      applyRunResult(result, deltaState)

      const emptyFinished = result?.status === "finished"
        && deltaState.textIdx < 0
        && !hasThinkingOrToolOutput(deltaState)
      if (emptyFinished && agentEntry && !localAbort.signal.aborted) {
        piLog("warn", `Empty finished run (corrupted agent state) on ${agentEntry.agentId.slice(0, 16)}; evicting and retrying once on a fresh agent...`)
        priorSavedId = agentEntry.agentId
        evictAgent(sk, cwd, agentEntry)
        try {
          const freshAgent = await sdkAgent.create({ apiKey, model: modelSel, local: { cwd, settingSources: ["project"], enableAgentRetries: SDK_ENABLE_AGENT_RETRIES } })
          agentEntry = makeAgentEntry(freshAgent, freshAgent.agentId, cwd, sessionId)
          activeAgents.set(sk, agentEntry)
          persistAgentId(cwd, sk, freshAgent.agentId)
          let freshSeed = ""
          if (priorSavedId) {
            const realSeed = await buildCursorConversationSeed(sdkAgent, priorSavedId, cwd)
            if (realSeed) freshSeed = realSeed
          }
          if (!freshSeed && fallbackContext) freshSeed = fallbackContext
          const freshSendText = freshSeed ? freshSeed + text : text
          await retrySendWithAgent(freshAgent, {
            text: freshSendText, images, modelSel, deltaState, st, localAbort, abortRej,
            apiKey, cwd, sessionId, sk,
          })
          piLog("info", "Fresh agent answered after empty-finished recovery")
          return
        } catch (freshErr: any) {
          piLog("warn", "Fresh agent also failed after empty-finished recovery:", freshErr instanceof Error ? freshErr.message : String(freshErr))
        }
      }

      if ((result?.status === "error" || emptyFinished) && agentEntry && !hasThinkingOrToolOutput(deltaState)) {
        if (isActiveRunError(result)) {
          piLog("warn", "Keeping agent after active-run error (memory preserved):", agentEntry.agentId.slice(0, 16))
        } else {
          piLog("warn", "Agent error: evicting agent", agentEntry.agentId.slice(0, 16), "so next message creates fresh agent")
          evictAgent(sk, cwd, agentEntry)
        }
      }

      if (localAbort.signal.aborted) throw new Error("aborted")
      pushTerminalEvent(st, g)
    } catch (error) {
      if (!sendText) sendText = text
      let sdkErr: any = error
      if (!(error instanceof CursorAgentError)) {
        try { sdkErr = convertConnectError(error as any) } catch { sdkErr = error }
      }

      if (!localAbort.signal.aborted &&
          (isResourceExhaustedError(error) || isResourceExhaustedError(sdkErr))) {
        const serverRetryMs = extractRetryAfterMs(error, sdkErr)
        if (serverRetryMs) piLog("info", `Backend sent retry-after: ${Math.ceil(serverRetryMs / 1000)}s`)
        if (agentEntry && (serverRetryMs ?? 0) <= MAX_IN_TURN_RETRY_WAIT_MS) {
          const backoffMs = serverRetryMs ?? resourceExhaustedBackoffMs()
          try {
            piLog("warn", `Thrown resource_exhausted, retrying once in ${Math.ceil(backoffMs / 1000)}s for this chat/model...`)
            await waitForRetry(backoffMs, localAbort.signal)
            await retrySendWithAgent(agentEntry.agent, { text: sendText, images, modelSel, deltaState, st, localAbort, abortRej, apiKey, cwd, sessionId, sk })
            resourceExhaustedUntil.delete(sk)
            return
          } catch (retryErr: any) {
            if (localAbort.signal.aborted) {
              g.stopReason = "aborted"
              g.errorMessage = "aborted"
              st.push({ type: "error", reason: "aborted", error: g })
              st.end()
              return
            }
            piLog("warn", "Thrown resource_exhausted retry failed:",
              retryErr instanceof Error ? retryErr.message : String(retryErr))
          }
        }
        const circuitUntil = openResourceExhaustedCircuit(sk, serverRetryMs)
        releaseAgent(sk, agentEntry)
        agentEntry = undefined
        g.stopReason = "error"
        g.errorMessage = resourceExhaustedPauseMessage(
          (sdkErr as any)?.message || (error as any)?.message || "capacity unavailable",
          circuitUntil,
          sk,
        )
        st.push({ type: "error", reason: "error", error: g })
        st.end()
        return
      }

      if (sdkErr instanceof AuthenticationError ||
          (error as any)?.code === 16) {
        const failedAgent = activeAgents.get(sk)
        const savedIdForRetry = failedAgent?.agentId ?? loadAgentState(cwd).agents[sk]
        releaseAgent(sk, failedAgent)
        agentEntry = undefined
        const recovery = await recoverFromAuthError({
          savedId: savedIdForRetry,
          initialError: (sdkErr as any)?.message || (error as any)?.message,
          text: sendText, images, modelSel, deltaState, st, localAbort, abortRej,
          resolveApiKey: () => o?.apiKey || getApiKey(sessionId),
          cwd, sessionId, sk,
        })
        if (recovery.ok) return
        agentEntry = recovery.agentEntry
        releaseAgent(sk, agentEntry)
        agentEntry = undefined
        if (localAbort.signal.aborted) {
          g.stopReason = "aborted"
          g.errorMessage = "aborted"
          st.push({ type: "error", reason: "aborted", error: g })
          st.end()
          return
        }
        g.stopReason = "error"
        const lastAuthErr = recovery.lastError || "session expired"
        g.errorMessage = lastAuthErr.startsWith("Cursor") ? lastAuthErr : `Cursor auth error: ${lastAuthErr}`
        st.push({ type: "error", reason: "error", error: g })
        st.end()
        return
      }

      if (!localAbort.signal.aborted &&
          (error as any)?.code === 13 &&
          /ENHANCE_YOUR_CALM/i.test((error as any)?.message ?? "")) {
        const calmFailedAgent = activeAgents.get(sk)
        const calmSavedId = calmFailedAgent?.agentId ?? loadAgentState(cwd).agents[sk]
        releaseAgent(sk, calmFailedAgent)
        calmRetries++
        const backoffMs = Math.min(2000 * Math.pow(2, calmRetries - 1), 8000)
        if (calmRetries <= 3) {
          try {
            piLog("warn", `Rate limited (ENHANCE_YOUR_CALM), retrying in ${backoffMs / 1000}s...`)
            await new Promise<void>(resolve => setTimeout(resolve, backoffMs))
            if (localAbort.signal.aborted) throw new Error("aborted")
            let retryAgent: any = null
            if (calmSavedId && !stuckAgentIds.has(calmSavedId)) {
              try {
                retryAgent = await sdkAgent.resume(calmSavedId, { apiKey, local: { cwd, settingSources: ["project"], enableAgentRetries: SDK_ENABLE_AGENT_RETRIES } })
                agentEntry = makeAgentEntry(retryAgent, calmSavedId, cwd, sessionId)
              } catch { retryAgent = null }
            }
            if (!retryAgent) {
              retryAgent = await sdkAgent.create({ apiKey, model: modelSel, local: { cwd, settingSources: ["project"], enableAgentRetries: SDK_ENABLE_AGENT_RETRIES } })
              agentEntry = makeAgentEntry(retryAgent, retryAgent.agentId, cwd, sessionId)
            }
            activeAgents.set(sk, agentEntry)
            await retrySendWithAgent(retryAgent, { text: sendText, images, modelSel, deltaState, st, localAbort, abortRej, apiKey, cwd, sessionId, sk })
            return
          } catch (retryErr: any) {
            piLog("warn", "ENHANCE_YOUR_CALM retry failed:",
              retryErr instanceof Error ? retryErr.message : String(retryErr))
          }
        }
        g.stopReason = "error"
        g.errorMessage = `Cursor rate limited (ENHANCE_YOUR_CALM): ${(error as any).message}. Wait a few seconds and retry.`
        releaseAgent(sk, agentEntry)
        st.push({ type: "error", reason: "error", error: g })
        st.end()
        return
      }

      if (sdkErr instanceof RateLimitError && (sdkErr as any).isRetryable !== false) {
        g.stopReason = "error"
        g.errorMessage = `Cursor rate limited: ${(sdkErr as any).message}`
        releaseAgent(sk, agentEntry)
        st.push({ type: "error", reason: "error", error: g })
        st.end()
        return
      }

      if (sdkErr instanceof AgentBusyError) {
        if (!forceRetryAttempted && agentEntry) {
          forceRetryAttempted = true
          try {
            piLog("warn", "Agent busy, retrying with force...")
            await retrySendWithAgent(agentEntry.agent, { text: sendText, images, modelSel, deltaState, st, localAbort, abortRej, force: true, apiKey, cwd, sessionId, sk })
            return
          } catch (retryErr: any) {
            piLog("warn", "Force retry after busy failed:",
              retryErr instanceof Error ? retryErr.message : String(retryErr))
          }
        }
        g.stopReason = "error"
        g.errorMessage = `Cursor agent busy: ${(sdkErr as any).message}. Wait and retry.`
        releaseAgent(sk, agentEntry)
        st.push({ type: "error", reason: "error", error: g })
        st.end()
        return
      }

      if (hangTriggered && !forceRetryAttempted && agentEntry) {
        forceRetryAttempted = true
        try {
          piLog("warn", "Hang detected, retrying send with force...")
          const recoveryAbort = createRecoveryAbort(o, runToken, sessionId)
          deltaState.localAbort = recoveryAbort
          await retrySendWithAgent(agentEntry.agent, {
            text: sendText, images, modelSel, deltaState, st,
            localAbort: recoveryAbort, abortRej: makeAbortRej(recoveryAbort), force: true,
            apiKey, cwd, sessionId, sk,
          })
          return
        } catch (retryErr: any) {
          piLog("warn", "Force retry after hang failed:",
            retryErr instanceof Error ? retryErr.message : String(retryErr))
          localAbort = createRecoveryAbort(o, runToken, sessionId)
          abortRej = makeAbortRej(localAbort)
          deltaState.localAbort = localAbort
        }
      }

      if (!localAbort.signal.aborted && agentEntry && !m1RetryAttempted) {
        const isTransient = sdkErr instanceof CursorAgentError ||
          /connect|stream closed|network|timeout|ECONN|ETIMEDOUT/i.test(
            sdkErr instanceof Error ? sdkErr.message : String(sdkErr))
        if (isTransient) {
          m1RetryAttempted = true
          const m1AgentToRelease = activeAgents.get(sk)
          const m1SavedId = m1AgentToRelease?.agentId ?? loadAgentState(cwd).agents[sk]
          releaseAgent(sk, m1AgentToRelease)
          try {
            piLog("warn", "Transient error, retrying...")
            let m1Agent: any = null
            if (m1SavedId && !stuckAgentIds.has(m1SavedId)) {
              try {
                m1Agent = await sdkAgent.resume(m1SavedId, { apiKey, local: { cwd, settingSources: ["project"], enableAgentRetries: SDK_ENABLE_AGENT_RETRIES } })
                agentEntry = makeAgentEntry(m1Agent, m1SavedId, cwd, sessionId)
              } catch { m1Agent = null }
            }
            if (!m1Agent) {
              m1Agent = await sdkAgent.create({ apiKey, model: modelSel, local: { cwd, settingSources: ["project"], enableAgentRetries: SDK_ENABLE_AGENT_RETRIES } })
              agentEntry = makeAgentEntry(m1Agent, m1Agent.agentId, cwd, sessionId)
            }
            activeAgents.set(sk, agentEntry)
            await retrySendWithAgent(m1Agent, { text: sendText, images, modelSel, deltaState, st, localAbort, abortRej, apiKey, cwd, sessionId, sk })
            return
          } catch (retryErr: any) {
            piLog("warn", "Transient error retry failed:",
              retryErr instanceof Error ? retryErr.message : String(retryErr))
          }
        }
      }

      g.stopReason = localAbort.signal.aborted ? "aborted" : "error"
      g.errorMessage = sdkErr instanceof Error ? sdkErr.message : String(sdkErr)
      const isPureUserAbort = localAbort.signal.aborted && agentEntry && !stuckAgentIds.has(agentEntry.agentId)
      if (agentEntry && !isPureUserAbort) {
        if (localAbort.signal.aborted) {
          piLog("warn", "Discarding hung agent:", agentEntry.agentId.slice(0, 16))
        }
        evictAgent(sk, cwd, agentEntry)
      }
      st.push({ type: "error", reason: g.stopReason, error: g })
      st.end()
    } finally {
      clearTimeout(hangTimer)
      unregisterRunAbort(runToken)
    }
    }))
  })().catch((err) => {
    piLog("warn", "Unhandled stream error:", err instanceof Error ? err.message : String(err))
    try {
      const eg: any = { role: "assistant", content: [], stopReason: "error", errorMessage: "unhandled: " + (err instanceof Error ? err.message : String(err)), usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }, timestamp: Date.now() }
      st.push({ type: "error", reason: "error", error: eg })
      st.end()
    } catch {}
  })
  return st
}
