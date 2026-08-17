import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Model } from "@earendil-works/pi-ai"

type SkillName =
  | "fix-clean"
  | "fix-format"
  | "maintain-wiki"
  | "audit-bug"
  | "fix-dedupe"
  | "audit-security"
  | "audit-perf"
  | "fix-dead"
  | "audit-deps"

let step = 0
let activeSkill: SkillName | null = null
let activeCommand: string | null = null
let previousModel: Model<any> | null | undefined = null

const AGENT_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "skills")
const CONFIG_PATH = join(AGENT_DIR, "extensions", "pi-tools", "config.json")

function loadSkillModel(skillName: string): string | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null
    const raw = readFileSync(CONFIG_PATH, "utf-8")
    const config = JSON.parse(raw)
    return config[skillName] || config.model || null
  } catch { return null }
}

function loadSkillPrompt(skillName: string): string {
  const p = join(SKILLS_DIR, skillName, "SKILL.md")
  if (!existsSync(p)) throw new Error(`Skill ${skillName} not found at ${p}`)
  const raw = readFileSync(p, "utf-8")
  const m = raw.match(/^---\n[\s\S]*?\n---\n\n?([\s\S]*)$/)
  return m ? m[1].trim() : raw.trim()
}

const COMMAND_NAMES: Record<string, SkillName> = {
  "pi-fix-clean": "fix-clean",
  "pi-fix-format": "fix-format",
  "pi-maintain-wiki": "maintain-wiki",
  "pi-audit-bug": "audit-bug",
  "pi-fix-dedupe": "fix-dedupe",
  "pi-audit-security": "audit-security",
  "pi-audit-perf": "audit-perf",
  "pi-fix-dead": "fix-dead",
  "pi-audit-deps": "audit-deps",
}

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  "pi-fix-clean": "Apaga comentários; guarda o essencial no wiki",
  "pi-fix-format": "Formata código em blocos; não muda lógica",
  "pi-maintain-wiki": "Alinha wiki com código; preserva histórico",
  "pi-audit-bug": "Bugs graves; corrige só com alta confiança",
  "pi-fix-dedupe": "Unifica código repetido",
  "pi-audit-security": "Auth, secrets, injection, erros na API",
  "pi-audit-perf": "SQL, latência, memória, bundle",
  "pi-fix-dead": "Remove código morto com prova",
  "pi-audit-deps": "CVEs npm; sugere bumps seguros",
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", () => {
    if (step !== 1) return
    step = 2
  })

  pi.on("agent_end", async (event, ctx) => {
    if (step !== 2) return
    step = 0
    if (previousModel) {
      await pi.setModel(previousModel)
      previousModel = null
    }
    const command = activeCommand
    activeCommand = null
    activeSkill = null
    if (!command) return
    let answer = ""
    for (let i = event.messages.length - 1; i >= 0; i--) {
      if (event.messages[i].role !== "assistant") continue
      const msg = event.messages[i] as any
      const text = (Array.isArray(msg.content) ? msg.content : [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text).join("").trim()
      if (text) { answer = text; break }
    }
    if (!answer) {
      ctx.ui.notify(`/${command}: no output from model.`)
      return
    }
    ctx.ui.notify(`/${command} done.`)
  })

  for (const [name, skillName] of Object.entries(COMMAND_NAMES)) {
    pi.registerCommand(name, {
      description: COMMAND_DESCRIPTIONS[name] ?? skillName,
      handler: async (args, ctx) => {
        try {
          if (!ctx.isIdle()) {
            ctx.ui.notify(`/${name}: waiting for agent to finish...`, "info")
            await ctx.waitForIdle()
          }
          const skillModelId = loadSkillModel(skillName)
          if (skillModelId) {
            const idx = skillModelId.indexOf("/")
            const provider = idx > 0 ? skillModelId.slice(0, idx) : undefined
            const modelId = idx > 0 ? skillModelId.slice(idx + 1) : skillModelId
            const model = provider ? ctx.modelRegistry.find(provider, modelId) : undefined
            if (model) {
              previousModel = ctx.model
              const ok = await pi.setModel(model)
              if (!ok) ctx.ui.notify(`${skillModelId} unavailable, using current.`, "warning")
            } else {
              ctx.ui.notify(`Model "${skillModelId}" not found, using current.`, "warning")
            }
          }
          const prompt = loadSkillPrompt(skillName)
          activeSkill = skillName
          activeCommand = name
          step = 1
          const userMsg = args && typeof args === "string" && args.trim()
            ? `Run the ${skillName} skill. ${args.trim()}`
            : `Run the ${skillName} skill.`
          pi.sendMessage({ customType: `pi-tools-${skillName}`, content: prompt, display: false })
          pi.sendUserMessage(userMsg)
        } catch (e: any) {
          ctx.ui.notify(`/${name}: ${e instanceof Error ? e.message : String(e)}`)
        }
      },
    })
  }
}
