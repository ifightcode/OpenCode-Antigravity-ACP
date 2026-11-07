// AI SDK LanguageModelV3 backed by a live `agy acp` session.

import { serializePrompt } from "./prompt.js"
import { getClient } from "./pool.js"

const FINISH_REASONS = {
  end_turn: "stop",
  max_tokens: "length",
  max_turn_requests: "length",
  refusal: "content-filter",
  cancelled: "other",
}

function mapFinishReason(stopReason) {
  return {
    unified: FINISH_REASONS[stopReason] || "other",
    raw: stopReason,
  }
}

function emptyUsage(raw) {
  const input = raw?.inputTokens
  const output = raw?.outputTokens
  return {
    inputTokens: {
      total: typeof input === "number" ? input : undefined,
      noCache: undefined,
      cacheRead: typeof raw?.cachedInputTokens === "number" ? raw.cachedInputTokens : undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: typeof output === "number" ? output : undefined,
      text: typeof output === "number" ? output : undefined,
      reasoning: undefined,
    },
    raw: raw && typeof raw === "object" ? raw : undefined,
  }
}

function textFromContent(content) {
  if (!content || typeof content !== "object") return ""
  if (content.type === "text") return typeof content.text === "string" ? content.text : ""
  return ""
}

/**
 * Split `gemini-3.8-flash-high` into { model: "gemini-3.8-flash", thoughtLevel: "high" }.
 * ACP `session/new` reports both the variant list and family-level config options.
 */
export function parseModelId(modelId) {
  const match = /^(.*)-(high|medium|low)$/.exec(modelId)
  if (match && /^gemini/i.test(match[1])) {
    return { model: match[1], thoughtLevel: match[2] }
  }
  return { model: modelId, thoughtLevel: undefined }
}

export class AgyLanguageModel {
  constructor(options = {}) {
    this.specificationVersion = "v3"
    this.provider = "agy"
    this.modelId = options.modelId
    this.supportedUrls = {}

    this.cwd = options.cwd || process.cwd()
    this.binary = options.binary
    this.permissionPolicy = options.permissionPolicy || "allow"
    this.mode = options.mode
    this.systemPrompt = options.systemPrompt || ""
    this.env = options.env
    this.log = options.log || (() => {})
  }

  async doGenerate(options) {
    const result = await this.doStream(options)
    const reader = result.stream.getReader()
    let text = ""
    let reasoning = ""
    let finishReason = { unified: "other", raw: undefined }
    let usage = emptyUsage(undefined)

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      switch (value.type) {
        case "text-delta":
          text += value.delta
          break
        case "reasoning-delta":
          reasoning += value.delta
          break
        case "finish":
          finishReason = value.finishReason
          usage = value.usage
          break
        case "error":
          throw value.error instanceof Error ? value.error : new Error(String(value.error))
        default:
          break
      }
    }

