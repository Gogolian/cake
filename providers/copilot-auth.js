'use strict';

// GitHub OAuth Device Flow for Copilot.
//
// Lets cake obtain a Copilot-capable GitHub OAuth token without a client
// secret, a redirect URL, or the official editor plugins: we ask GitHub for a
// device code, point the user at github.com/login/device to approve it, then
// poll until GitHub hands back the `ghu_…` OAuth token. That token is what
// copilot.js exchanges for a short-lived Copilot session token.
//
// This mirrors what the official editor plugins do. CLIENT_ID below is the
// first-party Copilot *public* client id (an app identifier, not a secret —
// safe to ship); it is the only identity GitHub grants Copilot access to, so a
// custom OAuth app would not work here.

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// First-party GitHub Copilot OAuth client id (public identifier, not a secret).
const CLIENT_ID = 'Iv1.b507a08c87ecfe98';

// Editor identification headers GitHub's Copilot endpoints expect.
const EDITOR_HEADERS = {
  'Editor-Version': 'cake/0.1.0',
  'Editor-Plugin-Version': 'cake/0.1.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'User-Agent': 'cake/0.1.0',
};

const DEVICE_CODE = { hostname: 'github.com', path: '/login/device/code' };
const ACCESS_TOKEN = { hostname: 'github.com', path: '/login/oauth/access_token' };
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

// ── diagnostics ─────────────────────────────────────────────────────────────
//
// Copilot auth failures (especially the token-exchange 404) are hard to debug
// blind: the same code path can send a device-flow token, an editor-plugin
// token, or an ambient GITHUB_TOKEN, and only one of them is Copilot-enabled.
// These helpers let the provider narrate what it is doing without ever leaking
// a secret.

// Verbose logging is opt-in via COPILOT_DEBUG (any truthy value) or a DEBUG
// value that mentions "copilot". Failure diagnostics are logged regardless (see
// the `force` argument to log()).
function debugEnabled() {
  const flag = process.env.COPILOT_DEBUG;
  if (flag && flag !== '0' && flag.toLowerCase() !== 'false') return true;
  return /(^|[,\s])copilot([,\s]|$)/i.test(process.env.DEBUG || '');
}

// Log a namespaced line to stderr. `force` bypasses the debug gate so failures
// are always visible, even without COPILOT_DEBUG set.
function log(msg, force) {
  if (force || debugEnabled()) console.error('[copilot] ' + msg);
}

// A safe, non-secret fingerprint of a token: its recognizable prefix — which
// reveals the *kind* of token (a device-flow `ghu_`, an OAuth `gho_`, or a
// personal-access `ghp_` / `github_pat_` that is not Copilot-enabled) — plus a
// coarse size band. Both are fixed labels chosen by comparison, so no byte or
// length of the token itself is ever emitted: safe to log or surface.
function fingerprint(token) {
  if (!token) return '(none)';
  const s = String(token);
  const known = ['github_pat_', 'gho_', 'ghu_', 'ghp_', 'ghs_', 'ghr_'];
  const kind = known.find((p) => s.startsWith(p)) || 'unrecognized-prefix';
  // Bucket the length via comparisons only — the exact count is never emitted,
  // but a wildly wrong size (e.g. an empty or newline-mangled token) still shows.
  const size = s.length < 20 ? 'under 20 chars'
    : s.length <= 50 ? '20-50 chars'
      : s.length <= 100 ? '51-100 chars'
        : 'over 100 chars';
  return kind + ' (' + size + ')';
}

// Where cake stores its own copy of the OAuth token. Deliberately separate
// from the editor plugins' ~/.config/github-copilot files so we never clobber
// them.
function tokenFilePath() {
  return path.join(os.homedir(), '.config', 'cake', 'copilot.json');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// JSON POST to github.com. Accept: application/json makes GitHub answer with
// JSON (otherwise these endpoints return form-encoded bodies). Resolves with
// { status, body } where body is the parsed JSON.
function postJson(target, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: target.hostname,
      path: target.path,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(data),
      }, EDITOR_HEADERS),
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (_) { reject(new Error('GitHub returned invalid JSON (' + res.statusCode + ')')); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// Step 1 — ask GitHub for a device + user code.
// -> { device_code, user_code, verification_uri, expires_in, interval }
async function requestDeviceCode() {
  log('device code → POST https://' + DEVICE_CODE.hostname + DEVICE_CODE.path);
  const { status, body } = await postJson(DEVICE_CODE, { client_id: CLIENT_ID, scope: 'read:user' });
  if (status !== 200 || !body.device_code) {
    throw new Error('Device code request failed (' + status + '): '
      + (body.error_description || body.error || JSON.stringify(body)));
  }
  log('device code ← HTTP ' + status + ' | verify at ' + body.verification_uri
    + ' | interval ' + body.interval + 's | expires in ' + body.expires_in + 's');
  return body;
}

// Step 3 — poll until the user approves in the browser (or the code expires).
// Resolves with the `ghu_…` OAuth token.
async function pollForToken(deviceCode, intervalSeconds) {
  let interval = (intervalSeconds || 5) * 1000;
  for (;;) {
    await sleep(interval);
    const { status, body } = await postJson(ACCESS_TOKEN, {
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: GRANT_TYPE,
    });
    if (body.access_token) {
      log('access token ← HTTP ' + status + ' | obtained OAuth token ' + fingerprint(body.access_token));
      return body.access_token;
    }
    log('access token ← HTTP ' + status + ' | ' + (body.error || 'no token yet'));
    switch (body.error) {
      case 'authorization_pending': break;         // not approved yet — keep waiting
      case 'slow_down': interval += 5000; break;    // GitHub asked us to back off
      case 'expired_token':
        throw new Error('The code expired before you approved it. Run login again.');
      case 'access_denied':
        throw new Error('Authorization was denied.');
      default:
        throw new Error('Login failed: ' + (body.error_description || body.error || 'unknown error'));
    }
  }
}

// Best-effort: open a URL in the user's default browser. Never throws — the
// user always has the printed URL to fall back on.
function openBrowser(url) {
  try {
    const p = process.platform;
    const cmd = p === 'darwin' ? 'open' : p === 'win32' ? 'cmd' : 'xdg-open';
    const args = p === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // ignore — e.g. no browser/launcher available
    child.unref();
  } catch (_) { /* ignore */ }
}

// Persist the OAuth token to cake's own config file, owner-readable only.
function saveToken(token) {
  const file = tokenFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ oauth_token: token }, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* tighten perms if it already existed */ }
  log('saved OAuth token ' + fingerprint(token) + ' to ' + file);
  return file;
}

// Read the token cake previously saved. Returns the token string or null.
function readSavedToken() {
  try {
    const data = JSON.parse(fs.readFileSync(tokenFilePath(), 'utf8'));
    return (data && data.oauth_token) || null;
  } catch (_) { return null; }
}

// Run the whole device flow. `onPrompt({ user_code, verification_uri })` is
// called once the code is ready so a CLI or the web UI can show it to the user.
// Resolves with { token, file }.
async function login(opts) {
  const onPrompt = opts && opts.onPrompt;
  const device = await requestDeviceCode();
  if (onPrompt) {
    onPrompt({ user_code: device.user_code, verification_uri: device.verification_uri });
  }
  const token = await pollForToken(device.device_code, device.interval);
  const file = saveToken(token);
  return { token, file };
}

module.exports = {
  CLIENT_ID,
  EDITOR_HEADERS,
  tokenFilePath,
  requestDeviceCode,
  pollForToken,
  openBrowser,
  saveToken,
  readSavedToken,
  login,
  log,
  debugEnabled,
  fingerprint,
};
