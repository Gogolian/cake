'use strict';

// OpenAI Chat Completions API provider.

const { createOpenAICompatible } = require('./openai-compatible');

module.exports = createOpenAICompatible({
  id: 'openai',
  label: 'OpenAI',

  isConfigured() {
    return !!process.env.OPENAI_API_KEY;
  },

  model() {
    return process.env.OPENAI_MODEL || 'gpt-4o';
  },

  endpoint() {
    return { transport: 'https', hostname: 'api.openai.com', path: '/v1/chat/completions' };
  },

  headers() {
    return { Authorization: 'Bearer ' + (process.env.OPENAI_API_KEY || '') };
  },
});
