'use strict';

// Provider registry.
//
// Every provider exposes the same unified interface, so the rest of the app
// never needs to know how a given API is shaped:
//
//   id            string   – short identifier
//   label         string   – human-readable name
//   isConfigured()         – has the credentials/config it needs
//   model()                – active model name
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

// Auto-detection order for key-based providers when PROVIDER is not set.
const AUTO_ORDER = ['anthropic', 'openai', 'copilot'];

// Pick the active provider: an explicit PROVIDER wins, otherwise the first
// configured provider in AUTO_ORDER, falling back to anthropic.
function select() {
  const forced = process.env.PROVIDER;
  if (forced) {
    if (providers[forced]) return providers[forced];
    throw new Error('Unknown PROVIDER: ' + forced);
  }
  for (const id of AUTO_ORDER) {
    if (providers[id].isConfigured()) return providers[id];
  }
  return providers.anthropic;
}

module.exports = { providers, select };
