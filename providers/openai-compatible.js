'use strict';

// Reusable building blocks for any provider that speaks the OpenAI
// Chat Completions API (OpenAI, OpenRouter, Ollama, llama.cpp, GitHub Copilot, ...).
//
// A concrete provider only needs to supply endpoint + auth details; the
// message/tool translation and SSE parsing are identical and live here.

const { safeParse, resolveSystem } = require('./util');

// Unified message history -> OpenAI `messages` array.
function toMessages(messages, system) {
  const out = [{ role: 'system', content: resolveSystem(system) }];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null };
      if (m.tool_calls && m.tool_calls.length) {
        msg.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) },
        }));
      }
      out.push(msg);
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }
  return out;
}

// Canonical tool definition -> OpenAI tool definition.
function toTool(t) {
  return {
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

// Stateful parser: OpenAI SSE deltas -> unified events.
// Text is emitted live; tool calls are accumulated and emitted on flush().
function createParser() {
  const calls = [];
  return {
    feed(data) {
      const events = [];
      let ev;
      try { ev = JSON.parse(data); } catch (_) { return events; }
      const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
      if (!delta) return events;
      if (delta.content) events.push({ type: 'text', text: delta.content });
      for (const tc of delta.tool_calls || []) {
        const i = tc.index || 0;
        if (!calls[i]) calls[i] = { id: '', name: '', json: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function && tc.function.name) calls[i].name += tc.function.name;
        if (tc.function && tc.function.arguments) calls[i].json += tc.function.arguments;
      }
      return events;
    },
    flush() {
      return calls.filter(Boolean).map((c) => ({
        type: 'tool', id: c.id, name: c.name, input: safeParse(c.json),
      }));
    },
  };
}

// Build a provider object from a small config.
//   id, label           – identity
//   model()             – active model name (usually env-overridable)
//   isConfigured()      – whether the provider has what it needs to run
//   endpoint()          – async|sync -> { transport, hostname, port, path }
//   headers()           – async|sync -> extra request headers (auth, etc.)
//   listModels()        – optional async -> [{ id, maxContext }] for the picker
function createOpenAICompatible(config) {
  return {
    id: config.id,
    label: config.label,
    isConfigured: config.isConfigured,
    model: config.model,
    listModels: config.listModels || (async () => []),

    async buildRequest({ messages, tools, system, model, maxTokens }) {
      const payload = {
        model: model || config.model(),
        stream: true,
        max_tokens: maxTokens || 4096,
        messages: toMessages(messages, system),
        tools: (tools || []).map(toTool),
      };
      const ep = await config.endpoint();
      const headers = Object.assign(
        { 'Content-Type': 'application/json' },
        await config.headers(),
      );
      return {
        transport: ep.transport || 'https',
        options: {
          hostname: ep.hostname,
          port: ep.port,
          path: ep.path,
          method: 'POST',
          headers,
        },
        body: JSON.stringify(payload),
      };
    },

    createParser,
  };
}

module.exports = { createOpenAICompatible, toMessages, toTool, createParser };
