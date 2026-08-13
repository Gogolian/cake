'use strict';

// Shared helpers used by every provider. Kept tiny and dependency-free.

const http = require('http');
const https = require('https');

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

// Minimal GET → parsed JSON, used by providers to discover available models.
// Never hangs: a short timeout aborts a stuck request so `/api/config` stays
// responsive even when a backend (e.g. a local Ollama) is unreachable.
// Rejects on transport error, timeout, HTTP >= 400, or invalid JSON — callers
// are expected to catch and fall back gracefully.
function getJson(opts) {
  return new Promise((resolve, reject) => {
    const client = opts.transport === 'http' ? http : https;
    const req = client.request({
      hostname: opts.hostname,
      port: opts.port,
      path: opts.path,
      method: 'GET',
      headers: opts.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode)); return; }
        try { resolve(JSON.parse(body)); }
        catch (_) { reject(new Error('Invalid JSON')); }
      });
    });
    req.setTimeout(opts.timeoutMs || 2000, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

module.exports = { DEFAULT_SYSTEM, safeParse, resolveSystem, getJson };
