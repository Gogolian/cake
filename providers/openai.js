'use strict';

// OpenAI Chat Completions API provider.

const { createOpenAICompatible } = require('./openai-compatible');
const { getJson } = require('./util');

// Curated fallback list used when the live /v1/models call is unavailable.
const KNOWN_MODELS = [
  { id: 'gpt-4o', maxContext: 128000 },
  { id: 'gpt-4o-mini', maxContext: 128000 },
  { id: 'gpt-4-turbo', maxContext: 128000 },
  { id: 'o1', maxContext: 200000 },
  { id: 'o1-mini', maxContext: 128000 },
  { id: 'gpt-3.5-turbo', maxContext: 16385 },
];

// Best-effort context window from a model id (the API doesn't report it).
function contextFor(id) {
  if (/^(o1|o3|o4)/.test(id)) return /mini/.test(id) ? 128000 : 200000;
  if (id.startsWith('gpt-4o') || id.startsWith('gpt-4.1') || id.startsWith('chatgpt-4o')) return 128000;
  if (id.startsWith('gpt-4-32k')) return 32768;
  if (id.startsWith('gpt-4-turbo') || /gpt-4-(0125|1106|turbo)/.test(id)) return 128000;
  if (id.startsWith('gpt-4')) return 8192;
  if (id.startsWith('gpt-3.5')) return 16385;
  return 128000;
}

// Keep only conversational chat models; drop embeddings, audio, image, etc.
function isChatModel(id) {
  if (!/^(gpt-|o1|o3|o4|chatgpt)/.test(id)) return false;
  return !/(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|dall-e|whisper)/.test(id);
}

module.exports = createOpenAICompatible({
  id: 'openai',
  label: 'OpenAI',

  isConfigured() {
    return !!process.env.OPENAI_API_KEY;
  },

  model() {
    return process.env.OPENAI_MODEL || 'gpt-4o';
  },

  // Discover chat models from the live API, falling back to the curated list.
  async listModels() {
    if (!this.isConfigured()) return [];
    try {
      const data = await getJson({
        transport: 'https',
        hostname: 'api.openai.com',
        path: '/v1/models',
        headers: { Authorization: 'Bearer ' + (process.env.OPENAI_API_KEY || '') },
      });
      const models = (data.data || [])
        .map((m) => m && m.id)
        .filter((id) => id && isChatModel(id))
        .sort()
        .map((id) => ({ id, maxContext: contextFor(id) }));
      if (models.length) return models;
    } catch (_) { /* fall back to the curated list below */ }
    return KNOWN_MODELS;
  },

  endpoint() {
    return { transport: 'https', hostname: 'api.openai.com', path: '/v1/chat/completions' };
  },

  headers() {
    return { Authorization: 'Bearer ' + (process.env.OPENAI_API_KEY || '') };
  },
});
