import {
  type Api, type AssistantMessage, type AssistantMessageEventStream,
  type Context, type Model, type SimpleStreamOptions,
  calculateCost, createAssistantMessageEventStream,
} from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { execSync } from "node:child_process"

const API = "https://api.commandcode.ai"
const isR = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const S = (v: unknown): string | undefined => typeof v === "string" ? v : undefined
const N = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined

// ── Model metadata ──────────────────────────────────────────────
const noR = new Set(["gpt-5.4-mini"])
const visionPrefixes = ["anthropic/", "claude-", "gpt-", "google/gemini-"]
const visionExact = new Set(["moonshotai/Kimi-K2.6", "moonshotai/Kimi-K2.5"])

function hasVision(id: string): boolean {
  if (visionExact.has(id)) return true
  for (const p of visionPrefixes) if (id.startsWith(p)) return true
  return false
}

function mxT(id: string) {
  if (id.includes("haiku") || id.includes("Mini") || id.includes("Lite") || id.includes("Flash")) return 8192
  if (id.includes("opus") || id.includes("gpt-5.5")) return 32768
  return 16384
}

function ctxW(_id: string, c: number) {
  return c
}

interface M { id: string; name: string; context_length: number }

async function fetchM(): Promise<M[]> {
  const r = await fetch(`${API}/provider/v1/models`)
  if (!r.ok) throw new Error(`status ${r.status}`)
  const b: unknown = await r.json()
  if (isR(b) && Array.isArray(b.data)) return b.data.filter((m: unknown): m is M =>
    isR(m) && typeof m.id === "string" && typeof m.name === "string" && typeof m.context_length === "number")
  throw new Error("bad format")
}

