import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getModels, streamSimpleMistral, type Model } from "@earendil-works/pi-ai"
import { Mistral } from "@mistralai/mistralai"
import type { BaseModelCard, FTModelCard } from "@mistralai/mistralai/models/components"
import { Type } from "typebox"
import { readFileSync, existsSync } from "node:fs"
import { extname, join } from "node:path"
import { homedir } from "node:os"
const CHAT_PROVIDER = "mistral"
const LEGACY_PROVIDER = "pi-mistral"
const OCR_MODEL = "mistral-ocr-latest"
const FIM_MODEL = "codestral-latest"

const SUPPORTED_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".bmp", ".tiff", ".tif",
])

const MIME_MAP: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".tiff": "image/tiff", ".tif": "image/tiff", ".pdf": "application/pdf",
}

const isUrl = (s: string) => /^https?:\/\//i.test(s)

type ModelRegistry = {
  getApiKeyForProvider(provider: string): Promise<string | undefined>
}

async function getApiKey(registry: ModelRegistry): Promise<string | undefined> {
  return (await registry.getApiKeyForProvider(CHAT_PROVIDER))
    ?? (await registry.getApiKeyForProvider(LEGACY_PROVIDER))
}

type ApiModel = BaseModelCard | FTModelCard
type ProviderModel = ReturnType<typeof toProviderModel>
type StaticMistralModel = Model<"mistral-conversations">

const STATIC_CATALOG = new Map(
  getModels("mistral").map((m) => [m.id, m as StaticMistralModel]),
)

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function loadApiKey(): string | undefined {
  const candidates = [
    process.env.PI_CODING_AGENT_DIR && join(process.env.PI_CODING_AGENT_DIR, "auth.json"),
    join(process.cwd(), ".pi", "agent", "auth.json"),
    join(homedir(), ".pi", "agent", "auth.json"),
  ].filter((p): p is string => !!p)
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue
      const auth = JSON.parse(readFileSync(p, "utf-8"))
      const key = auth[CHAT_PROVIDER]?.key ?? auth[LEGACY_PROVIDER]?.key
      if (key) return key
    } catch {}
  }
  return process.env.MISTRAL_API_KEY
}

function isActiveChatModel(m: ApiModel): boolean {
  if (m.deprecation) return false
  if ("archived" in m && m.archived) return false
  if (!m.capabilities.completionChat) return false
  return STATIC_CATALOG.has(m.id)
}

function toProviderModel(staticModel: StaticMistralModel | undefined, apiModel?: ApiModel) {
  const id = apiModel?.id ?? staticModel!.id
  const contextWindow = apiModel?.maxContextLength ?? staticModel!.contextWindow
  const reasoning = staticModel?.reasoning ?? apiModel?.capabilities.reasoning ?? false
  const input = staticModel?.input
    ?? (apiModel?.capabilities.vision ? ["text", "image"] as const : ["text"] as const)

  return {
    id,
    name: apiModel?.name ?? staticModel?.name ?? id,
    api: "mistral-conversations" as const,
    reasoning,
    input: [...input],
    cost: staticModel?.cost ?? ZERO_COST,
    contextWindow,
    maxTokens: staticModel?.maxTokens ?? Math.min(contextWindow, 16384),
    ...(staticModel?.thinkingLevelMap ? { thinkingLevelMap: staticModel.thinkingLevelMap } : {}),
    ...(staticModel?.compat ? { compat: staticModel.compat } : {}),
  }
}

function staticProviderModels(): ProviderModel[] {
  return [...STATIC_CATALOG.values()].map((m) => toProviderModel(m))
}

async function discoverProviderModels(apiKey: string): Promise<ProviderModel[]> {
  const client = createClient(apiKey)
  const result = await client.models.list()
  const seen = new Set<string>()
  const models: ProviderModel[] = []

  for (const entry of result.data ?? []) {
    if (!entry || typeof entry !== "object" || !("id" in entry) || !("capabilities" in entry)) continue
    const apiModel = entry as ApiModel
    if (!isActiveChatModel(apiModel) || seen.has(apiModel.id)) continue
    seen.add(apiModel.id)
    models.push(toProviderModel(STATIC_CATALOG.get(apiModel.id), apiModel))
  }

  return models.sort((a, b) => a.name.localeCompare(b.name))
}

async function resolveProviderModels(): Promise<ProviderModel[]> {
  const apiKey = loadApiKey()
  if (!apiKey) {
    console.warn("[pi-mistral] No API key; using static catalog.")
    return staticProviderModels()
  }
  try {
    const models = await discoverProviderModels(apiKey)
    if (!models.length) {
      console.warn("[pi-mistral] API returned no active chat models; using static catalog.")
      return staticProviderModels()
    }
    return models
  } catch (err) {
    console.warn("[pi-mistral] Model discovery:", err)
    return staticProviderModels()
  }
}

function createClient(apiKey: string): Mistral {
  return new Mistral({ apiKey })
}

