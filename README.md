# cake 🎂

Minimal code agent harness with no dependencies.

- **Pure HTML + JS** frontend (no framework, no build step)
- **Pure Node.js** server (zero npm dependencies)
- **Pluggable providers** — each LLM backend lives in its own file under [`providers/`](providers/), behind one unified interface
- Ships with **Anthropic**, **OpenAI**, **Ollama**, and **GitHub Copilot** providers
- Agentic loop with tool calls: `bash`, `read_file`, `write_file`, `list_dir`
- Server-sent events for streaming responses

## Quick start

```bash
# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...
node server.js

# OpenAI
export OPENAI_API_KEY=sk-...
node server.js

# Ollama (local, no key) — needs a running Ollama server
PROVIDER=ollama OLLAMA_MODEL=llama3.1 node server.js

# GitHub Copilot (experimental) — needs an editor Copilot login or token
PROVIDER=copilot node server.js

# Custom port
PORT=8080 node server.js
```

Then open http://localhost:3000 in your browser.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PROVIDER` | auto | Force a provider: `anthropic`, `openai`, `ollama`, `copilot` |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (auto-selects the anthropic provider) |
| `OPENAI_API_KEY` | — | OpenAI API key (auto-selects the openai provider) |
| `ANTHROPIC_MODEL` | `claude-opus-4-5` | Model for the anthropic provider |
| `OPENAI_MODEL` | `gpt-4o` | Model for the openai provider |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Base URL of the Ollama server |
| `OLLAMA_MODEL` | `llama3.1` | Model for the ollama provider |
| `COPILOT_MODEL` | `gpt-4o` | Model for the copilot provider |
| `GITHUB_COPILOT_TOKEN` | — | GitHub OAuth token for Copilot (else read from the editor plugin config) |
| `SYSTEM_PROMPT` | built-in | Override the agent's system prompt |
| `PORT` | `3000` | HTTP port |

When `PROVIDER` is not set, the first configured key-based provider is used
(anthropic → openai → copilot). `ollama` and `copilot` can also be selected
explicitly with `PROVIDER`.

## Architecture

```
browser (public/index.html)   provider-neutral history + unified SSE events
      │  POST /api/chat, /api/tool
      ▼
server.js                     static files + request router (no API specifics)
      │  select() → provider
      ▼
providers/                    one file per backend, one unified interface
tools.js                      canonical tool definitions + execution
```

The browser keeps a **provider-neutral** conversation and speaks a single
event protocol. `server.js` relays between the browser and whichever provider
is configured, and never contains API-specific code. All differences in
endpoint, auth, request shape, and streaming format are isolated inside
`providers/`. See [`providers/README.md`](providers/README.md) to add one.

## Tools available to the agent

| Tool | Description |
|---|---|
| `bash` | Run a shell command (30 s timeout) |
| `read_file` | Read a file from disk |
| `write_file` | Write a file to disk |
| `list_dir` | List directory contents |

## Customization

- **Add a provider:** drop a file in `providers/` and register it in `providers/index.js` — see `providers/README.md`.
- **Add a tool:** extend `definitions` and `run` in `tools.js`. The UI and every provider pick it up automatically.
- **Change the system prompt:** set `SYSTEM_PROMPT`, or edit the default in `providers/util.js`.
- **Style the UI:** edit the `<style>` block in `public/index.html` — it's plain CSS custom properties.
