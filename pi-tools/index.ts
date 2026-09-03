import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
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
  } catch {
    return null
  }
}

function loadSharedContract(): string {
  const p = join(SKILLS_DIR, "_shared", "CONTRACT.md")
  if (!existsSync(p)) return ""
  return readFileSync(p, "utf-8").trim()
}

function loadSkillPrompt(skillName: string): string {
  const p = join(SKILLS_DIR, skillName, "SKILL.md")
  if (!existsSync(p)) throw new Error(`Skill ${skillName} not found at ${p}`)
  const raw = readFileSync(p, "utf-8")
  const m = raw.match(/^---\n[\s\S]*?\n---\n\n?([\s\S]*)$/)
  const body = m ? m[1].trim() : raw.trim()
  const contract = loadSharedContract()
  if (!contract) return body
  return `${contract}\n\n---\n\n${body}`
}

function progressFileRel(skillName: string): string {
  return `.pi/memory/pages/pi-tools-progress-${skillName}.md`
}

function progressFilePath(cwd: string, skillName: string): string {
  return join(cwd, progressFileRel(skillName))
}

function parseSkillArgs(args: string | undefined): { resume: boolean; rest: string } {
  if (!args || typeof args !== "string") {
    return { resume: false, rest: "" }
  }
  const trimmed = args.trim()
  if (!trimmed) {
    return { resume: false, rest: "" }
  }
  const lower = trimmed.toLowerCase()
  if (lower === "resume") {
    return { resume: true, rest: "" }
  }
  if (lower.startsWith("resume ")) {
    return { resume: true, rest: trimmed.slice(7).trim() }
  }
  return { resume: false, rest: trimmed }
}

function resetProgressFile(cwd: string, skillName: string, command: string): void {
  const path = progressFilePath(cwd, skillName)
  mkdirSync(dirname(path), { recursive: true })
  const started = new Date().toISOString()
  const lines = [
    `# pi-tools run — ${skillName}`,
    "",
    `command: /${command}`,
    `started: ${started}`,
    "status: in_progress",
    "",
    "## Backlog",
    "",
    "Format: `status | id | notes`",
    "",
  ]
  writeFileSync(path, lines.join("\n"), "utf-8")
}

const COMMAND_NAMES: Record<string, SkillName> = {
  "pi-audit-bug": "audit-bug",
  "pi-audit-dependencies": "audit-deps",
  "pi-audit-performance": "audit-perf",
  "pi-audit-security": "audit-security",
  "pi-fix-dead-code": "fix-dead",
  "pi-fix-deduplicate": "fix-dedupe",
  "pi-fix-format": "fix-format",
  "pi-fix-remove-comments": "fix-clean",
  "pi-maintain-wiki": "maintain-wiki",
}

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  "pi-audit-bug": "Bugs graves; inventário + traces; corrige com prova",
  "pi-audit-dependencies": "Supply-chain: patches CVE auto; majors = migração",
  "pi-audit-performance": "Perf: inventário + traces; corrige bottlenecks",
  "pi-audit-security": "Segurança; fronteiras + cenário de exploit",
  "pi-fix-dead-code": "Remove código morto com prova",
  "pi-fix-deduplicate": "Unifica código repetido",
  "pi-fix-format": "Formata código em blocos; não muda lógica",
  "pi-fix-remove-comments": "Apaga comentários com precisão; why → wiki",
  "pi-maintain-wiki": "Alinha wiki com código; preserva histórico",
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
        .map((c: any) => c.text)
        .join("")
        .trim()
      if (text) {
        answer = text
        break
      }
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
          const { resume, rest } = parseSkillArgs(
            args && typeof args === "string" ? args : undefined,
          )
          const rel = progressFileRel(skillName)
          if (resume) {
            ctx.ui.notify(`/${name}: resume — keeping ${rel}`, "info")
          } else {
            resetProgressFile(ctx.cwd, skillName, name)
            ctx.ui.notify(`/${name}: reset ${rel}`, "info")
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
              if (!ok) {
                ctx.ui.notify(`${skillModelId} unavailable, using current.`, "warning")
              }
            } else {
              ctx.ui.notify(`Model "${skillModelId}" not found, using current.`, "warning")
            }
          }
          const prompt = loadSkillPrompt(skillName)
          activeSkill = skillName
          activeCommand = name
          step = 1
          const tail = rest ? ` ${rest}` : ""
          const userMsg = resume
            ? `Run the ${skillName} skill (resume — progress file was not reset).${tail}`
            : `Run the ${skillName} skill.${tail}`
          pi.sendMessage({ customType: `pi-tools-${skillName}`, content: prompt, display: false })
          pi.sendUserMessage(userMsg)
        } catch (e: any) {
          ctx.ui.notify(`/${name}: ${e instanceof Error ? e.message : String(e)}`)
        }
      },
    })
  }
}