    const content = []
    if (reasoning) content.push({ type: "reasoning", text: reasoning })
    content.push({ type: "text", text })
    return { content, finishReason, usage }
  }

  async doStream(options) {
    const client = getClient({
      binary: this.binary,
      cwd: this.cwd,
      permissionPolicy: this.permissionPolicy,
      env: this.env,
      log: this.log,
    })

    const { systemPrompt, blocks } = serializePrompt(options.prompt)
    const combinedSystemPrompt = [this.systemPrompt, systemPrompt].filter(Boolean).join("\n\n")
    const signal = options.abortSignal

    let sessionId
    let closed = false
    let textOpen = false
    let reasoningOpen = false

    const stream = new ReadableStream({
      start: async (controller) => {
        const send = (part) => {
          if (closed) return
          try {
            controller.enqueue(part)
          } catch {
            closed = true
          }
        }

        const closeText = () => {
          if (!textOpen) return
          textOpen = false
          send({ type: "text-end", id: "text-1" })
        }

        const closeReasoning = () => {
          if (!reasoningOpen) return
          reasoningOpen = false
          send({ type: "reasoning-end", id: "reasoning-1" })
        }

        const reasoningDelta = (delta) => {
          if (!delta) return
          if (!reasoningOpen) {
            reasoningOpen = true
            send({ type: "reasoning-start", id: "reasoning-1" })
          }
          send({ type: "reasoning-delta", id: "reasoning-1", delta })
        }

        send({ type: "stream-start", warnings: [] })

        try {
          const session = await client.newSession({
            cwd: this.cwd,
            systemPrompt: combinedSystemPrompt || undefined,
          })
          sessionId = session?.sessionId
          if (!sessionId) throw new Error("agy acp did not return a sessionId")

          await this.#configure(client, sessionId, send, reasoningDelta)

          const onUpdate = (update) => {
            if (!update || typeof update !== "object") return
            switch (update.sessionUpdate) {
              case "agent_message_chunk": {
                const delta = textFromContent(update.content)
                if (!delta) return
                closeReasoning()
                if (!textOpen) {
                  textOpen = true
                  send({ type: "text-start", id: "text-1" })
                }
                send({ type: "text-delta", id: "text-1", delta })
                return
              }
              case "agent_thought_chunk": {
                const delta = textFromContent(update.content)
                if (!delta) return
                closeText()
                reasoningDelta(delta)
                return
              }
              case "tool_call": {
                closeText()
                const title = update.title || update.kind || update.toolCallId || "tool"
                reasoningDelta(`\n[tool] ${title}${update.status ? ` (${update.status})` : ""}\n`)
                return
              }
              case "tool_call_update": {
                if (update.status === "completed" || update.status === "failed") {
                  closeText()
                  const title = update.title || update.kind || update.toolCallId || "tool"
                  reasoningDelta(`[tool] ${title}: ${update.status}\n`)
                }
                return
              }
              case "plan": {
                const entries = Array.isArray(update.entries) ? update.entries : []
                if (!entries.length) return
                closeText()
                const lines = entries
                  .map((entry) => `- [${entry.status || "pending"}] ${entry.content || ""}`)
                  .join("\n")
                reasoningDelta(`\n[plan]\n${lines}\n`)
                return
              }
              default:
                return
            }
          }

          const result = await client.prompt(sessionId, blocks, { onUpdate, signal })
          closeText()
          closeReasoning()
          send({
            type: "finish",
            finishReason: mapFinishReason(result?.stopReason),
            usage: emptyUsage(result?.usage),
          })
        } catch (error) {
          closeText()
          closeReasoning()
          send({
            type: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          })
          send({
            type: "finish",
            finishReason: { unified: "error", raw: "error" },
            usage: emptyUsage(undefined),
          })
        } finally {
          closed = true
          try {
            controller.close()
          } catch {
            // already closed/cancelled
          }
          if (sessionId) await client.closeSession(sessionId)
        }
      },
      cancel: () => {
        closed = true
        if (sessionId) {
          try {
            client.notify("session/cancel", { sessionId })
          } catch {
            // ignore
          }
        }
      },
    })

    return { stream }
  }

  async #configure(client, sessionId, send, reasoningDelta) {
    const { model, thoughtLevel } = parseModelId(this.modelId)

    const failures = []
    try {
      await client.setConfigOption(sessionId, "model", model)
    } catch (error) {
      failures.push(`model=${model}: ${error?.message}`)
    }
    if (thoughtLevel) {
      try {
        await client.setConfigOption(sessionId, "thought_level", thoughtLevel)
      } catch (error) {
        failures.push(`thought_level=${thoughtLevel}: ${error?.message}`)
      }
    }
    if (this.mode) {
      try {
        await client.setConfigOption(sessionId, "mode", this.mode)
      } catch (error) {
        failures.push(`mode=${this.mode}: ${error?.message}`)
      }
    }
    if (failures.length) {
      reasoningDelta(`\n[agy] ignored unsupported session options: ${failures.join("; ")}\n`)
    }
  }
}
