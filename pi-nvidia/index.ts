import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

interface ModelCfg { api: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; kwargs?: Record<string, unknown>; thinkingFormat?: string }

const MODELS: Record<string, ModelCfg> = {
  "nemotron-3-ultra": {
    api: "nvidia/nemotron-3-ultra-550b-a55b",
    name: "Nemotron-3-Ultra",
    contextWindow: 128000,
    maxTokens: 16384,
    reasoning: true,
  },
  "gemma-4-31b": {
    api: "google/gemma-4-31b-it",
    name: "Gemma-4-31B",
    contextWindow: 128000,
    maxTokens: 16384,
    reasoning: true,
  },
  "kimi-k2.6": {
    api: "moonshotai/kimi-k2.6",
    name: "Kimi-K2.6",
    contextWindow: 128000,
    maxTokens: 16384,
    reasoning: false,
  },
  "step-3.7-flash": {
    api: "stepfun-ai/step-3.7-flash",
    name: "Step-3.7-Flash",
    contextWindow: 128000,
    maxTokens: 16384,
    reasoning: false,
  },
  "glm-5.1": {
    api: "z-ai/glm-5.1",
    name: "GLM-5.1",
    contextWindow: 128000,
    maxTokens: 16384,
    reasoning: false,
  },
  "mistral-large-3": {
    api: "mistralai/mistral-large-3-675b-instruct-2512",
    name: "Mistral-Large-3",
    contextWindow: 128000,
    maxTokens: 2048,
    reasoning: false,
  },
  "minimax-m2.7": {
    api: "minimaxai/minimax-m2.7",
    name: "MiniMax-M2.7",
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: false,
  },
  "gpt-oss-120b": {
    api: "openai/gpt-oss-120b",
    name: "GPT-OSS-120B",
    contextWindow: 128000,
    maxTokens: 4096,
    reasoning: true,
  },
  "qwen3-coder": {
    api: "qwen/qwen3-coder-480b-a35b-instruct",
    name: "Qwen3-Coder",
    contextWindow: 128000,
    maxTokens: 4096,
    reasoning: false,
  },
  "deepseek-v4-flash": {
    api: "deepseek-ai/deepseek-v4-flash",
    name: "DeepSeek-V4-Flash",
    contextWindow: 128000,
    maxTokens: 16384,
    reasoning: true,
    kwargs: { thinking: true, reasoning_effort: "high" },
  },
}

export default function (pi: ExtensionAPI) {
  const c0 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

  pi.registerProvider("pi-nvidia", {
    name: "Pi-Nvidia (direct)",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: "sk-pi-nvidia",
    authHeader: true,
    api: "openai-completions",
    models: Object.entries(MODELS).map(([id, m]) => ({
      id,
      name: m.name,
      reasoning: m.reasoning,
      input: ["text"] as ("text" | "image")[],
      cost: c0,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      compat: {
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens" as const,
        ...(m.kwargs ? {} : m.reasoning ? { thinkingFormat: "qwen-chat-template" as const } : {}),
      },
    })),
  })

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "pi-nvidia") return
    const p = event.payload
    if (p?.model && MODELS[p.model]) {
      const m = MODELS[p.model]
      return { ...p, model: m.api, chat_template_kwargs: m.kwargs ?? p.chat_template_kwargs }
    }
  })
}
