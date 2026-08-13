'use strict';

// Provider registry.
//
// Every provider exposes the same unified interface, so the rest of the app
// never needs to know how a given API is shaped:
//
//   id            string   – short identifier
//   label         string   – human-readable name
//   isConfigured()         – has the credentials/config it needs
//   model()                – default model name
//   listModels()           – async -> [{ id, maxContext }] available models
//   buildRequest(req)      – async -> { transport, options, body } upstream call
//   createParser()         – stateful { feed(data), flush() } SSE -> unified events
//
// Add a provider by dropping a file in this folder and registering it below.

const providers = {
  anthropic: require('./anthropic'),
  openai: require('./openai'),
  ollama: require('./ollama'),
  copilot: require('./copilot'),
};

// Display / auto-detection order.
const ORDER = ['anthropic', 'openai', 'ollama', 'copilot'];

// Pick the active provider for a chat request. An explicit id (from the UI's
// model picker) wins; otherwise fall back to a PROVIDER env override, then the
// first configured provider, then anthropic. Every provider is always loaded —
// the app never needs to be started "as" one particular provider.
function select(id) {
  const wanted = id || process.env.PROVIDER;
  if (wanted) {
    if (providers[wanted]) return providers[wanted];
    throw new Error('Unknown provider: ' + wanted);
  }
  for (const pid of ORDER) {
    if (providers[pid].isConfigured()) return providers[pid];
  }
  return providers.anthropic;
}

// All providers in display order.
function list() {
  return ORDER.map((id) => providers[id]);
}

// Cached snapshot of every provider and the models it currently offers, used by
// the UI to build the model picker. Discovery hits each backend's network, so
// the result is cached briefly; clearCache() forces a refresh (e.g. right after
// a Copilot sign-in makes new models available).
let cache = { at: 0, data: null };
const CACHE_MS = 60000;

async function available() {
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_MS) return cache.data;
  const data = await Promise.all(list().map(async (p) => {
    let models = [];
    try { models = await p.listModels(); } catch (_) { models = []; }
    return {
      id: p.id,
      label: p.label,
      configured: !!p.isConfigured(),
      defaultModel: p.model(),
      models: Array.isArray(models) ? models : [],
    };
  }));
  cache = { at: now, data };
  return data;
}

function clearCache() {
  cache = { at: 0, data: null };
}

module.exports = { providers, select, list, available, clearCache };
