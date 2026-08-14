import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const here = fileURLToPath(new URL(".", import.meta.url))
const sdkEntry = process.env.PI_CURSOR_SDK_ENTRY || join(
  here,
  "node_modules",
  "@cursor",
  "sdk",
  "dist",
  "esm",
  "index.js",
)
if (!existsSync(sdkEntry)) {
  process.send?.({ op: "fatal", error: "SDK not found: " + sdkEntry })
  process.exit(1)
}

const { Agent } = await import("file://" + sdkEntry)
const agents = new Map()
const runs = new Map()

function errPayload(e) {
  return {
    name: e?.name || "Error",
    message: e?.message || String(e),
    code: e?.code,
  }
}

async function handle(msg) {
  const { id, op, payload } = msg
  try {
    if (op === "ping") {
      process.send({ id, ok: true })
      return
    }
    if (op === "create") {
      const agent = await Agent.create(payload)
      agents.set(agent.agentId, agent)
      process.send({ id, ok: true, agentId: agent.agentId })
      return
    }
    if (op === "resume") {
      const agent = await Agent.resume(payload.agentId, payload.opts)
      agents.set(agent.agentId, agent)
      process.send({ id, ok: true, agentId: agent.agentId })
      return
    }
    if (op === "close") {
      const agent = agents.get(payload.agentId)
      try {
        agent?.close()
      } catch {}
      agents.delete(payload.agentId)
      process.send({ id, ok: true })
      return
    }
    if (op === "listRuns") {
      const result = await Agent.listRuns(payload.agentId, payload.opts)
      process.send({ id, ok: true, result })
      return
    }
    if (op === "messagesList") {
      const result = await Agent.messages.list(payload.agentId, payload.opts)
      process.send({ id, ok: true, result })
      return
    }
    if (op === "send") {
      const agent = agents.get(payload.agentId)
      if (!agent) {
        process.send({
          id,
          ok: false,
          error: { name: "Error", message: "agent not in sdk-host" },
        })
        return
      }
      const body = payload.images?.length
        ? { text: payload.text, images: payload.images }
        : payload.text
      const opts = {
        model: payload.model,
        streamingBehavior: payload.streamingBehavior,
        onDelta: ({ update }) => {
          process.send({ id, kind: "delta", update })
        },
      }
      if (payload.force) {
        opts.local = { force: true }
      }
      const run = await agent.send(body, opts)
      runs.set(id, run)
      try {
        for await (const ev of run.stream()) {
          process.send({ id, kind: "stream", msg: ev })
        }
        const result = await run.wait()
        process.send({ id, ok: true, result })
      } finally {
        runs.delete(id)
      }
      return
    }
    if (op === "cancel") {
      const run = runs.get(payload.runId)
      try {
        await run?.cancel?.()
      } catch {}
      process.send({ id, ok: true })
      return
    }
    process.send({
      id,
      ok: false,
      error: { name: "Error", message: "unknown op " + op },
    })
  } catch (e) {
    process.send({ id, ok: false, error: errPayload(e) })
  }
}

process.on("message", (msg) => {
  handle(msg).catch((e) => {
    process.send?.({
      id: msg?.id,
      ok: false,
      error: errPayload(e),
    })
  })
})
