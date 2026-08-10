import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const candidates = [
  process.env.PI_CODING_AGENT_DIR ? join(process.env.PI_CODING_AGENT_DIR, "auth.json") : undefined,
  process.env.PI_CURSOR_AUTH_FILE,
  join(process.cwd(), ".pi", "agent", "auth.json"),
  join(homedir(), ".pi", "agent", "auth.json"),
].filter((p) => !!p)

let key
for (const p of candidates) {
  try {
    if (existsSync(p)) {
      const auth = JSON.parse(readFileSync(p, "utf-8"))
      const entry = auth["pi-cursor"]
      if (entry?.key) { key = entry.key; console.log("key from:", p); break }
    }
  } catch {}
}

if (!key) {
  console.error("NO API KEY FOUND (set PI_CURSOR_AUTH_FILE or PI_CODING_AGENT_DIR)")
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
  const text = await res.text()
  const hasToken = /"accessToken"/.test(text)
  console.log("body contains accessToken:", hasToken, "(not printed — sensitive)")
} catch (e) {
  console.log(`FAILED after ${Date.now() - t0}ms:`, e?.message || String(e))
}