async function runOcr(input: string, apiKey: string, signal?: AbortSignal) {
  const client = createClient(apiKey)

  if (isUrl(input)) {
    const result = await client.ocr.process({
      model: OCR_MODEL,
      document: { type: "document_url", documentUrl: input },
    }, { signal })
    return formatOcrResult(result)
  }

  if (!existsSync(input)) throw new Error(`Ficheiro nao encontrado: ${input}`)
  const ext = extname(input).toLowerCase()
  if (!SUPPORTED_EXTS.has(ext)) {
    throw new Error(
      `Formato "${ext}" nao suportado. Formatos: ${[...SUPPORTED_EXTS].join(", ")}`,
    )
  }

  const mime = MIME_MAP[ext] ?? "application/octet-stream"
  const dataUri = `data:${mime};base64,${readFileSync(input).toString("base64")}`
  const document = mime.startsWith("image/")
    ? { type: "image_url" as const, imageUrl: dataUri }
    : { type: "document_url" as const, documentUrl: dataUri }

  const result = await client.ocr.process({ model: OCR_MODEL, document }, { signal })
  return formatOcrResult(result)
}

function formatOcrResult(result: { model?: string | null; pages: Array<{ markdown: string }> }) {
  const text = result.pages.map((p) => p.markdown).join("\n\n--- Page Break ---\n\n")
  return { text: text || "(sem texto)", pages: result.pages.length, model: result.model ?? OCR_MODEL }
}

async function runFim(prompt: string, suffix: string, apiKey: string, signal?: AbortSignal) {
  const client = createClient(apiKey)
  const result = await client.fim.complete({
    model: FIM_MODEL,
    prompt,
    suffix,
    maxTokens: 1024,
    temperature: 0.2,
  }, { signal })

  const choice = result.choices[0]
  const content = choice?.message?.content
  const completion = typeof content === "string" ? content : ""
  const usage = result.usage

  return {
    completion,
    model: result.model ?? FIM_MODEL,
    usage: {
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
    },
  }
}

const NO_KEY_MSG = "API key nao configurada. Usa /login no pi e seleciona Mistral."

export default async function (pi: ExtensionAPI) {
  const models = await resolveProviderModels()

  pi.registerProvider(CHAT_PROVIDER, {
    name: "Pi-Mistral",
    baseUrl: "https://api.mistral.ai",
    apiKey: "$MISTRAL_API_KEY",
    api: "mistral-conversations",
    streamSimple: streamSimpleMistral,
    models,
  })

  pi.on("session_start", (_event, ctx) => {
    if (ctx.model?.provider !== LEGACY_PROVIDER) return
    pi.setModel({ provider: CHAT_PROVIDER, id: ctx.model.id })
  })

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== CHAT_PROVIDER) return
    const sessionId = ctx.sessionManager?.getSessionId()
    if (!sessionId) return
    const payload = event.payload
    if (!payload || typeof payload !== "object") return
    return {
      ...payload,
      prompt_cache_key: sessionId.slice(0, 64),
    }
  })

  pi.registerTool({
    name: "mistral_ocr",
    label: "Mistral OCR",
    description:
      "Extrai texto de imagens e documentos (PNG, JPEG, GIF, WebP, BMP, TIFF, PDF) " +
      "usando Mistral OCR 3. Aceita caminho local ou URL remota.",
    promptSnippet: "Extrai texto de imagens/documentos via Mistral OCR (local ou URL, PDFs)",
    promptGuidelines: [
      "Usar mistral_ocr para extrair texto de imagens, scans, capturas de ecra, ou PDFs.",
    ],
    parameters: Type.Object({
      filePath: Type.String({ description: "Caminho local ou URL da imagem/documento" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const key = await getApiKey(ctx.modelRegistry)
      if (!key) {
        return {
          content: [{ type: "text", text: NO_KEY_MSG }],
          details: { error: "no_api_key" },
        }
      }
      try {
        const r = await runOcr(params.filePath, key, signal)
        return {
          content: [{ type: "text", text: `OCR: ${r.pages} pagina(s) (${r.model})\n\n${r.text}` }],
          details: { filePath: params.filePath, pages: r.pages, model: r.model, textLength: r.text.length },
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return { isError: true, content: [{ type: "text", text: `Erro OCR: ${msg}` }], details: { error: msg } }
      }
    },
  })

  pi.registerTool({
    name: "mistral_fim",
    label: "Mistral FIM",
    description:
      "Completa codigo com fill-in-the-middle (FIM) usando Codestral. " +
      "Preenche o espaco entre prefixo e sufixo.",
    promptSnippet: "Completa codigo entre prefixo e sufixo com Codestral FIM",
    promptGuidelines: [
      "Usar mistral_fim para autocompletar codigo quando houver inicio e fim de um bloco.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Prefixo: codigo antes do ponto de insercao" }),
      suffix: Type.String({ description: "Sufixo: codigo depois do ponto de insercao" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const key = await getApiKey(ctx.modelRegistry)
      if (!key) {
        return {
          content: [{ type: "text", text: NO_KEY_MSG }],
          details: { error: "no_api_key" },
        }
      }
      try {
        const r = await runFim(params.prompt, params.suffix, key, signal)
        return {
          content: [{ type: "text", text: `FIM (${r.model}, ${r.usage.completionTokens} tokens):\n\n\`\`\`\n${r.completion}\n\`\`\`` }],
          details: { model: r.model, promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens },
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return { isError: true, content: [{ type: "text", text: `Erro FIM: ${msg}` }], details: { error: msg } }
      }
    },
  })
}
