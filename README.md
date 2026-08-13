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

# GitHub Copilot (experimental) — sign in with your GitHub account
node server.js --login
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
| `GITHUB_COPILOT_TOKEN` | — | GitHub OAuth token for Copilot; overrides `--login` and the editor plugin config |
| `COPILOT_DEBUG` | — | Set to `1` to log Copilot auth/token-exchange details to stderr (see [Copilot sign-in](#github-copilot-sign-in)) |
| `SYSTEM_PROMPT` | built-in | Override the agent's system prompt |
| `PORT` | `3000` | HTTP port |

When `PROVIDER` is not set, the first configured key-based provider is used
(anthropic → openai → copilot). `ollama` and `copilot` can also be selected
explicitly with `PROVIDER`.

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
PROVIDER=copilot node server.js
```

You can also sign in from the web UI: run `PROVIDER=copilot node server.js`,
open the app, and click **Sign in to GitHub Copilot**.

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
