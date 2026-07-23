import { type Api, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const API = "https://api.kimi.com/coding/v1"
const isR = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const S = (v: unknown): string | undefined => typeof v === "string" ? v : undefined
const N = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined

function rEffort(r?: string): string | undefined {
  if (!r) return
  const m: Record<string, string> = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" }
  return m[r]
}

function convertUserContent(c: unknown): unknown {
  if (typeof c === "string" || !Array.isArray(c)) return c
  return c.map((b: unknown) => {
    if (!isR(b)) return b
    if (b.type === "image" && S((b as any).data)) {
      const img = b as Record<string, unknown>
      return { type: "image_url", image_url: { url: `data:${S(img.mimeType) ?? "image/png"};base64,${S(img.data)}` } }
    }
    return b
  })
}

function convertMsgs(messages: readonly { role: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; stopReason?: string; errorMessage?: string }[]): unknown[] {
  const result: unknown[] = []
  for (const m of messages) {
    if (m.role === "system") {
      result.push({ role: "system", content: m.content })
    } else if (m.role === "user") {
      result.push({ role: "user", content: convertUserContent(m.content) })
    } else if (m.role === "assistant") {
      if (m.stopReason === "error" || m.stopReason === "aborted") continue
      const textParts: string[] = []
      const thinkingParts: string[] = []
      const tools: unknown[] = []
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (!isR(c)) continue
        if (c.type === "text" && S(c.text)) textParts.push(c.text as string)
        else if (c.type === "thinking" && S(c.thinking)) thinkingParts.push(c.thinking as string)
        else if (c.type === "toolCall" && S(c.id)) {
          tools.push({ id: c.id, type: "function", function: { name: S(c.name) ?? "", arguments: JSON.stringify(c.arguments ?? {}) } })
        }
      }
      const msg: any = { role: "assistant" }
      if (tools.length) {
        msg.reasoning_content = thinkingParts.join("\n") || ""
        msg.tool_calls = tools
        msg.content = textParts.join("\n") || null
      } else {
        msg.content = ([...thinkingParts, ...textParts]).join("\n") || null
      }
      if (msg.content != null || msg.tool_calls) result.push(msg)
    } else if (m.role === "toolResult" && m.toolCallId) {
      const text = (Array.isArray(m.content) ? m.content : []).filter(p => isR(p) && p.type === "text").map(p => S((p as any).text) ?? "").join("\n")
      result.push({ role: "tool", content: text || "(no result)", tool_call_id: m.toolCallId })
    }
  }
  return result
}

function convTools(t?: readonly { name: string; description?: string; parameters?: unknown }[]): unknown[] {
  return !t ? [] : t.map(x => ({ type: "function", function: { name: x.name, description: x.description, parameters: isR(x.parameters) ? x.parameters : {} } }))
}

