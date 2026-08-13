'use strict';

// GitHub Copilot provider (experimental).
//
// Copilot's chat endpoint is OpenAI-compatible, so message translation and
// SSE parsing are reused from the OpenAI base. The only extra work is auth:
// a GitHub OAuth token is exchanged for a short-lived Copilot session token.
//
// OAuth token is read from (in order):
//   - env GITHUB_COPILOT_TOKEN / GH_COPILOT_TOKEN / GITHUB_TOKEN / GH_TOKEN
//   - ~/.config/github-copilot/apps.json or hosts.json (the files the
//     official Copilot editor plugins write)
//
// Only selected when PROVIDER=copilot is set explicitly.

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createOpenAICompatible } = require('./openai-compatible');

const EDITOR_HEADERS = {
  'Editor-Version': 'cake/0.1.0',
  'Editor-Plugin-Version': 'cake/0.1.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'User-Agent': 'cake/0.1.0',
};

let session = null; // { token, expiresAt } cached session token

function readOAuthToken() {
  const envToken = process.env.GITHUB_COPILOT_TOKEN || process.env.GH_COPILOT_TOKEN
    || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) return envToken;

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
  return null;
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
          reject(new Error('Copilot token exchange failed (' + res.statusCode + '): ' + body));
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
    throw new Error('No GitHub Copilot token found. Set GITHUB_COPILOT_TOKEN or sign in with an editor Copilot plugin.');
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
