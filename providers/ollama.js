'use strict';

// Ollama provider — talks to a local Ollama server through its
// OpenAI-compatible endpoint, so it reuses the OpenAI translation/parsing.
//
// Configure the base URL with OLLAMA_URL (default http://127.0.0.1:11434)
// and the default model with OLLAMA_MODEL (default llama3.1). Ollama needs no
// key; it's enabled by default and simply contributes no models to the picker
// when the local server isn't running.

const { createOpenAICompatible } = require('./openai-compatible');
const { getJson } = require('./util');

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

  // List the models actually installed on the local Ollama server. Ollama's
  // tag listing doesn't expose a context window, so fall back to a sane default
  // (overridable with OLLAMA_NUM_CTX). Returns [] when the server is down.
  async listModels() {
    const u = baseUrl();
    try {
      const data = await getJson({
        transport: u.protocol === 'https:' ? 'https' : 'http',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: '/api/tags',
      });
      const maxContext = Number(process.env.OLLAMA_NUM_CTX) || 8192;
      return (data.models || [])
        .filter((m) => m && m.name)
        .map((m) => ({ id: m.name, maxContext }));
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
    return {};
  },
});
