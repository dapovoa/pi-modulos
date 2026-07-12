import { execSync } from "node:child_process"
import { writeFileSync, unlinkSync, readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, Model } from "@earendil-works/pi-coding-agent"

const PROMPT = `You are an expert at writing Git commits using Conventional Commits.
Analyze the changed files. Be realistic and precise.

Format:
\`\`\`
<type>(<scope>): <subject>

<body>
\`\`\`

Rules:
- Type: Use 'feat' if functionality or deps changed. Use 'refactor' ONLY if code changed with zero behavior change.
- Subject: Max 50 chars. Reflect the most impactful change.
- Body: Max 4 concise bullet points.
- Scope: Most affected module, or 'global' if app-wide.
- Language: English.

OUTPUT RULES (FAILURE = REJECTED):
1. Output ONLY the commit message in a code block.
2. NO text before or after the code block.
3. NO alternatives, NO options, NO variants.
4. One message only.

CHANGED FILES:
`

let step = 0
let diffStat = ""
let previousModel: Model | null = null

const CONFIG_PATH = resolve(process.env.PI_CODING_AGENT_DIR ?? "", "extensions/pi-commit/config.json")

function loadCommitModel(): string | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null
    const raw = readFileSync(CONFIG_PATH, "utf-8")
    const config = JSON.parse(raw)
    return config.model || null
  } catch { return null }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    if (step !== 1) return
    step = 2
    return { systemPrompt: (event.systemPrompt ?? "") + "\n" + PROMPT + diffStat }
  })

  pi.on("agent_end", async (event, ctx) => {
    if (step !== 2) return
    step = 0
    if (previousModel) {
      await pi.setModel(previousModel)
      previousModel = null
    }
    try {
      for (let i = event.messages.length - 1; i >= 0; i--) {
        if (event.messages[i].role !== "assistant") continue
        const msg = (event.messages[i].content as any[])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text).join("").trim()
          .replace(/[\s\S]*?\`\`\`(?:\w*\n?)?/, "")
          .replace(/\`\`\`[\s\S]*/, "")
          .replace(/^[\s\S]*?\n(?=[a-z]+\([^)]+\):\s)/, "")
          .trim()
        if (!msg) continue

        const stat = execSync("git diff --staged --stat", { cwd: ctx.cwd, encoding: "utf-8" }).trim()
        if (stat) ctx.ui.notify(stat)
        const ok = await ctx.ui.select("Apply commit?", ["Yes", "No"]) === "Yes"
        if (ok) {
          const tmp = `/tmp/pi-commit-${Date.now()}`
          writeFileSync(tmp, msg, "utf-8")
          execSync(`git commit -F "${tmp}"`, { cwd: ctx.cwd, encoding: "utf-8", stdio: "pipe" })
          unlinkSync(tmp)
          ctx.ui.notify("Committed!")
        } else {
          execSync("git reset HEAD", { cwd: ctx.cwd, encoding: "utf-8", stdio: "pipe" })
          ctx.ui.notify("Cancelled.")
        }
        return
      }
      ctx.ui.notify("No commit message found in response.")
    } catch (e: any) {
      ctx.ui.notify(`Commit error: ${String(e.stderr || e.message).slice(0, 120)}`)
    }
  })

  pi.registerCommand("commit", {
    description: "Generate Conventional Commit and apply",
    handler: async (args, ctx) => {
      const staged = (args ?? "").trim() === "--staged"
      try {
        ctx.modelRegistry.refresh()
        if (!staged) execSync("git add -A", { cwd: ctx.cwd, encoding: "utf-8", stdio: "pipe" })
        const out = execSync("git diff --staged", { cwd: ctx.cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }).trim()
        if (!out) {
          if (!staged) execSync("git reset HEAD", { cwd: ctx.cwd, encoding: "utf-8", stdio: "pipe" })
          ctx.ui.notify("No changes.")
          return
        }
        if (!ctx.isIdle()) {
          ctx.ui.notify("/commit: waiting for agent to finish...", "info")
          await ctx.waitForIdle()
        }
        const commitModelId = loadCommitModel()
        if (commitModelId) {
          let model = undefined
          const idx = commitModelId.indexOf("/")
          if (idx > 0) {
            const provider = commitModelId.slice(0, idx)
            const modelId = commitModelId.slice(idx + 1)
            model = ctx.modelRegistry.find(provider, modelId)
          }
          if (!model) {
            const lastIdx = commitModelId.lastIndexOf("/")
            if (lastIdx > 0 && lastIdx !== idx) {
              const provider = commitModelId.slice(0, lastIdx)
              const modelId = commitModelId.slice(lastIdx + 1)
              model = ctx.modelRegistry.find(provider, modelId)
            }
          }
          if (model) {
            previousModel = ctx.model
            const ok = await pi.setModel(model)
            if (!ok) ctx.ui.notify(`Commit model ${commitModelId} unavailable, using current.`, "warning")
          } else {
            ctx.ui.notify(`Commit model "${commitModelId}" not found, using current.`, "warning")
          }
        }
        step = 1
        diffStat = out
        pi.sendUserMessage("generate commit message for the changes")
      } catch (e: any) { ctx.ui.notify(e instanceof Error ? e.message.slice(0, 80) : "Not a git repo.") }
    },
  })
}
