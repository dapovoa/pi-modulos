import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const candidates = [
  join(process.env.PI_CODING_AGENT_DIR || "", "auth.json"),
  join(process.cwd(), ".pi", "agent", "auth.json"),
  join(homedir(), ".pi", "agent", "auth.json"),
]

let key
for (const p of candidates) {
  try {
    if (p && existsSync(p)) {
      const auth = JSON.parse(readFileSync(p, "utf-8"))
      const entry = auth["pi-cursor"]
      if (entry?.key) { key = entry.key; console.log("key from:", p); break }
    }
  } catch {}
}

function existsSync(p) { try { readFileSync(p); return true } catch { return false } }

if (!key) {
  console.error("NO API KEY FOUND")
  process.exit(1)
}
console.log("key:", key.slice(0, 8) + "..." + key.slice(-4), `(len ${key.length})`)

const BASE = process.env.CURSOR_BASE_URL || "https://api.cursor.com"
console.log("baseUrl:", BASE)
console.log("--- exchange: POST /auth/exchange_user_api_key ---")
const t0 = Date.now()
try {
  const res = await fetch(`${BASE}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(30000),
  })
  const ms = Date.now() - t0
  console.log(`HTTP ${res.status} in ${ms}ms`)
  console.log("headers:", JSON.stringify(Object.fromEntries(res.headers.entries())))
  const text = await res.text()
  console.log("body:", text.slice(0, 800))
} catch (e) {
  console.log(`FAILED after ${Date.now() - t0}ms:`, e?.message || String(e))
}
