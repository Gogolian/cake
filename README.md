# cake 🎂

Minimal code agent harness with no dependencies.

- **Pure HTML + JS** frontend (no framework, no build step)
- **Pure Node.js** server (zero npm dependencies)
- Supports **Anthropic** (Claude) and **OpenAI** (GPT-4o) out of the box
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

# Custom port
PORT=8080 node server.js
```

Then open http://localhost:3000 in your browser.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Anthropic API key (auto-selects anthropic provider) |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `PROVIDER` | auto | Override provider: `anthropic` or `openai` |
| `PORT` | `3000` | HTTP port |

## Tools available to the agent

| Tool | Description |
|---|---|
| `bash` | Run a shell command (30 s timeout) |
| `read_file` | Read a file from disk |
| `write_file` | Write a file to disk |
| `list_dir` | List directory contents |

## Customization

- Add new tools: extend `runTool` in `server.js` and add entries to `TOOLS_ANTHROPIC` / `TOOLS_OPENAI` in `public/index.html`.
- Change the system prompt: edit the `system` default in `proxyAnthropic` / `proxyOpenAI`.
- Style the UI: edit the `<style>` block in `public/index.html` — it's plain CSS custom properties.
