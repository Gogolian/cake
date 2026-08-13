'use strict';

// GitHub Copilot provider (experimental).
//
// Copilot's chat endpoint is OpenAI-compatible, so message translation and
// SSE parsing are reused from the OpenAI base. The only extra work is auth:
// a GitHub OAuth token is exchanged for a short-lived Copilot session token.
//
// OAuth token is read from (in order):
//   - env GITHUB_COPILOT_TOKEN / GH_COPILOT_TOKEN (Copilot-specific, explicit)
//   - the token cake saved via `node server.js --login` (device flow)
//   - ~/.config/github-copilot/apps.json or hosts.json (the files the
//     official Copilot editor plugins write)
//   - env GITHUB_TOKEN / GH_TOKEN (generic, ambient — last resort)
//
// The generic GITHUB_TOKEN / GH_TOKEN come last on purpose: shells, the gh
// CLI, Codespaces and CI routinely export them as tokens that are NOT enabled
// for Copilot. If they were consulted first they would shadow the token a user
// just obtained via `--login`, and the exchange below would keep failing with a
// 404 no matter how many times the user signed in.
//
// Only selected when PROVIDER=copilot is set explicitly.

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createOpenAICompatible } = require('./openai-compatible');
const { EDITOR_HEADERS, readSavedToken } = require('./copilot-auth');

let session = null; // { token, expiresAt } cached session token

function readOAuthToken() {
  // 1. A token the user explicitly provided for Copilot always wins.
  const copilotEnv = process.env.GITHUB_COPILOT_TOKEN || process.env.GH_COPILOT_TOKEN;
  if (copilotEnv) return copilotEnv;

  // 2. Token obtained through cake's own device-flow login.
  const saved = readSavedToken();
  if (saved) return saved;

  // 3. Tokens written by the official Copilot editor plugins.
  const dir = path.join(os.homedir(), '.config', 'github-copilot');
  for (const name of ['apps.json', 'hosts.json']) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      for (const key of Object.keys(data)) {
        // Keys are the host, optionally suffixed with an app id, e.g.
        // "github.com" or "github.com:Iv1.<app-id>". Match the host exactly.
        const host = key.split(':')[0];
        if (host === 'github.com' && data[key] && data[key].oauth_token) {
          return data[key].oauth_token;
        }
      }
    } catch (_) { /* file missing or unreadable — try the next one */ }
  }

  // 4. Last resort: a generic ambient GitHub token. These are frequently set
  // by the shell, gh CLI, Codespaces or CI to a token that is NOT enabled for
  // Copilot, so they must never shadow the explicit sources above — otherwise a
  // successful `--login` would still fail the token exchange with a 404. Kept
  // only for users who deliberately point them at a Copilot-capable token.
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

// GET https://api.github.com/copilot_internal/v2/token -> { token, expires_at }
function fetchSessionToken(oauth) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: '/copilot_internal/v2/token',
      method: 'GET',
      headers: Object.assign({
        Authorization: 'token ' + oauth,
        Accept: 'application/json',
      }, EDITOR_HEADERS),
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          let hint = '';
          if (res.statusCode === 401) {
            hint = ' — the GitHub token is invalid or expired; run `node server.js --login` to sign in again.';
          } else if (res.statusCode === 404) {
            // The endpoint returns 404 (not 403) when the token itself is valid
            // but not entitled to Copilot — typically an ambient GITHUB_TOKEN /
            // GH_TOKEN or a personal access token rather than a device-flow login.
            hint = ' — this GitHub token is not enabled for Copilot. Ambient'
              + ' GITHUB_TOKEN / GH_TOKEN env vars and personal access tokens do'
              + ' not work here. Run `node server.js --login` to sign in with a'
              + ' Copilot-enabled account, or unset GITHUB_TOKEN / GH_TOKEN.';
          }
          reject(new Error('Copilot token exchange failed (' + res.statusCode + '): ' + body + hint));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Copilot token exchange returned invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getSessionToken() {
  const now = Math.floor(Date.now() / 1000);
  if (session && session.expiresAt - 60 > now) return session.token;

  const oauth = readOAuthToken();
  if (!oauth) {
    throw new Error('No GitHub Copilot token found. Run `node server.js --login` to sign in, set GITHUB_COPILOT_TOKEN, or sign in with an editor Copilot plugin.');
  }
  const data = await fetchSessionToken(oauth);
  session = { token: data.token, expiresAt: data.expires_at || (now + 300) };
  return session.token;
}

module.exports = createOpenAICompatible({
  id: 'copilot',
  label: 'GitHub Copilot',

  isConfigured() {
    return process.env.PROVIDER === 'copilot' || !!readOAuthToken();
  },

  model() {
    return process.env.COPILOT_MODEL || 'gpt-4o';
  },

  endpoint() {
    return { transport: 'https', hostname: 'api.githubcopilot.com', path: '/chat/completions' };
  },

  async headers() {
    const token = await getSessionToken();
    return Object.assign({ Authorization: 'Bearer ' + token }, EDITOR_HEADERS);
  },
});
