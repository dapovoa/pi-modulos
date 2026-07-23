import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const c0 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const t = ["text"] as ("text"|"image")[]
const ti = ["text", "image"] as ("text"|"image")[]

const qc = { supportsDeveloperRole: false, maxTokensField: "max_tokens" as const, thinkingFormat: "qwen" as const }
const qcv = { supportsDeveloperRole: false, maxTokensField: "max_tokens" as const, thinkingFormat: "qwen" as const }
const nc = { supportsDeveloperRole: false, maxTokensField: "max_tokens" as const }

// prettier-ignore
const MODELS = [
  { id: "qwen3.7-max",        name: "Pi-Qwen 3.7 Max",         reasoning: true,  input: ti, cost: c0, contextWindow: 1000000, maxTokens: 65536, compat: qc },
  { id: "qwen3.6-max-preview",name: "Pi-Qwen 3.6 Max Preview",  reasoning: true,  input: ti, cost: c0, contextWindow: 1000000, maxTokens: 65536, compat: qc },
  { id: "qwen3.6-plus",       name: "Pi-Qwen 3.6 Plus",         reasoning: true,  input: t,  cost: c0, contextWindow: 1000000, maxTokens: 65536, compat: qc },
  { id: "qwen3.6-flash",      name: "Pi-Qwen 3.6 Flash",        reasoning: false, input: t,  cost: c0, contextWindow: 1000000, maxTokens: 65536, compat: nc },
  { id: "qwen3-coder-plus",   name: "Pi-Qwen Coder Plus",       reasoning: false, input: ti, cost: c0, contextWindow: 1000000, maxTokens: 65536, compat: nc },
  { id: "qwen3-coder-flash",  name: "Pi-Qwen Coder Flash",      reasoning: false, input: ti, cost: c0, contextWindow: 1000000, maxTokens: 65536, compat: nc },
  { id: "qwen3-max",           name: "Pi-Qwen 3 Max",             reasoning: true,  input: ti, cost: c0, contextWindow: 1000000, maxTokens: 65536, compat: qc },
  { id: "qwq-plus",           name: "Pi-QWQ Plus",              reasoning: false, input: ti, cost: c0, contextWindow: 1000000, maxTokens: 65536, compat: nc },
  { id: "deepseek-v4-pro",    name: "DeepSeek V4 Pro",          reasoning: true,  input: ti, cost: c0, contextWindow: 1000000, maxTokens: 65536, compat: qc },
  { id: "deepseek-v4-flash",  name: "DeepSeek V4 Flash",        reasoning: true,  input: ti, cost: c0, contextWindow: 1000000, maxTokens: 65536, compat: qc },
  { id: "deepseek-v3.2",      name: "DeepSeek V3.2",            reasoning: true,  input: ti, cost: c0, contextWindow: 131072,  maxTokens: 65536, compat: qc },
  { id: "glm-5.1",            name: "GLM-5.1",                  reasoning: true,  input: ti, cost: c0, contextWindow: 200000,  maxTokens: 65536, compat: qc },
  { id: "MiniMax-M2.5",       name: "MiniMax M2.5",             reasoning: true,  input: t,  cost: c0, contextWindow: 200000,  maxTokens: 8192,  compat: nc },
]

export default function (pi: ExtensionAPI) {
  pi.registerProvider("pi-qwencloud", {
    name: "Pi-Qwen (direct)",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKey: "sk-pi-qwencloud",
    api: "openai-completions",
    authHeader: true,
    models: MODELS,
  })
}
