import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const MODEL_DEFS = [
  {
    id: "mimo-v2.5-pro",
    name: "MiMo-V2.5-Pro",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    compat: {
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek" as const,
      supportsLongCacheRetention: true,
    },
  },
  {
    id: "mimo-v2.5",
    name: "MiMo-V2.5",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0.4, output: 2, cacheRead: 0.08, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    compat: {
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek" as const,
      supportsLongCacheRetention: true,
    },
  },
  {
    id: "mimo-v2-pro",
    name: "MiMo-V2-Pro",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    compat: {
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek" as const,
      supportsLongCacheRetention: true,
    },
  },
  {
    id: "mimo-v2-omni",
    name: "MiMo-V2-Omni",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0.4, output: 2, cacheRead: 0.08, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 131_072,
    compat: {
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek" as const,
      supportsLongCacheRetention: true,
    },
  },
  {
    id: "mimo-v2-flash",
    name: "MiMo-V2-Flash",
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.03, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 131_072,
  },
]

export default function (pi: ExtensionAPI) {
  pi.registerProvider("pi-xiaomi", {
    name: "Pi-Xiaomi (Amsterdam)",
    baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
    api: "openai-completions",
    apiKey: "$XIAOMI_API_KEY",
    models: MODEL_DEFS,
  })

  pi.on("before_provider_request", (event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId()
    if (!sessionId) return

    const payload = event.payload
    if (payload?.model?.startsWith("mimo-")) {
      return {
        ...payload,
        prompt_cache_key: sessionId.slice(0, 64),
        prompt_cache_retention: "24h",
      }
    }
  })
}
