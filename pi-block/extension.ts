import { writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const CUSTOM_TYPE = "pi-block-state"
let blocked = true

function writeStateFile(cwd: string) {
  try {
    const dir = join(cwd, ".pi")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "pi-block-state.json"), JSON.stringify({ blocked }), "utf-8")
  } catch {}
}

const SENSITIVE_PATHS = [
  /\.ssh\//,
  /\/\.env(\..*)?$/,
  /\.pem$/,
  /id_rsa/,
  /\/credentials(\.|$)/i,
  /\/secrets?(\.|$)/i,
  /\.npmrc$/,
  /\.git-credentials$/,
  /\/tokens?(\.|$)/i,
  /\/private[_-]?keys?(\/|\.)/i,
]

const DANGEROUS = [
  /\bgit\s+push\b/,
  /\bgit\s+commit\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+checkout\s+--\s+\./,
  /\bgit\s+restore\s+\./,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+stash\s+(?:drop|clear)\b/,
  /\brm\s+(?:-[a-zA-Z]*[rf]+[a-zA-Z]*\s+|-[rf]+\s).*/,
  /\brm\s+-rf?\b/,
  /\brm\s+-fr\b/,
  /\bsudo\b/,
  /\bchmod\s+.*777\b/,
  /\bchown\b/,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;:/,
  />\s*\/dev\/sd[a-z]/,
  /\bdd\s+if=/,
  /\bcurl\b.+\|\s*(?:ba)?sh\b/,
  /\bwget\b.+\|\s*(?:ba)?sh\b/,
  /\bmkfs\./,
  /\bfdisk\b/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
]

function persist(pi: ExtensionAPI, cwd?: string) {
  pi.appendEntry(CUSTOM_TYPE, { blocked })
  if (cwd) writeStateFile(cwd)
}

function restore(ctx: { sessionManager: { getEntries(): Iterable<{ type: string; customType?: string; data?: unknown }> } }) {
  let latest: { blocked: boolean } | undefined
  for (const e of ctx.sessionManager.getEntries()) {
    if (e.type === "custom" && e.customType === CUSTOM_TYPE && typeof (e.data as any)?.blocked === "boolean") {
      latest = e.data as { blocked: boolean }
    }
  }
  if (latest) blocked = latest.blocked
  else blocked = true
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    restore(ctx)
    writeStateFile(ctx.cwd)
  })

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" && event.toolName !== "read") return
    if (!blocked) return

    if (event.toolName === "read") {
      const path = (event.input as { path?: string }).path ?? ""
      const sensitive = SENSITIVE_PATHS.find((re) => re.test(path))
      if (!sensitive) return

      ctx.ui.notify(`Leitura sensível: ${path}`, "warning")
      const ok = await ctx.ui.confirm(
        "Ficheiro sensível",
        `O LLM vai ler "${path}". Permitir?\nNão cole keys ou tokens na resposta.`,
      )
      if (!ok) return { block: true, reason: "Leitura sensível bloqueada pelo pi-block" }
      return
    }

    const cmd = (event.input as { command?: string }).command ?? ""
    const trimmed = cmd.trim()

    const matched = DANGEROUS.find((re) => re.test(trimmed))
    if (!matched) return

    const short = trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed
    ctx.ui.notify(`Bloqueado: ${short}`, "warning")

    const ok = await ctx.ui.confirm("Comando perigoso bloqueado", `Permitir "${short}"?`)
    if (!ok) return { block: true, reason: "Bloqueado pelo pi-block" }
  })

  pi.registerCommand("unblock", {
    description: "Desbloquear comandos perigosos nesta sessão",
    handler: async (_args, ctx) => {
      blocked = false
      persist(pi, ctx.cwd)
      ctx.ui.notify("pi-block desativado. Comandos perigosos permitidos.", "info")
    },
  })

  pi.registerCommand("block", {
    description: "Reativar bloqueio de comandos perigosos",
    handler: async (_args, ctx) => {
      blocked = true
      persist(pi, ctx.cwd)
      ctx.ui.notify("pi-block ativado. Comandos perigosos bloqueados.", "info")
    },
  })
}
