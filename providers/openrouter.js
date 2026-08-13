'use strict';

// OpenRouter provider — a single gateway to many hosted models (OpenAI,
// Anthropic, Google, Meta, ...), exposed through an OpenAI-compatible API, so
// it reuses the OpenAI translation/parsing.
//
// Requires OPENROUTER_API_KEY; the default model is set with OPENROUTER_MODEL.
// OpenRouter can attribute requests to your app on its public leaderboards via
// the HTTP-Referer / X-Title headers — set OPENROUTER_SITE_URL /
// OPENROUTER_APP_NAME to populate them (both optional).

const { createOpenAICompatible } = require('./openai-compatible');
const { getJson } = require('./util');

const HOST = 'openrouter.ai';

// Curated fallback list used when the live /models call is unavailable, so the
// picker still offers a few sensible choices.
const KNOWN_MODELS = [
  { id: 'openai/gpt-4o', maxContext: 128000 },
  { id: 'anthropic/claude-3.5-sonnet', maxContext: 200000 },
  { id: 'google/gemini-2.0-flash-001', maxContext: 1000000 },
  { id: 'meta-llama/llama-3.1-70b-instruct', maxContext: 131072 },
];

// Optional app-attribution headers for OpenRouter's leaderboards (both blank by
// default; requests work fine without them).
function attributionHeaders() {
  const h = {};
  if (process.env.OPENROUTER_SITE_URL) h['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL;
  if (process.env.OPENROUTER_APP_NAME) h['X-Title'] = process.env.OPENROUTER_APP_NAME;
  return h;
}

module.exports = createOpenAICompatible({
  id: 'openrouter',
  label: 'OpenRouter',

  isConfigured() {
    return !!process.env.OPENROUTER_API_KEY;
  },

  model() {
    return process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
  },

  // Discover models from the live API, falling back to the curated list. Only
  // attempted when a key is present; returns [] otherwise so an unconfigured
  // provider simply doesn't appear in the picker. OpenRouter reports each
  // model's context_length, so the picker's maximum is accurate.
  async listModels() {
    if (!this.isConfigured()) return [];
    try {
      const data = await getJson({
        transport: 'https',
        hostname: HOST,
        path: '/api/v1/models',
        headers: { Authorization: 'Bearer ' + (process.env.OPENROUTER_API_KEY || '') },
      });
      const models = (data.data || [])
        .filter((m) => m && m.id)
        .map((m) => ({ id: m.id, maxContext: Number(m.context_length) || 0 }))
        .sort((a, b) => a.id.localeCompare(b.id));
      if (models.length) return models;
    } catch (_) { /* fall back to the curated list below */ }
    return KNOWN_MODELS;
  },

  endpoint() {
    return { transport: 'https', hostname: HOST, path: '/api/v1/chat/completions' };
  },

  headers() {
    return Object.assign(
      { Authorization: 'Bearer ' + (process.env.OPENROUTER_API_KEY || '') },
      attributionHeaders(),
    );
  },
});