// ── Git info (cached, computed once per extension load) ────────
function exec1(cmd: string): string {
  try { return execSync(cmd, { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim() } catch { return "" }
}
const cachedGit = (() => {
  const isGit = exec1("git rev-parse --is-inside-work-tree 2>/dev/null") === "true"
  if (!isGit) return { isGitRepo: false, currentBranch: "", mainBranch: "", gitStatus: "", recentCommits: [] as string[] }
  const branch = exec1("git branch --show-current")
  const main = exec1("git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null").replace("refs/remotes/origin/", "") || "main"
  const status = exec1("git status --porcelain").slice(0, 2000)
  const recentCommits = exec1('git log --format="%h %s (%aI)" -5').split("\n").filter(Boolean)
  return { isGitRepo: true, currentBranch: branch, mainBranch: main, gitStatus: status, recentCommits }
})()

// ── Message conversion (pi format → Command Code custom format) ──
function ccUserContent(c: unknown): unknown {
  if (typeof c === "string" || !Array.isArray(c)) return c
  return c.map((b: unknown) => {
    if (!isR(b)) return b
    if (b.type === "text") return { type: "text", text: S(b.text) ?? "" }
    if (b.type === "image") return { type: "image", source: { type: "base64", media_type: S((b as Record<string, unknown>).mimeType) ?? "image/png", data: S((b as Record<string, unknown>).data) ?? "" } }
    return b
  })
}

function ccMsgs(ms: readonly { role: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean }[]): unknown[] {
  const ci = new Set<string>(), ri = new Set<string>()
  for (const m of ms) {
    if (m.role === "assistant") for (const c of Array.isArray(m.content) ? m.content : []) { if (isR(c) && c.type === "toolCall" && S(c.id)) ci.add(S(c.id)!) }
    else if (m.role === "toolResult" && m.toolCallId) ri.add(m.toolCallId)
  }
  const paired = new Set([...ci].filter(id => ri.has(id)))
  const out: unknown[] = []
  let imgAcc: unknown[] = []

  for (const m of ms) {
    if (m.role === "user") {
      imgAcc = []
      out.push({ role: "user", content: ccUserContent(m.content) })
    } else if (m.role === "assistant") {
      const parts: unknown[] = []
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (!isR(c)) continue
        if (c.type === "text") parts.push({ type: "text", text: S(c.text) ?? "" })
        else if (c.type === "thinking") parts.push({ type: "reasoning", text: S(c.thinking) ?? "" })
        else if (c.type === "toolCall" && S(c.id) && paired.has(S(c.id)!))
          parts.push({ type: "tool-call", toolCallId: S(c.id)!, toolName: S(c.name) ?? "", input: c.arguments ?? {} })
      }
      if (parts.length) out.push({ role: "assistant", content: parts })
    } else if (m.role === "toolResult" && m.toolCallId && paired.has(m.toolCallId)) {
      const text = (Array.isArray(m.content) ? m.content : []).filter(p => isR(p) && p.type === "text").map(p => S((p as Record<string, unknown>).text) ?? "").join("\n")
      out.push({ role: "tool", content: [{ type: "tool-result", toolCallId: m.toolCallId, toolName: m.toolName, output: m.isError ? { type: "error-text", value: text } : { type: "text", value: text } }] })
      if (!m.isError && Array.isArray(m.content))
        for (const b of m.content) { if (isR(b) && b.type === "image" && S((b as Record<string, unknown>).data)) imgAcc.push({ type: "image", source: { type: "base64", media_type: S((b as Record<string, unknown>).mimeType) ?? "image/png", data: S((b as Record<string, unknown>).data) ?? "" } }) }
    }
  }
  if (imgAcc.length) out.push({ role: "user", content: [{ type: "text", text: "[tool results:]" }, ...imgAcc] })

  // Merge consecutive same-role messages
  const merged: unknown[] = []
  for (const m of out) {
    const last = merged[merged.length - 1] as any
    if (last && last.role === (m as any).role) {
      const lc = last.content, mc = (m as any).content
      if (typeof lc === "string" && typeof mc === "string") last.content = lc + "\n" + mc
      else if (Array.isArray(lc) && Array.isArray(mc)) last.content = [...lc, ...mc]
      else if (Array.isArray(lc) && typeof mc === "string") last.content = [...lc, { type: "text", text: mc }]
      else if (typeof lc === "string" && Array.isArray(mc)) last.content = [{ type: "text", text: lc }, ...mc]
    } else merged.push(m)
  }
  return merged.filter((m: any) => {
    const c = m?.content
    if (c == null) return false
    if (typeof c === "string") return c.trim().length > 0
    if (Array.isArray(c)) return c.some((b: any) => { if (!isR(b)) return true; if (b.type === "text" || b.type === "reasoning") return S(b.text)?.trim().length; return true })
    return true
  })
}

function convTools(t?: readonly { name: string; description?: string; parameters?: unknown }[]): unknown[] {
  return !t ? [] : t.map(x => ({ type: "function", name: x.name, description: x.description, input_schema: isR(x.parameters) ? x.parameters : {} as Record<string, unknown> }))
}

function rEffort(r?: string): string | undefined {
  if (!r) return
  const m: Record<string, string> = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" }
  return m[r]
}

// ── SSE parsing ────────────────────────────────────────────────
function parseEvent(l: string): Record<string, unknown> | undefined {
  let t = l.trim()
  if (!t || t.startsWith(":") || t.startsWith("event:")) return
  if (t.startsWith("data:")) t = t.slice(5).trim()
  if (!t || t === "[DONE]") return
  try { const p = JSON.parse(t); return isR(p) ? p : undefined } catch { return }
}

// ── Stream handler ──────────────────────────────────────────────
function streamCC(m: Model<Api>, ctx: Context, o?: SimpleStreamOptions): AssistantMessageEventStream {
  const st = createAssistantMessageEventStream()
  ;(async () => {
    const g: AssistantMessage = {
      role: "assistant", content: [], api: m.api, provider: m.provider, model: m.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    }
    try {
      const k = o?.apiKey
      if (!k) { g.stopReason = "error"; g.errorMessage = "No API key. Use /login."; st.push({ type: "error", reason: "error", error: g }); st.end(); return }

      const ctl = new AbortController()
      o?.signal?.addEventListener("abort", () => { if (!ctl.signal.aborted) ctl.abort() }, { once: true })
      if (o?.signal?.aborted) ctl.abort()

      const body: Record<string, unknown> = {
        model: m.id,
        messages: ccMsgs(ctx.messages ?? []),
        tools: convTools(ctx.tools),
        system: ctx.systemPrompt ?? "",
        max_tokens: Math.min(o?.maxTokens ?? m.maxTokens, 32768),
        stream: true,
      }
      if (o?.temperature != null) body.temperature = o.temperature
      const re = rEffort(o?.reasoning)
      if (re) body.reasoning_effort = re

      // Use pi's sessionId as threadId for API-level caching across the session
      const threadId = o?.sessionId ?? crypto.randomUUID()

      const r = await fetch(`${API}/alpha/generate`, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}`, "x-command-code-version": "0.24.1", "x-cli-environment": "production" },
        body: JSON.stringify({
          mode: "custom-agent",
          threadId,
          config: { workingDir: process.cwd(), date: new Date().toISOString().split("T")[0], environment: `${process.platform}-${process.arch}`, os: process.platform, shell: process.env.SHELL ?? "", user: process.env.USER ?? "", structure: [], ...cachedGit },
          memory: "",
          params: body,
        }),
      })
      if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text().catch(() => "")).slice(0, 500)}`)

      st.push({ type: "start", partial: g })
      const rd = r.body?.getReader()
      if (!rd) throw new Error("No body")

      let buf = ""
      let textBlock: { type: "text"; text: string } | undefined
      let ti = -1
      let tBuf = ""
      let thinking = false
      let fin = false

      const endText = () => {
        if (!textBlock) return
        st.push({ type: "text_end", contentIndex: ti, content: textBlock.text, partial: g })
        textBlock = undefined; ti = -1
      }
      const closeThinking = () => {
        if (!thinking) return
        st.push({ type: "thinking_end" as any, contentIndex: ti, content: tBuf, partial: g })
        ;(g.content[ti] as any).thinking = tBuf
        thinking = false; tBuf = ""
      }
      const openThinking = () => {
        if (thinking) return
        endText()
        g.content.push({ type: "thinking" as any, thinking: "" })
        ti = g.content.length - 1
        thinking = true
        st.push({ type: "thinking_start" as any, contentIndex: ti, partial: g })
      }
      const closeIfThinking = () => { if (thinking || tBuf) closeThinking() }

      for (;;) {
        if (ctl.signal.aborted) throw new DOMException("Aborted", "AbortError")
        const { done, value } = await rd.read()
        if (done) { if (buf.trim()) { const e = parseEvent(buf); if (e) handle(e) } break }
        buf += new TextDecoder().decode(value, { stream: true })
        const lines = buf.split("\n"); buf = lines.pop() ?? ""
        for (const l of lines) { const e = parseEvent(l); if (!e) continue; handle(e); if (fin) break }
        if (fin) break
      }

      endText(); closeThinking()
      st.push({ type: "done", reason: g.stopReason as "stop" | "length" | "toolUse", message: g })
      st.end()

      function handle(e: Record<string, unknown>) {
        switch (e.type) {
          case "reasoning-start":
            endText(); openThinking(); break
          case "reasoning-delta": {
            const d = S(e.text) ?? ""
            if (!thinking) { endText(); openThinking() }
            tBuf += d
            st.push({ type: "thinking_delta" as any, contentIndex: ti, delta: d, partial: g })
            break
          }
          case "reasoning-end":
            closeThinking(); break
          case "text-start":
            closeIfThinking()
            if (!textBlock) { textBlock = { type: "text", text: "" }; g.content.push(textBlock); ti = g.content.length - 1; st.push({ type: "text_start", contentIndex: ti, partial: g }) }
            break
          case "text-delta": {
            closeIfThinking()
            if (!textBlock) { textBlock = { type: "text", text: "" }; g.content.push(textBlock); ti = g.content.length - 1; st.push({ type: "text_start", contentIndex: ti, partial: g }) }
            const d = S(e.text) ?? ""; textBlock.text += d
            st.push({ type: "text_delta", contentIndex: ti, delta: d, partial: g })
            break
          }
          case "text-end":
            endText(); break
          case "tool-call":
            endText(); closeIfThinking()
            { const tc = { type: "toolCall", id: S(e.toolCallId) ?? "", name: S(e.toolName) ?? "", arguments: (isR(e.input) ? e.input : {}) as Record<string, unknown> }; g.content.push(tc); const i = g.content.length - 1; st.push({ type: "toolcall_start", contentIndex: i, partial: g }); st.push({ type: "toolcall_end", contentIndex: i, toolCall: tc, partial: g }) }
            break
          case "finish": {
            const u = isR(e.totalUsage) ? e.totalUsage : undefined
            if (u) {
              const dt = isR(u.inputTokenDetails) ? u.inputTokenDetails : undefined
              g.usage.input = N(u.inputTokens) ?? 0
              g.usage.output = N(u.outputTokens) ?? 0
              g.usage.cacheRead = N(dt?.cacheReadTokens) ?? 0
              g.usage.cacheWrite = N(dt?.cacheWriteTokens) ?? 0
              g.usage.totalTokens = g.usage.input + g.usage.output + g.usage.cacheRead + g.usage.cacheWrite
              calculateCost(m, g.usage)
            }
            g.stopReason = e.finishReason === "tool-calls" ? "toolUse" : typeof e.finishReason === "string" && (e.finishReason === "length" || e.finishReason.startsWith("max_")) ? "length" : "stop"
            fin = true
            break
          }
          case "error": {
            const er = isR(e.error) ? e.error : undefined
            throw new Error(S(er?.message) ?? S(e.error) ?? "Stream error")
          }
        }
      }
    } catch (e: unknown) {
      const ab = e instanceof DOMException && e.name === "AbortError"
      g.stopReason = ab ? "aborted" : "error"
      g.errorMessage = ab ? "Aborted" : e instanceof Error ? e.message : String(e)
      st.push({ type: "error", reason: g.stopReason as "error" | "aborted", error: g })
      st.end()
    }
  })()
  return st
}

// ── Extension entry ─────────────────────────────────────────────
export default async function (pi: ExtensionAPI) {
  const models = await fetchM()
  pi.registerProvider("pi-code", {
    name: "Pi-Code (Direct)",
    baseUrl: API,
    authHeader: true,
    api: "pi-code" as Api,
    streamSimple: streamCC,
    apiKey: "sk-pi-code",
    headers: { "x-command-code-version": "0.24.1", "x-cli-environment": "production" } as Record<string, string>,
    models: models.map(m => ({
      id: m.id,
      name: m.name,
      reasoning: !noR.has(m.id),
      input: (hasVision(m.id) ? ["text", "image"] : ["text"]) as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: ctxW(m.id, m.context_length),
      maxTokens: mxT(m.id),
    })),
  })
}
