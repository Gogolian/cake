'use strict';

// Anthropic Messages API provider.
// https://docs.anthropic.com/en/api/messages

const { safeParse, resolveSystem, getJson } = require('./util');

// Curated fallback list (context window is 200K for current Claude models).
// Used when the live /v1/models call is unavailable so the picker still works.
const KNOWN_MODELS = [
  { id: 'claude-opus-4-5', maxContext: 200000 },
  { id: 'claude-sonnet-4-5', maxContext: 200000 },
  { id: 'claude-3-5-haiku-latest', maxContext: 200000 },
];

// Unified message history -> Anthropic `messages` array.
// Consecutive tool results are merged into a single user turn, as the API
// requires all tool_result blocks for one assistant turn to share a message.
function toMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content };
      const last = out[out.length - 1];
      if (last && last._toolResults) last.content.push(block);
      else out.push({ role: 'user', content: [block], _toolResults: true });
    } else if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls || []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input || {} });
      }
      out.push({ role: 'assistant', content });
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }
  // Drop the internal grouping flag before sending.
  return out.map(({ _toolResults, ...m }) => m);
}

// Canonical tool definition -> Anthropic tool definition.
function toTool(t) {
  return { name: t.name, description: t.description, input_schema: t.parameters };
}

module.exports = {
  id: 'anthropic',
  label: 'Anthropic',

  isConfigured() {
    return !!process.env.ANTHROPIC_API_KEY;
  },

  model() {
    return process.env.ANTHROPIC_MODEL || 'claude-opus-4-5';
  },

  // Discover models from the live API, falling back to the curated list. Only
  // attempted when a key is present; returns [] otherwise so an unconfigured
  // provider simply doesn't appear in the picker.
  async listModels() {
    if (!this.isConfigured()) return [];
    try {
      const data = await getJson({
        transport: 'https',
        hostname: 'api.anthropic.com',
        path: '/v1/models?limit=1000',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
        },
      });
      const models = (data.data || [])
        .filter((m) => m && m.id)
        .map((m) => ({ id: m.id, maxContext: 200000 }));
      if (models.length) return models;
    } catch (_) { /* fall back to the curated list below */ }
    return KNOWN_MODELS;
  },

  async buildRequest({ messages, tools, system, model, maxTokens }) {
    const payload = JSON.stringify({
      model: model || this.model(),
      max_tokens: maxTokens || 4096,
      stream: true,
      system: resolveSystem(system),
      messages: toMessages(messages),
      tools: (tools || []).map(toTool),
    });
    return {
      transport: 'https',
      options: {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
        },
      },
      body: payload,
    };
  },

  // Stateful parser: Anthropic SSE events -> unified events.
  createParser() {
    const calls = [];
    return {
      feed(data) {
        const events = [];
        let ev;
        try { ev = JSON.parse(data); } catch (_) { return events; }
        if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
          calls[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, json: '' };
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') {
            events.push({ type: 'text', text: ev.delta.text });
          } else if (ev.delta.type === 'input_json_delta' && calls[ev.index]) {
            calls[ev.index].json += ev.delta.partial_json;
          }
        }
        return events;
      },
      flush() {
        return calls.filter(Boolean).map((c) => ({
          type: 'tool', id: c.id, name: c.name, input: safeParse(c.json),
        }));
      },
    };
  },
};
