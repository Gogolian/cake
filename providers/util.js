'use strict';

// Shared helpers used by every provider. Kept tiny and dependency-free.

const DEFAULT_SYSTEM = 'You are a helpful coding assistant.';

// Parse JSON without throwing. Returns {} on failure so a malformed tool
// argument stream never crashes the harness.
function safeParse(json) {
  try { return JSON.parse(json); } catch (_) { return {}; }
}

// Resolve the system prompt: explicit value wins, then SYSTEM_PROMPT env,
// then the built-in default.
function resolveSystem(explicit) {
  return explicit || process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM;
}

module.exports = { DEFAULT_SYSTEM, safeParse, resolveSystem };
