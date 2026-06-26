import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Pi-Xiaomi (Amsterdam) — Xiaomi MiMo Token Plan via Amsterdam endpoint.
 *
 * Overrides the built-in xiaomi-token-plan-ams with explicit prompt caching.
 *
 * Key improvements over the built-in:
 * 1. Registers as "pi-xiaomi" — distinguishable in the model selector
 * 2. Injects prompt_cache_key + prompt_cache_retention into every request
 *    via before_provider_request, enabling explicit server-side caching
 *    (built-in only sends this when PI_CACHE_RETENTION=long is set)
 *
 * Xiaomi Token Plan uses server-side automatic prefix caching
 * (documented as "Input (Cache Hit) Token" vs "Input (missed cache) Token").
 * Sending a consistent prompt_cache_key per session gives the server a
 * stable cache key to work with.
 *
 * Docs: https://platform.xiaomimimo.com/docs/en-US/price/tokenplan
 *       https://platform.xiaomimimo.com/docs/en-US/api/chat/openai-api
 */
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

  // Inject prompt cache key/retention into every provider request.
  // The built-in only does this when PI_CACHE_RETENTION=long is set.
  // We force it unconditionally so the Xiaomi server can cache the
  // conversation prefix across turns.
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
