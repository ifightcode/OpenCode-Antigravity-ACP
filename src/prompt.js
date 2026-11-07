// Serialize an AI SDK V3 prompt into ACP session/new systemPrompt + session/prompt content blocks.

function textOfPart(part) {
  if (!part || typeof part !== "object") return ""
  switch (part.type) {
    case "text":
      return typeof part.text === "string" ? part.text : ""
    case "reasoning":
      return typeof part.text === "string" ? part.text : ""
    case "tool-call": {
      const input = (() => {
        try {
          return JSON.stringify(part.input ?? part.args ?? {})
        } catch {
          return "{}"
        }
      })()
      return `[tool call] ${part.toolName || "tool"} ${input}`
    }
    case "tool-result": {
      const output = part.output
      if (typeof output === "string") return `[tool result] ${output}`
      try {
        return `[tool result] ${JSON.stringify(output)}`
      } catch {
        return "[tool result]"
      }
    }
    default:
      return ""
  }
}

function textOfMessage(message) {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .map(textOfPart)
    .filter((text) => text.length > 0)
    .join("\n")
}

const ROLE_LABEL = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
  system: "System",
}

/**
 * @param {Array} prompt LanguageModelV3Prompt
 * @returns {{ systemPrompt: string, blocks: Array<{type: "text", text: string}> }}
 */
export function serializePrompt(prompt) {
  const systemParts = []
  const turns = []

  for (const message of prompt || []) {
    const text = textOfMessage(message).trim()
    if (!text) continue
    if (message.role === "system") {
      systemParts.push(text)
      continue
    }
    turns.push({ role: message.role, text })
  }

  const systemPrompt = systemParts.join("\n\n").trim()

  if (turns.length === 1 && turns[0].role === "user") {
    return { systemPrompt, blocks: [{ type: "text", text: turns[0].text }] }
  }

  // A fresh ACP session has no prior turns, so replay the transcript as one prompt.
  const transcript = turns
    .map((turn) => `### ${ROLE_LABEL[turn.role] || turn.role}\n${turn.text}`)
    .join("\n\n")

  const last = turns[turns.length - 1]
  const instruction =
    last?.role === "user"
      ? "\n\nRespond to the final User message above."
      : "\n\nContinue the conversation from the final message above."

  return {
    systemPrompt,
    blocks: [{ type: "text", text: transcript + instruction }],
  }
}
