# opencode-agy-acp

Use **Google Antigravity** models inside [OpenCode](https://opencode.ai) as the
`agy` provider.

OpenCode stays the shell — sessions, history, model picker, TUI — while the agent
loop runs inside Antigravity over the
[Agent Client Protocol](https://agentclientprotocol.com). Antigravity keeps its
own tools (file edits, shell commands, search), and its activity streams back to
OpenCode as text and reasoning updates.

```
OpenCode ── LanguageModelV3 ──► ACP client ──stdio JSON-RPC──► agy acp
```

## Quick start

```sh
# 1. Install (this directory -> OpenCode's global plugins dir)
cp -R AGY-ACP ~/.config/opencode/plugins/opencode-agy-acp

# 2. Register it (see Install below), then:
opencode service restart
opencode models | grep '^agy/'

# 3. Use an Antigravity model
opencode run -m agy/claude-sonnet-4-6 "Explain this repository"
```

## Requirements

- OpenCode V2 (`opencode --version` ≥ 2.2)
- `agy` ≥ 1.5.2 on `PATH` (or set the `binary` option)
- An authenticated Antigravity CLI (`agy` login / OAuth token)

## Install

The plugin is a dependency-free ESM package — no build step, no `npm install`.

```sh
cp -R AGY-ACP ~/.config/opencode/plugins/opencode-agy-acp
```

Register the **absolute path** in `~/.config/opencode/cli.json` (keep any
existing keys and plugins):

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    [
      "/Users/you/.config/opencode/plugins/opencode-agy-acp",
      {
        "permissionPolicy": "allow"
      }
    ]
  ]
}
```

Restart the background server and verify:

```sh
opencode service restart
opencode models | grep '^agy/'
```

## Using the models

The `agy/...` entries **are** the Antigravity models. You never launch `agy`
yourself — OpenCode starts it automatically when a model is selected.

### In the TUI

1. Start `opencode`
2. Type `/model`
3. Type `agy` to filter, or select the **Antigravity** provider
4. Pick a model and chat normally

The status bar shows the active model, e.g. `agy/claude-sonnet-4-6`. The
selection applies to that session; use `/model` again to switch at any time.

### From the CLI

```sh
# New session
opencode run -m agy/claude-sonnet-4-6 "Refactor src/foo.ts"

# Continue the previous session
opencode run -c -m agy/gemini-3.8-flash-high "Now add tests"

# Show reasoning/status blocks
opencode run --thinking -m agy/claude-opus-4-6-thinking "Why is this slow?"
```

### Available models

Models are discovered from `agy acp` at startup (`session/new` →
`models.availableModels`). If discovery fails, a static fallback list is used.

| Model ID | Notes |
| --- | --- |
| `gemini-3.8-flash-high` | Gemini, high thinking budget |
| `gemini-3.8-flash-medium` | Same model, medium thinking |
| `gemini-3.8-flash-low` | Same model, low thinking (fastest) |
| `claude-sonnet-4-6` | Best general coding choice |
| `claude-opus-4-6-thinking` | Harder problems, slower |
| `gpt-oss-120b-medium` | Alternative open model |

The Gemini variants are one model at different thinking levels; the plugin maps
the `-high/-medium/-low` suffix to the ACP `thought_level` config option.

## Configuration

Plugin options are the second element of the `plugins` entry in `cli.json`:

| Option | Default | Description |
| --- | --- | --- |
| `binary` | `agy` (or `$AGY_ACP_BIN`) | Path/name of the Antigravity CLI |
| `permissionPolicy` | `"allow"` | Answer to `session/request_permission`: `"allow"` or `"deny"` |
| `mode` | unset | Antigravity mode: `default`, `accept-edits`, or `plan` |
| `systemPrompt` | unset | Extra text appended to agy's system prompt (`_meta.antigravity.systemPrompt.append`) |
| `cwd` | OpenCode process cwd | Working directory for `session/new` |
| `env` | `process.env` | Extra environment variables for the agy process |
| `discoveryTimeout` | `8000` | Milliseconds to wait for model discovery |
| `models` | unset | Override the model list, e.g. `["gemini-3.8-flash-high"]` |
| `debug` | `false` | Log ACP traffic to stderr |

`permissionPolicy: "allow"` auto-approves Antigravity's own permission prompts
so runs are non-interactive. Antigravity's `settings.json` allow/deny rules
still apply. Use `"deny"` to make agy refuse edits/commands.

Example with more options:

```json
[
  "/Users/you/.config/opencode/plugins/opencode-agy-acp",
  {
    "permissionPolicy": "allow",
    "mode": "accept-edits",
    "systemPrompt": "Prefer small, focused diffs.",
    "debug": false
  }
]
```

## How it works

- The plugin registers the `agy` provider and its models through OpenCode's
  provider/model catalog hooks.
- An AISDK **SDK hook** supplies a `LanguageModelV3` implementation; OpenCode's
  normal generation pipeline calls it, so streaming, abort, and history all work
  as usual.
- Each request opens a fresh ACP session and replays the OpenCode transcript
  (role-marked text). `doStream` maps ACP updates to AI SDK stream parts:
  `agent_message_chunk` → text, `agent_thought_chunk` → reasoning,
  `tool_call` / `tool_call_update` / `plan` → reasoning status lines.
- Aborting a response sends `session/cancel` to agy.
- One shared `agy acp` process per `(binary, cwd, permissionPolicy)` lives for
  the server lifetime; requests get separate ACP sessions.

## Limitations

- **One agent loop.** OpenCode's own tool loop is disabled
  (`capabilities.tools: false`); Antigravity performs all tool work.
- **Transcript replay.** ACP session resumption per OpenCode session is a future
  optimization; today each request replays the conversation.
- **Usage.** ACP prompt responses usually omit token usage, so usage is reported
  as unknown (models are registered with zero cost).
- **Text only.** Images/audio are not forwarded in this version.

## Troubleshooting

- **`/model` shows no `agy/...` models** — restart the server:
  `opencode service restart`. Check `opencode models | grep '^agy/'`.
- **`No AISDK provider plugin returned an SDK`** — the SDK hook did not match.
  Confirm the provider ID is `agy` and the plugin loaded without errors.
- **`Provider package ... is not installed`** — the plugin was registered by
  package name instead of an absolute path, or the SDK hook failed to run.
- **Plugin load errors** — run
  `opencode --standalone --print-logs --log-level debug` and look for
  `failed to load plugin`.
- **`Individual quota reached`** — this is Antigravity's own quota message,
  returned as normal assistant text. Gemini and Claude quotas are separate;
  switch models with `/model`.

## License

MIT
