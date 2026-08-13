'use strict';

// Ollama provider — talks to a local Ollama server through its
// OpenAI-compatible endpoint, so it reuses the OpenAI translation/parsing.
//
// Configure the base URL with OLLAMA_URL (default http://127.0.0.1:11434)
// and the model with OLLAMA_MODEL (default llama3.1). Ollama needs no key,
// so it is only selected when PROVIDER=ollama is set explicitly.

const { createOpenAICompatible } = require('./openai-compatible');

function baseUrl() {
  return new URL(process.env.OLLAMA_URL || 'http://127.0.0.1:11434');
}

module.exports = createOpenAICompatible({
  id: 'ollama',
  label: 'Ollama',

  isConfigured() {
    // No credentials to check; require an explicit opt-in.
    return process.env.PROVIDER === 'ollama' || !!process.env.OLLAMA_URL;
  },

  model() {
    return process.env.OLLAMA_MODEL || 'llama3.1';
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
    return {};
  },
});
