// OpenCode V2 plugin: expose Google Antigravity (`agy acp`) as the `agy` provider.
//
// OpenCode keeps its normal shell/UI, but the agent loop itself runs inside
// Antigravity. agy's tool activity is streamed back as reasoning/status text.

import { AgyLanguageModel, parseModelId } from "./model.js"
import { getClient, shutdownAll } from "./pool.js"

const PROVIDER_ID = "agy"
const PROVIDER_NAME = "Antigravity"
const PACKAGE = "aisdk:opencode-agy-acp"

const FALLBACK_MODELS = [
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
]

let exitHookInstalled = false

function makeLogger(debug) {
  if (!debug) return () => {}
  return (...args) => console.error("[agy-acp]", ...args)
}

function modelInfo(model) {
  return {
    id: model.id,
    name: model.name || model.id,
    family: parseModelId(model.id).model,
  }
}

async function discoverModels({ binary, env, cwd, timeout, log }) {
  const client = getClient({ binary, cwd, permissionPolicy: "allow", env, log })
  const session = await Promise.race([
    (async () => {
      await client.initialize()
      return client.newSession({ cwd })
    })(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`model discovery timed out after ${timeout}ms`)), timeout),
    ),
  ])

  const models = (session?.models?.availableModels || [])
    .map((entry) => ({ id: entry.modelId, name: entry.name || entry.modelId }))
    .filter((entry) => entry.id)

  if (session?.sessionId) await client.closeSession(session.sessionId)
  return models
}

export default {
  id: "agy-acp",

  async setup(ctx) {
    const options = ctx.options || {}
    const binary = options.binary
    const permissionPolicy = options.permissionPolicy === "deny" ? "deny" : "allow"
    const mode = typeof options.mode === "string" ? options.mode : undefined
    const systemPrompt = typeof options.systemPrompt === "string" ? options.systemPrompt : ""
    const env = options.env && typeof options.env === "object" ? options.env : undefined
    const discoveryTimeout = Number.isFinite(options.discoveryTimeout)
      ? options.discoveryTimeout
      : 8000
    const log = makeLogger(options.debug)

    if (!exitHookInstalled) {
      exitHookInstalled = true
      process.once("exit", shutdownAll)
    }

    let discovered
    const models = async () => {
      if (Array.isArray(options.models) && options.models.length) {
        return options.models.map((entry) =>
          typeof entry === "string" ? { id: entry, name: entry } : modelInfo(entry),
        )
      }
      if (discovered) return discovered
      try {
        discovered = await discoverModels({
          binary,
          env,
          cwd: options.cwd || process.cwd(),
          timeout: discoveryTimeout,
          log,
        })
        log("discovered models", discovered.map((model) => model.id))
      } catch (error) {
        log("model discovery failed, using fallback list", error?.message)
        discovered = FALLBACK_MODELS.map(modelInfo)
      }
      return discovered
    }

    const modelList = await models()

    await ctx.provider.transform((draft) => {
      draft.update(PROVIDER_ID, (provider) => {
        provider.name = PROVIDER_NAME
        provider.package = PACKAGE
        provider.api = { type: "aisdk", package: PACKAGE }
        provider.request = { headers: {}, body: {} }
      })
    })

    await ctx.model.transform((draft) => {
      for (const model of modelList) {
        draft.update(PROVIDER_ID, model.id, (record) => {
          record.name = model.name
          record.family = model.family
          record.package = PACKAGE
          record.api = { id: model.id, type: "aisdk", package: PACKAGE }
          record.capabilities = { tools: false, input: ["text"], output: ["text"] }
          record.status = "active"
          record.enabled = true
          record.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
          record.limit = { context: 1_000_000, output: 32_000 }
          record.time = { released: 0 }
          record.request = { headers: {}, body: {} }
          record.variants = []
        })
      }
    })

    await ctx.aisdk.hook(
      "sdk",
      (input) => {
        if (!input?.model) return
        const packageName = typeof input.package === "string" ? input.package : ""
        const matches =
          input.model.providerID === PROVIDER_ID ||
          packageName === "opencode-agy-acp" ||
          packageName === PACKAGE
        if (!matches) return

        input.sdk = {
          languageModel: (modelID) =>
            new AgyLanguageModel({
              modelId: modelID || input.model.id,
              cwd: options.cwd || process.cwd(),
              binary,
              permissionPolicy,
              mode,
              systemPrompt,
              env,
              log,
            }),
        }
      },
      { providerID: PROVIDER_ID },
    )
  },
}
