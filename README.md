# cake 🎂

Minimal code agent harness with no dependencies.

- **Pure HTML + JS** frontend (no framework, no build step)
- **Pure Node.js** server (zero npm dependencies)
- **Pluggable providers** — each LLM backend lives in its own file under [`providers/`](providers/), behind one unified interface
- Ships with **Anthropic**, **OpenAI**, **OpenRouter**, **Ollama**, **llama.cpp**, and **GitHub Copilot** providers — **all loaded at once**; pick any provider/model from the UI
- **Model picker**, per-answer **model annotation**, and a **context meter** (`≈ used / max`)
- Agentic loop with tool calls: `bash`, `read_file`, `write_file`, `list_dir`
- Server-sent events for streaming responses

## Quick start

```bash
# Just start it — every configured provider loads automatically.
npm start          # or: node server.js

# Configure any providers you want; each appears in the model picker.
export ANTHROPIC_API_KEY=sk-ant-...   # Anthropic
export OPENAI_API_KEY=sk-...          # OpenAI
export OPENROUTER_API_KEY=sk-or-...   # OpenRouter (gateway to many models)
npm start

# Ollama (local, no key) — auto-detected on http://127.0.0.1:11434 when running
npm start
# ...or point at a remote server:
OLLAMA_URL=http://my-host:11434 npm start

# llama.cpp (local, no key) — point at a running llama-server:
LLAMACPP_URL=http://127.0.0.1:8080 npm start

# GitHub Copilot (experimental) — sign in from the UI, or:
node server.js --login && npm start

# Custom port
PORT=8080 npm start
```

Then open http://localhost:3000 in your browser.

