import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const agentDir =
  process.env.PI_CODING_AGENT_DIR ||
  process.env.PI_CURSOR_AGENT_DIR ||
  undefined
const SDK_CANDIDATES = [
  process.env.PI_CURSOR_SDK_ENTRY,
  agentDir
    ? join(
        agentDir,
        "extensions",
        "pi-cursor",
        "node_modules",
        "@cursor",
        "sdk",
        "dist",
        "esm",
        "index.js",
      )
    : undefined,
  join(
    homedir(),
    ".pi",
    "agent",
    "extensions",
    "pi-cursor",
    "node_modules",
    "@cursor",
    "sdk",
    "dist",
    "esm",
    "index.js",
  ),
  join(process.cwd(), "node_modules", "@cursor", "sdk", "dist", "esm", "index.js"),
]
  .filter((p) => !!p)
  .filter((p) => existsSync(p))
if (!SDK_CANDIDATES.length) {
  console.error(
    "SDK not found (set PI_CURSOR_SDK_ENTRY or PI_CODING_AGENT_DIR, or run from the extension dir)",
  )
  process.exit(1)
}
const { Agent, AuthenticationError } = await import("file://" + SDK_CANDIDATES[0])

function findApiKey() {
  const candidates = [
    process.env.PI_CODING_AGENT_DIR ? join(process.env.PI_CODING_AGENT_DIR, "auth.json") : undefined,
    process.env.PI_CURSOR_AUTH_FILE,
    join(process.cwd(), ".pi", "agent", "auth.json"),
    join(homedir(), ".pi", "agent", "auth.json"),
  ].filter((p) => !!p)
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const auth = JSON.parse(readFileSync(p, "utf-8"))
        const entry = auth["pi-cursor"]
        if (entry?.key) return entry.key
      }
    } catch {}
  }
  return undefined
}

const apiKey = findApiKey()
if (!apiKey) {
  console.error("NO API KEY FOUND (set PI_CURSOR_AUTH_FILE or PI_CODING_AGENT_DIR)")
  process.exit(1)
}
console.log("key:", apiKey.slice(0, 8) + "..." + apiKey.slice(-4), `(len ${apiKey.length})`)
console.log("CURSOR_BACKEND_URL:", process.env.CURSOR_BACKEND_URL || "(unset)")

const CWD = process.env.PI_CURSOR_TEST_CWD || process.cwd()
const MODEL = { id: process.env.PI_CURSOR_TEST_MODEL || "composer-2.5", params: [{ id: "fast", value: "false" }] }

const t0 = Date.now()
try {
  console.log("--- Agent.create ---")
  const agent = await Agent.create({
    apiKey,
    model: MODEL,
    local: { cwd: CWD, settingSources: ["project"], enableAgentRetries: false },
  })
  console.log("created agent:", agent.agentId, `(${Date.now() - t0}ms)`)

  const t1 = Date.now()
  console.log("--- agent.send('olá, responde só OK.') ---")
  const run = await agent.send("olá, responde só OK.", {
    model: MODEL,
    streamingBehavior: "followUp",
  })
  let text = ""
  let toolCalls = 0
  let lastStatus
  try {
    for await (const ev of run.stream()) {
      if (ev.type === "text" && ev.text) text += ev.text
      if (ev.type === "toolUse") toolCalls++
      if (ev.type === "runEvent" && ev.payload?.type === "runEnded") lastStatus = ev.payload?.status
    }
  } catch (e) {
    console.log("STREAM ERROR:", e?.message || String(e))
  }
  const result = await run.wait()
  console.log("send finished:", JSON.stringify({ status: result?.status, error: result?.error?.message, durationMs: result?.durationMs }))
  console.log("stream text:", JSON.stringify(text.slice(0, 200)))
  console.log("toolCalls:", toolCalls, "lastStatus:", lastStatus)
  console.log(`TOTAL: ${Date.now() - t1}ms`)
} catch (e) {
  console.log("FAILED:", e?.constructor?.name, e?.message || String(e))
  console.log("code:", e?.code, "isRetryable:", e?.isRetryable, "requestId:", e?.requestId)
  console.log(`after ${Date.now() - t0}ms`)
  if (e instanceof AuthenticationError) console.log(">>> AuthenticationError as thrown")
}
