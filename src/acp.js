// Minimal ACP (Agent Client Protocol v1) client over stdio.
// Speaks newline-delimited JSON-RPC 2.0 with `agy acp`.

import { spawn } from "node:child_process"

export class AcpError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = "AcpError"
    this.code = options.code
    this.data = options.data
    this.method = options.method
  }
}

const DEFAULT_TIMEOUT = 30_000

export class AcpClient {
  constructor(options = {}) {
    this.binary = options.binary || process.env.AGY_ACP_BIN || "agy"
    this.args = options.args || ["acp", "--disable-telemetry"]
    this.cwd = options.cwd || process.cwd()
    this.env = { ...process.env, ...(options.env || {}) }
    this.permissionPolicy = options.permissionPolicy || "allow"
    this.log = options.log || (() => {})

    this.child = undefined
    this.dead = false
    this.nextId = 1
    this.buffer = ""
    this.pending = new Map()
    this.promptListeners = new Map()
    this.stderrTail = ""
    this.ready = false
    this.readyPromise = undefined
    this.initPromise = undefined
  }

  start() {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = new Promise((resolve, reject) => {
      const child = spawn(this.binary, this.args, {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: this.env,
      })
      this.child = child

      child.once("spawn", () => {
        this.ready = true
        resolve()
      })
      child.once("error", (error) => {
        this.dead = true
        reject(
          new AcpError(
            `Failed to start "${this.binary} ${this.args.join(" ")}": ${error.message}`,
            { code: "spawn" },
          ),
        )
      })
      child.once("exit", (code, signal) => {
        this.dead = true
        this.ready = false
        const suffix = this.stderrTail.trim()
        const detail = suffix ? `\n${suffix}` : ""
        for (const [id, entry] of this.pending) {
          clearTimeout(entry.timer)
          entry.reject(
            new AcpError(
              `agy acp exited (code=${code}, signal=${signal}) while waiting for ${entry.method}${detail}`,
              { code: "exited", method: entry.method },
            ),
          )
          this.pending.delete(id)
        }
        for (const [, listener] of this.promptListeners) listener.onExit?.(code, signal)
        this.promptListeners.clear()
      })

      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk) => this.#onData(chunk))

      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-4000)
        this.log("agy acp stderr", chunk)
      })
    })
    return this.readyPromise
  }

  #onData(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.log("agy acp non-JSON output", line.slice(0, 500))
        continue
      }
      this.#onMessage(message)
    }
  }

  #onMessage(message) {
    if (message.id !== undefined && message.method === undefined) {
      // Response to one of our requests.
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(
          new AcpError(message.error.message || "ACP request failed", {
            code: message.error.code,
            data: message.error.data,
            method: entry.method,
          }),
        )
      } else {
        entry.resolve(message.result)
      }
      return
    }

    if (message.method && message.id !== undefined) {
      // Request from the agent to us.
      void this.#onAgentRequest(message)
      return
    }

    if (message.method === "session/update") {
      const params = message.params || {}
      const listener = this.promptListeners.get(params.sessionId)
      if (listener) listener.onUpdate?.(params.update)
      return
    }

    this.log("agy acp notification", message.method)
  }

  async #onAgentRequest(message) {
    const { id, method, params } = message
    try {
      if (method === "session/request_permission") {
        const result = this.#permissionResult(params || {})
        this.#respond(id, result)
        return
      }
      // We advertised no fs/terminal/elicitation capabilities, so anything else is unsupported.
      this.#respondError(id, -32601, `Method not supported: ${method}`)
    } catch (error) {
      this.#respondError(id, -32603, error?.message || "Internal error")
    }
  }

  #permissionResult(params) {
    const options = Array.isArray(params.options) ? params.options : []
    const prefer =
      this.permissionPolicy === "deny"
        ? ["reject_once", "reject_always"]
        : ["allow_once", "allow_always"]

    const chosen =
      prefer.map((kind) => options.find((option) => option.kind === kind)).find(Boolean) ||
      (this.permissionPolicy === "deny"
        ? options.find((option) => /reject|deny/i.test(option.name || ""))
        : options.find((option) => /allow|approve|accept/i.test(option.name || "")))

    if (!chosen) return { outcome: { outcome: "cancelled" } }
    return { outcome: { outcome: "selected", optionId: chosen.optionId } }
  }

  #respond(id, result) {
    this.#write({ jsonrpc: "2.0", id, result })
  }

  #respondError(id, code, message) {
    this.#write({ jsonrpc: "2.0", id, error: { code, message } })
  }

  #write(message) {
    if (!this.child || this.dead) {
      throw new AcpError("agy acp is not running", { code: "exited" })
    }
    this.child.stdin.write(JSON.stringify(message) + "\n")
  }

  request(method, params, { timeout = DEFAULT_TIMEOUT } = {}) {
    if (this.dead) {
      return Promise.reject(new AcpError("agy acp is not running", { code: "exited", method }))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer =
        timeout > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new AcpError(`Timed out after ${timeout}ms: ${method}`, { code: "timeout", method }))
            }, timeout)
          : undefined
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.#write({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params })
  }

  async initialize() {
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      await this.start()
      const result = await this.request("initialize", {
        protocolVersion: 1,
        clientInfo: {
          name: "opencode-agy-acp",
          title: "OpenCode Antigravity ACP bridge",
          version: "0.1.0",
        },
        clientCapabilities: {},
      })
      if (!result || result.protocolVersion !== 1) {
        throw new AcpError(
          `Unsupported ACP protocol version: ${result?.protocolVersion}`,
          { code: "protocol" },
        )
      }
      return result
    })()
    return this.initPromise
  }

  async newSession({ cwd = this.cwd, systemPrompt, mcpServers = [] } = {}) {
    await this.initialize()
    const params = { cwd, mcpServers }
    if (systemPrompt) {
      params._meta = { antigravity: { systemPrompt: { append: systemPrompt } } }
    }
    return this.request("session/new", params)
  }

  async setConfigOption(sessionId, configId, value) {
    return this.request("session/set_config_option", { sessionId, configId, value }, { timeout: 15_000 })
  }

  async setMode(sessionId, modeId) {
    return this.request("session/set_mode", { sessionId, modeId }, { timeout: 15_000 })
  }

  /**
   * Send a prompt and stream `session/update` notifications to `onUpdate`.
   * Resolves with the ACP PromptResponse (e.g. `{ stopReason: "end_turn" }`).
   */
  async prompt(sessionId, prompt, { onUpdate, signal } = {}) {
    await this.initialize()
    if (signal?.aborted) throw new AcpError("Aborted before prompt", { code: "aborted" })

    const onAbort = () => {
      try {
        this.notify("session/cancel", { sessionId })
      } catch {
        // client already gone; nothing to cancel
      }
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    this.promptListeners.set(sessionId, {
      onUpdate,
      onExit: (code, sig) =>
        onUpdate?.({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `\n[agy acp exited: code=${code} signal=${sig}]\n` },
        }),
    })

    try {
      return await this.request("session/prompt", { sessionId, prompt }, { timeout: 0 })
    } finally {
      this.promptListeners.delete(sessionId)
      signal?.removeEventListener("abort", onAbort)
    }
  }

  async closeSession(sessionId) {
    if (this.dead) return
    try {
      await this.request("session/close", { sessionId }, { timeout: 5_000 })
    } catch (error) {
      this.log("session/close failed", error?.message)
    }
  }

  close() {
    this.dead = true
    try {
      this.child?.kill("SIGTERM")
    } catch {
      // ignore
    }
  }
}