Every provider is loaded on startup. Any provider that isn't configured (no API
key, no local Ollama or llama.cpp, not signed in to Copilot) or that errors is
simply skipped — the app keeps working with whatever is available. Use the
**model picker** in the header to choose a `provider/model`; each reply is
labelled with the model that produced it, and the context meter shows the
approximate tokens used against the selected model's maximum.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PROVIDER` | — | Optional default provider when the UI sends none: `anthropic`, `openai`, `openrouter`, `ollama`, `llamacpp`, `copilot`. No longer required — all providers load regardless. |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (enables the anthropic provider) |
| `OPENAI_API_KEY` | — | OpenAI API key (enables the openai provider) |
| `OPENROUTER_API_KEY` | — | OpenRouter API key (enables the openrouter provider) |
| `ANTHROPIC_MODEL` | `claude-opus-4-5` | Default model for the anthropic provider |
| `OPENAI_MODEL` | `gpt-4o` | Default model for the openai provider |
| `OPENROUTER_MODEL` | `openai/gpt-4o` | Default model for the openrouter provider |
| `OPENROUTER_SITE_URL` | — | Optional site URL sent as `HTTP-Referer` for OpenRouter app attribution |
| `OPENROUTER_APP_NAME` | — | Optional app name sent as `X-Title` for OpenRouter app attribution |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Base URL of the Ollama server |
| `OLLAMA_MODEL` | `llama3.1` | Default model for the ollama provider |
| `OLLAMA_NUM_CTX` | `8192` | Context window reported for Ollama models (they don't advertise it) |
| `LLAMACPP_URL` | `http://127.0.0.1:8080` | Base URL of the llama.cpp server (`llama-server`); also opts the provider in |
| `LLAMACPP_MODEL` | `llama.cpp` | Default model label for the llama.cpp provider (the live model is read from the server) |
| `LLAMACPP_API_KEY` | — | Token used to authenticate to llama.cpp, only if `llama-server` was started with `--api-key` |
| `LLAMACPP_NUM_CTX` | `4096` | Fallback context window for llama.cpp when the server doesn't report one |
| `COPILOT_MODEL` | `gpt-4o` | Default model for the copilot provider |
| `GITHUB_COPILOT_TOKEN` | — | GitHub OAuth token for Copilot; overrides `--login` and the editor plugin config |
| `COPILOT_DEBUG` | — | Set to `1` to log Copilot auth/token-exchange details to stderr (see [Copilot sign-in](#github-copilot-sign-in)) |
| `SYSTEM_PROMPT` | built-in | Override the agent's system prompt |
| `PORT` | `3000` | HTTP port |

All providers are always loaded. The UI's model picker lists a `provider/model`
for every provider that is currently usable (has a key, a reachable Ollama or
llama.cpp, or a signed-in Copilot); the `*_MODEL` variables only set each
provider's **default** model for when no explicit selection is sent. `PROVIDER`
is now optional and only chooses the fallback provider for a request that
doesn't name one.

## GitHub Copilot sign-in

Copilot needs a GitHub OAuth token. The easiest way to get one is to sign in
with your GitHub account using the OAuth **device flow** — no token to copy and
no editor plugin required:

```bash
node server.js --login
```

cake prints a short one-time code and opens <https://github.com/login/device>
in your browser. Enter the code, approve access, and the token is saved to
`~/.config/cake/copilot.json` (created readable only by you). Then start the
server as usual:

```bash
npm start
```

Copilot's models then appear in the picker alongside any other configured
providers. You can also sign in from the web UI: run `npm start`, open the app,
and click **Sign in to GitHub Copilot** (shown until Copilot has models).

cake looks for a Copilot token in this order:

1. `GITHUB_COPILOT_TOKEN` (or the `GH_COPILOT_TOKEN` fallback),
2. the token saved by `--login`,
3. the official editor plugins' `~/.config/github-copilot` files,
4. a generic `GITHUB_TOKEN` / `GH_TOKEN`, only as a last resort.

So `GITHUB_COPILOT_TOKEN` always overrides a saved login. If the token expires
or is revoked, just run `node server.js --login` again.

The generic `GITHUB_TOKEN` / `GH_TOKEN` are checked **last** on purpose: shells,
the `gh` CLI, Codespaces and CI often export them as tokens that are **not**
enabled for Copilot. If cake used one of those, the token exchange would fail
with a `404` even right after a successful sign-in. When that happens, run
`node server.js --login` (or unset `GITHUB_TOKEN` / `GH_TOKEN`) so cake uses your
Copilot-enabled token instead.

### Debugging the token exchange

cake obtains a Copilot session token by exchanging a GitHub OAuth token at
`GET https://api.github.com/copilot_internal/v2/token`. That endpoint answers
`404 Not Found` when the OAuth token is otherwise valid but **not entitled to
Copilot** — so the interesting question is always *which* token cake sent.

Every failed exchange logs one line to stderr naming the token's **source** and
a safe **fingerprint** (its kind and a coarse size band — never the secret
itself), e.g.:

```
[copilot] token exchange ← HTTP 404 | x-github-request-id: … | body: {"message":"Not Found",…}
```

The same detail is appended to the error shown in the UI:
`… [oauth source: ambient GITHUB_TOKEN; oauth token: ghp_ (20-50 chars); x-github-request-id: …]`.
A `ghu_` prefix is a device-flow login token (what you want); `ghp_` or
`github_pat_` is a personal access token, and `gho_` a plain OAuth token —
neither is Copilot-enabled, and seeing one here means that source is winning and
should be removed or overridden.

For the full picture — every request, response, and the device-flow login steps —
set `COPILOT_DEBUG=1`:

```bash
COPILOT_DEBUG=1 PROVIDER=copilot node server.js
```

## Architecture

```
browser (public/index.html)   provider-neutral history + unified SSE events
      │  GET /api/config  → provider/model list for the picker
      │  POST /api/chat   → { messages, provider, model }
      │  POST /api/tool
      ▼
server.js                     static files + request router (no API specifics)
      │  select(provider) → provider ; available() → picker data
      ▼
providers/                    one file per backend, one unified interface
tools.js                      canonical tool definitions + execution
```

The browser keeps a **provider-neutral** conversation and speaks a single
event protocol. Every provider is loaded; the browser fetches the available
`provider/model` list from `/api/config` and sends its choice with each
`/api/chat` request. `server.js` relays to the chosen provider (falling back to
the first configured one) and never contains API-specific code. All differences
in endpoint, auth, request shape, and streaming format are isolated inside
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
