import { Agent, AuthenticationError } from "PI_MODULES_ROOT/.pi/agent/extensions/pi-cursor/node_modules/@cursor/sdk/dist/esm/index.js"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const auth = JSON.parse(readFileSync("PI_MODULES_ROOT/.pi/agent/auth.json", "utf-8"))
const apiKey = auth["pi-cursor"].key
console.log("key:", apiKey.slice(0, 8) + "..." + apiKey.slice(-4), `(len ${apiKey.length})`)
console.log("SDK version:", process.env.npm_package_version || "?")
console.log("CURSOR_BACKEND_URL:", process.env.CURSOR_BACKEND_URL || "(unset)")

const CWD = "PI_MODULES_ROOT/dinaferreira/agenda"

const t0 = Date.now()
try {
  console.log("--- Agent.create ---")
  const agent = await Agent.create({
    apiKey,
    model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
    local: { cwd: CWD, settingSources: ["project"], enableAgentRetries: false },
  })
  console.log("created agent:", agent.agentId, `(${Date.now() - t0}ms)`)

  const t1 = Date.now()
  console.log("--- agent.send('olá, responde só OK.') ---")
  const run = await agent.send("olá, responde só OK.", {
    model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
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