function sKimi(m: Model<Api>, ctx: Context, o?: SimpleStreamOptions): AssistantMessageEventStream {
  const st = createAssistantMessageEventStream()
  ;(async () => {
    const g: AssistantMessage = {
      role: "assistant",
      content: [],
      api: m.api,
      provider: m.provider,
      model: m.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    }
    try {
      const k = o?.apiKey
      if (!k) {
        g.stopReason = "error"
        g.errorMessage = "No API key. Use /login."
        st.push({ type: "error", reason: "error", error: g })
        st.end()
        return
      }
      const ctl = new AbortController()
      const ab = () => { if (!ctl.signal.aborted) ctl.abort() }
      o?.signal?.aborted ? ab() : o?.signal?.addEventListener("abort", ab, { once: true })

      const re =
        rEffort(o?.reasoning) ||
        ((typeof o?.reasoning === "string" && o.reasoning !== "off") ? "low" : undefined)
      const body: Record<string, unknown> = {
        model: m.id,
        messages: convertMsgs(ctx.messages ?? []),
        tools: convTools(ctx.tools),
        max_tokens: Math.min(o?.maxTokens ?? m.maxTokens, 65536),
        stream: true,
        stream_options: { include_usage: true },
      }
      body.temperature = o?.temperature ?? 0.3
      if (o?.sessionId) body.prompt_cache_key = o.sessionId
      if (re) { body.reasoning_effort = re; body.extra_body = { thinking: { type: "enabled" } } }

      const r = await fetch(`${API}/chat/completions`, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}`, "User-Agent": "KimiCLI/1.5" },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text().catch(() => "")).slice(0, 500)}`)

      st.push({ type: "start", partial: g })
      const rd = r.body?.getReader()
      if (!rd) throw new Error("No body")

      let B = ""
      let tb: { type: "text"; text: string } | undefined
      let xi = -1
      let ti = -1
      let tBuf = ""
      let thinking = false
      let fin = false
      const tAcc = new Map<number, { id: string; name: string; args: string }>()

      const endText = () => {
        if (!tb) return
        st.push({ type: "text_end", contentIndex: xi, content: tb.text, partial: g })
        tb = undefined; xi = -1
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

      const ensureText = () => {
        if (thinking) closeThinking()
        if (!tb) {
          tb = { type: "text", text: "" }
          g.content.push(tb)
          xi = g.content.length - 1
          st.push({ type: "text_start", contentIndex: xi, partial: g })
        }
      }

      const flushToolCalls = () => {
        if (tAcc.size === 0) return
        for (const [_, tc] of tAcc) {
          if (!tc.id || !tc.name) continue
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(tc.args || "{}") } catch {}
          const tci = { type: "toolCall" as const, id: tc.id, name: tc.name, arguments: args }
          g.content.push(tci)
          const i = g.content.length - 1
          st.push({ type: "toolcall_start", contentIndex: i, partial: g })
          st.push({ type: "toolcall_end", contentIndex: i, toolCall: tci, partial: g })
        }
        tAcc.clear()
      }

      for (;;) {
        if (ctl.signal.aborted) throw new DOMException("Aborted", "AbortError")
        const { done, value } = await rd.read()
        if (done) { if (B.trim()) { try { const p = JSON.parse(B); if (isR(p)) he(p) } catch { /* skip */ } } break }
        B += new TextDecoder().decode(value, { stream: true })
        const ls = B.split("\n"); B = ls.pop() ?? ""
        for (const l of ls) {
          if (!l.trim() || l.trim().startsWith(":")) continue
          let t = l.trim()
          if (t.startsWith("data:")) t = t.slice(5).trim()
          if (!t || t === "[DONE]") continue
          try { const p = JSON.parse(t); if (!isR(p)) continue; he(p) } catch { /* skip */ }
        }
        if (fin) break
      }

      endText(); closeThinking(); flushToolCalls()
      st.push({ type: "done", reason: g.stopReason as "stop" | "length" | "toolUse", message: g })
      st.end()

      function he(e: Record<string, unknown>) {
        if (isR(e.usage)) {
          g.usage.input = N(e.usage.prompt_tokens) ?? 0
          g.usage.output = N(e.usage.completion_tokens) ?? 0
          g.usage.totalTokens = g.usage.input + g.usage.output
          calculateCost(m, g.usage)
        }

        if (isR(e.choices?.[0])) {
          const ch = e.choices[0] as Record<string, unknown>
          if (ch.finish_reason) {
            g.stopReason =
              S(ch.finish_reason) === "tool_calls"
                ? "toolUse"
                : S(ch.finish_reason) === "length"
                  ? "length"
                  : "stop"
            fin = true
          }
          const d = isR(ch.delta) ? ch.delta as Record<string, unknown> : undefined
          if (!d) return

          const rc = S(d.reasoning_content)
          if (rc) {
            if (!thinking) {
              endText()
              openThinking()
            }
            tBuf += rc
            st.push({ type: "thinking_delta" as any, contentIndex: ti, delta: rc, partial: g })
            return
          }

          if (S(d.content)) {
            if (thinking) closeThinking()
            ensureText()
            tb.text += d.content
            st.push({ type: "text_delta", contentIndex: xi, delta: S(d.content) ?? "", partial: g })
            return
          }

          if (Array.isArray(d.tool_calls)) {
            if (thinking) closeThinking()
            endText()
            for (const tc of d.tool_calls as Record<string, unknown>[]) {
              if (!isR(tc)) continue
              const idx = N(tc.index) ?? 0
              let entry = tAcc.get(idx)
              if (!entry) { entry = { id: "", name: "", args: "" }; tAcc.set(idx, entry) }
              if (S(tc.id)) entry.id = S(tc.id)!
              const fn = isR(tc.function) ? tc.function as Record<string, unknown> : undefined
              if (fn) {
                if (S(fn.name)) entry.name = S(fn.name)!
                if (S(fn.arguments)) entry.args += S(fn.arguments)!
              }
            }
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

export default async function (pi: ExtensionAPI) {
  pi.registerProvider("pi-kimi", {
    name: "Pi-Kimi (Direct)",
    baseUrl: API,
    authHeader: true,
    headers: { "User-Agent": "KimiCLI/1.5" },
    api: "pi-kimi-custom" as Api,
    streamSimple: sKimi,
    apiKey: "sk-pi-kimi",
    models: [
      {
        id: "kimi-k2.6",
        name: "Pi-Kimi",
        reasoning: true,
        input: ["text", "image"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 65536,
      },
    ],
  })
}
