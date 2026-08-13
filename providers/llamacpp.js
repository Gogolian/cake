'use strict';

// llama.cpp provider — talks to a local llama-server through its
// OpenAI-compatible endpoint, so it reuses the OpenAI translation/parsing.
//
// Configure the base URL with LLAMACPP_URL (default http://127.0.0.1:8080) and
// the default model label with LLAMACPP_MODEL. llama-server usually needs no
// key; set LLAMACPP_API_KEY only if you started it with --api-key. Like Ollama,
// it's an opt-in local provider and simply contributes no models to the picker
// when the server isn't running.

const { createOpenAICompatible } = require('./openai-compatible');
const { getJson } = require('./util');

function baseUrl() {
  return new URL(process.env.LLAMACPP_URL || 'http://127.0.0.1:8080');
}

// Optional token auth, sent only when the server was started with --api-key.
function authHeaders() {
  const key = process.env.LLAMACPP_API_KEY;
  return key ? { Authorization: 'Bearer ' + key } : {};
}

// A getJson-ready request for a llama-server path, carrying any auth header.
function request(path) {
  const u = baseUrl();
  return {
    transport: u.protocol === 'https:' ? 'https' : 'http',
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path,
    headers: authHeaders(),
  };
}

module.exports = createOpenAICompatible({
  id: 'llamacpp',
  label: 'llama.cpp',

  isConfigured() {
    // No credentials to check; require an explicit opt-in.
    return process.env.PROVIDER === 'llamacpp' || !!process.env.LLAMACPP_URL;
  },

  model() {
    return process.env.LLAMACPP_MODEL || 'llama.cpp';
  },

  // llama-server hosts a single model and reports it at /v1/models. A model's
  // trained context (n_ctx_train) can far exceed the window the server was
  // actually started with (-c/--ctx-size), so prefer the runtime n_ctx from
  // /props for an accurate context meter. Returns [] when the server is down,
  // so llama.cpp only appears in the picker once it's reachable.
  async listModels() {
    try {
      const data = await getJson(request('/v1/models'));
      const models = (data.data || []).filter((m) => m && m.id);
      if (!models.length) return [];

      // Runtime context window the server is actually configured with.
      let runtimeCtx = 0;
      try {
        const props = await getJson(request('/props'));
        const gen = props.default_generation_settings || {};
        runtimeCtx = Number(gen.n_ctx) || Number(props.n_ctx) || 0;
      } catch (_) { /* /props may be gated or absent; fall back below */ }

      const fallback = Number(process.env.LLAMACPP_NUM_CTX) || 4096;
      return models.map((m) => ({
        id: m.id,
        maxContext: runtimeCtx || (m.meta && Number(m.meta.n_ctx_train)) || fallback,
      }));
    } catch (_) {
      return [];
    }
  },

  endpoint() {
    const u = baseUrl();
    return {
      transport: u.protocol === 'https:' ? 'https' : 'http',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: '/v1/chat/completions',
    };
  },

  headers() {
    return authHeaders();
  },
});
