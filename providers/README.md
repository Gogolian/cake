# providers

Each file here teaches cake how to talk to one LLM backend. The rest of the
app only ever sees a **unified interface**, so it never needs to know a
provider's connection details, API style, or streaming format.

## The unified interface

A provider is a plain object with these members:

| Member | Type | Purpose |
|---|---|---|
| `id` | `string` | Short identifier (`'anthropic'`), also the `PROVIDER` value |
| `label` | `string` | Human-readable name shown in the UI |
| `isConfigured()` | `→ boolean` | Whether the provider has the credentials/config it needs |
| `model()` | `→ string` | Default model name (usually env-overridable) |
| `listModels()` | `→ Promise<[{ id, maxContext }]>` | Models to offer in the picker; `[]` when unavailable |
| `buildRequest(req)` | `→ Promise<{ transport, options, body }>` | Turn a unified request into an upstream HTTP(S) call |
| `createParser()` | `→ { feed(data), flush() }` | Stateful parser: provider SSE → unified events |

### `listModels()`

Return the models the picker should list, each as `{ id, maxContext }` where
`maxContext` is the model's context window in tokens (`0` if unknown). Discover
them from the backend when possible and **fall back gracefully**: return `[]`
(or a curated static list) on any error or missing configuration, so an
unavailable provider simply doesn't appear and never breaks the app. Keep it
quick — it runs on `/api/config`; use the shared `getJson` helper from
`util.js`, which times out stuck requests.

### `buildRequest(req)`

`req` is provider-neutral:

```js
{ messages, tools, system, model, maxTokens }
```

`messages` is the unified history:

```js
{ role: 'user',      content: string }
{ role: 'assistant', content: string, tool_calls: [{ id, name, input }] }
{ role: 'tool',      tool_call_id: string, content: string }
```

Translate these into your API's shape and return the upstream request:

```js
{
  transport: 'https',            // or 'http'
  options: { hostname, port, path, method, headers },  // node http(s) options
  body: '<request payload string>',
}
```

`buildRequest` is `async`, so a provider can do work first — e.g. exchange a
token (see `copilot.js`) or sign the request.

### `createParser()`

Returns a stateful parser applied to each upstream SSE `data:` payload:

- `feed(data) → [events]` — called per line; emit text as it streams.
- `flush() → [events]` — called at stream end; emit accumulated tool calls.

Unified events:

```js
{ type: 'text', text: string }              // streamed assistant text
{ type: 'tool', id, name, input }           // a complete tool call
```

`server.js` forwards these to the browser and appends `{ type: 'done' }`.
Upstream/transport failures become `{ type: 'error', error }` automatically.

## Adding a provider

1. Create `providers/<name>.js` exporting the interface above. If your API is
   OpenAI-compatible, reuse `createOpenAICompatible` from
   `openai-compatible.js` and supply only the endpoint + auth (see
   `openai.js`, `openrouter.js`, `ollama.js`, `llamacpp.js`, `copilot.js`).
2. Register it in `index.js`:

   ```js
   const providers = { /* ... */ myprovider: require('./myprovider') };
   ```

3. Run it with `PROVIDER=myprovider node server.js`.

## Included providers

| File | Provider | Notes |
|---|---|---|
| `anthropic.js` | Anthropic Messages API | Native translation + SSE parser |
| `openai.js` | OpenAI Chat Completions | Built on `openai-compatible.js` |
| `openrouter.js` | OpenRouter gateway | OpenAI-compatible; `OPENROUTER_API_KEY`; live model list reports `context_length` |
| `ollama.js` | Local Ollama | OpenAI-compatible; `OLLAMA_URL` / `OLLAMA_MODEL` |
| `llamacpp.js` | Local llama.cpp (`llama-server`) | OpenAI-compatible; `LLAMACPP_URL`; context window from `/props` |
| `copilot.js` | GitHub Copilot | OpenAI-compatible + OAuth→session token exchange (experimental) |

`openai-compatible.js`, `util.js`, and `copilot-auth.js` (GitHub device-flow
login used by `copilot.js`) are shared helpers, not providers.

> **Bedrock / other event-stream APIs:** the interface already fits them —
> sign the request inside `buildRequest` and decode the wire format inside
> `createParser` (reusing another provider's message translation if the body
> shape matches, e.g. Bedrock Claude reusing Anthropic's).
