#!/usr/bin/env node
'use strict';

// cake — minimal, dependency-free code-agent harness.
//
// The server is provider-agnostic: it asks the configured provider (see
// ./providers) to build the upstream request and to parse its stream into
// unified events, then relays those events to the browser as SSE. It knows
// nothing about any specific API shape.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const providers = require('./providers');
const tools = require('./tools');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const CORS = { 'Access-Control-Allow-Origin': '*' };

// ── static files ────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const rel = safePath === '/' || safePath === '.' ? 'index.html' : safePath;
  const file = path.join(PUBLIC_DIR, rel);
  // Resolved path must stay inside PUBLIC_DIR (block path traversal).
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── chat: relay provider stream as unified SSE events ───────────────────────

function sendEvent(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

function handleChat(body, res) {
  // Track a session file path if the client provided a session marker.
  // We create the file on first message and append subsequent user/assistant
  // turns to the same markdown file.
  let sessionFilePath = null;
  // Append one conversation turn.  toolCallId is stored in the header for tool
  // entries so the session can be fully reconstructed from the .md file alone.
  function appendSessionEntry(filePath, role, content, prov, mod, toolCallId) {
    if (!filePath || !content) return;
    const actor = role === 'user' ? 'human' : role === 'assistant' ? 'assistant' : role === 'tool' ? 'tool' : (role || 'other');
    const ts = new Date().toISOString();
    const meta = (prov || 'na') + '/' + (mod || 'na') + '/' + Math.ceil((content.length || 0) / 4);
    // tool entries carry the tool_call_id as a 3rd pipe-delimited field so the
    // parser can reconstruct tool_call_id without a separate JSON file.
    const headerExtra = (actor === 'tool' && toolCallId) ? ' | ' + toolCallId : '';
    const entry = '\n\n### ' + actor + ' | ' + meta + headerExtra + ' | ' + ts + '\n\n' + content + '\n';
    fs.appendFile(filePath, entry, (err) => { if (err) console.error('Failed to append session entry', err); });
  }
  try {
    const sessionMark = body && (body.session_start || body.sessionId || body.session);
    if (sessionMark) {
      const tsString = String(sessionMark);
      let d = new Date(Number(tsString));
      if (isNaN(d.getTime())) d = new Date(tsString);
      if (isNaN(d.getTime())) d = new Date();
      const year = String(d.getFullYear());
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const sessionsDir = path.join(__dirname, 'sessions', year, month, day);
      const filename = tsString + '.md';
      sessionFilePath = path.join(sessionsDir, filename);
      try { fs.mkdirSync(sessionsDir, { recursive: true }); } catch (err) { console.error('Failed to create sessions directory', err); }

      const providerInfo = (body.provider ? body.provider : '') + (body.model ? '/' + body.model : '');
      const nowIso = new Date().toISOString();
      const lastMsg = Array.isArray(body.messages) && body.messages.length ? body.messages[body.messages.length - 1] : null;
      const lastRole = lastMsg && lastMsg.role;
      const lastContent = lastMsg && lastMsg.content;


      if (!fs.existsSync(sessionFilePath)) {
        let md = '# Session started ' + nowIso + '\n\n'
          + '**Provider (requested):** ' + providerInfo + '\n\n'
          + '## Conversation\n\n';
        try { fs.writeFileSync(sessionFilePath, md); } catch (err) { console.error('Failed to write session file', err); }
        if (lastMsg && lastRole !== 'assistant' && lastContent) {
          const prov = lastRole === 'user' ? 'human' : (body.provider || 'na');
          const mod = lastRole === 'user' ? 'na' : (body.model || 'na');
          appendSessionEntry(sessionFilePath, lastRole, lastContent, prov, mod, lastMsg.tool_call_id || null);
        }
      } else if (lastMsg && lastRole !== 'assistant' && lastContent) {
        const prov = lastRole === 'user' ? 'human' : (body.provider || 'na');
        const mod = lastRole === 'user' ? 'na' : (body.model || 'na');
        appendSessionEntry(sessionFilePath, lastRole, lastContent, prov, mod, lastMsg.tool_call_id || null);
      }
    }
  } catch (e) {
    console.error('Error saving session file:', e);
  }

  let provider;
  try { provider = providers.select(body.provider); }
  catch (e) { res.writeHead(400, CORS); res.end(e.message); return; }

  const model = body.model || provider.model();

  res.writeHead(200, Object.assign({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  }, CORS));

  // Tell the browser which provider/model is actually answering, so it can
  // annotate the reply. Sent before the upstream call so the label appears
  // immediately, and so it still reflects reality when the server had to fall
  // back (e.g. no explicit selection).
  sendEvent(res, { type: 'meta', provider: provider.id, model });

  provider.buildRequest({
    messages: body.messages || [],
    tools: tools.definitions,
    system: body.system,
    model,
    maxTokens: body.max_tokens,
  }).then((upstreamReq) => {
    const client = upstreamReq.transport === 'http' ? http : https;
    const parser = provider.createParser();
    let assistantBuffer = '';

    const req = client.request(upstreamReq.options, (upstream) => {
      if (upstream.statusCode >= 400) {
        let errBody = '';
        upstream.on('data', (d) => { errBody += d; });
        upstream.on('end', () => {
          sendEvent(res, { type: 'error', error: 'Upstream ' + upstream.statusCode + ': ' + errBody });
          res.end();
        });
        return;
      }
      let buffer = '';
      // toolCallsBuffer captures tool-call metadata so it can be embedded in
      // the .md assistant entry for lossless session reconstruction.
      let toolCallsBuffer = [];
      upstream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          for (const evt of parser.feed(data)) {
            if (evt.type === 'text') assistantBuffer += evt.text;
            else if (evt.type === 'tool') toolCallsBuffer.push({ id: evt.id, name: evt.name, input: evt.input });
            sendEvent(res, evt);
          }
        }
      });
      upstream.on('end', () => {
        for (const evt of parser.flush()) {
          if (evt.type === 'text') assistantBuffer += evt.text;
          else if (evt.type === 'tool') toolCallsBuffer.push({ id: evt.id, name: evt.name, input: evt.input });
          sendEvent(res, evt);
        }
        try {
          if (sessionFilePath && (assistantBuffer.trim() || toolCallsBuffer.length)) {
            let content = assistantBuffer.trim();
            if (toolCallsBuffer.length) {
              const blocks = toolCallsBuffer.map(tc =>
                '**\u2192 ' + tc.name + '** `' + tc.id + '`\n```json\n' + JSON.stringify(tc.input, null, 2) + '\n```'
              ).join('\n\n');
              content += (content ? '\n\n' : '') + blocks;
            }
            appendSessionEntry(sessionFilePath, 'assistant', content || '(tool call)', provider && provider.id ? provider.id : 'na', model || 'na');
          }
        } catch (e) { console.error('Failed to persist assistant text:', e); }
        sendEvent(res, { type: 'done' });
        res.end();
      });
    });
    req.on('error', (e) => { sendEvent(res, { type: 'error', error: e.message }); res.end(); });
    req.end(upstreamReq.body);
  }).catch((e) => {
    sendEvent(res, { type: 'error', error: e.message });
    res.end();
  });
}

// ── session management helpers ───────────────────────────────────────────────

function sessionMdPath(id) {
  const d = new Date(Number(id));
  const year  = String(d.getFullYear());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day   = String(d.getDate()).padStart(2, '0');
  return path.join(__dirname, 'sessions', year, month, day, id + '.md');
}

// Parse a session .md file back into a provider-neutral history array.
// Handles both old entries (no tool_call_id) and new ones (with it).
function parseMdHistory(text) {
  const history = [];
  const headerRe = /^### (human|assistant|tool)\s*\|(.+)$/gm;
  const headers = [];
  let m;
  while ((m = headerRe.exec(text)) !== null) {
    headers.push({ actor: m[1], meta: m[2], pos: m.index, bodyStart: m.index + m[0].length });
  }
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const nextPos = i + 1 < headers.length ? headers[i + 1].pos : text.length;
    const body = text.slice(h.bodyStart, nextPos).replace(/^\n+/, '').replace(/\n+$/, '');
    const parts = h.meta.split('|').map(s => s.trim());
    if (h.actor === 'human') {
      if (body) history.push({ role: 'user', content: body });
    } else if (h.actor === 'assistant') {
      // Parse **→ name** `id` + fenced-json blocks written by appendSessionEntry
      const toolBlockRe = /\*\*\u2192 ([^\n*`]+)\*\* `([^\n`]+)`\n```json\n([\s\S]*?)\n```/g;
      const tool_calls = [];
      let tcm;
      while ((tcm = toolBlockRe.exec(body)) !== null) {
        try { tool_calls.push({ name: tcm[1].trim(), id: tcm[2], input: JSON.parse(tcm[3]) }); } catch (_) {}
      }
      const cleanBody = body.replace(/\n*\*\*\u2192 [^\n*`]+\*\* `[^\n`]+`\n```json\n[\s\S]*?\n```/g, '').trim();
      const entry = { role: 'assistant', content: cleanBody };
      if (tool_calls.length) entry.tool_calls = tool_calls;
      history.push(entry);
    } else if (h.actor === 'tool') {
      // Only include tool results if we have a tool_call_id to link them —
      // sending orphan tool entries breaks every provider's validation.
      // Future entries use format: ### tool | <meta> | <tool_call_id> | <ts>
      if (parts.length >= 3) {
        history.push({ role: 'tool', tool_call_id: parts[1], content: body });
      }
    }
  }
  return history;
}

// Recursively collect all .md session files and return metadata sorted newest-first.
function listSessionFiles() {
  const sessionsDir = path.join(__dirname, 'sessions');
  const files = [];
  function scan(dir, parts) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        scan(path.join(dir, entry.name), [...parts, entry.name]);
      } else if (entry.name.endsWith('.md')) {
        const id = entry.name.slice(0, -3);
        if (!/^\d+$/.test(id)) continue;
        const [year, month, day] = parts.length >= 3 ? parts.slice(-3) : [];
        files.push({
          id,
          filePath: path.join(dir, entry.name),
          date: (year && month && day) ? (year + '-' + month + '-' + day) : null,
        });
      }
    }
  }
  scan(sessionsDir, []);
  files.sort((a, b) => Number(b.id) - Number(a.id));
  return files;
}

// Extract the first human message text from a session markdown file (first 1200 bytes).
function extractSessionTitle(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(1200);
    const n = fs.readSync(fd, buf, 0, 1200, 0);
    fs.closeSync(fd);
    const text = buf.slice(0, n).toString('utf8');
    const m = text.match(/###\s+human\s+\|[^\n]*\n\n([\s\S]+?)(?:\n\n###|$)/);
    if (m) return m[1].trim().replace(/\s+/g, ' ').slice(0, 80);
  } catch (_) {}
  return null;
}

function handleGetSessions(res) {
  const files = listSessionFiles();
  const result = files.map((f) => ({
    id: f.id,
    date: f.date,
    title: extractSessionTitle(f.filePath),
  }));
  sendJson(res, result);
}

function handleGetSession(id, res) {
  if (!id || !/^\d+$/.test(id)) { res.writeHead(400); res.end('Invalid id'); return; }
  const mdPath = sessionMdPath(id);
  try {
    const text = fs.readFileSync(mdPath, 'utf8');
    sendJson(res, { id, history: parseMdHistory(text) });
  } catch (_) {
    sendJson(res, { id, history: [] });
  }
}

// ── copilot login: device flow relayed to the browser as SSE ────────────────

function handleLogin(res) {
  const auth = require('./providers/copilot-auth');
  res.writeHead(200, Object.assign({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  }, CORS));
  auth.login({
    onPrompt({ user_code, verification_uri }) {
      auth.openBrowser(verification_uri);
      sendEvent(res, { type: 'prompt', user_code, verification_uri });
    },
  }).then(() => {
    // A fresh token means Copilot's models just became available; drop the
    // cached snapshot so the next /api/config reflects them.
    providers.clearCache();
    sendEvent(res, { type: 'done' });
    res.end();
  }).catch((e) => {
    sendEvent(res, { type: 'error', error: e.message });
    res.end();
  });
}

// ── router ──────────────────────────────────────────────────────────────────

function readBody(req, cb) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString())); }
    catch (e) { cb(e); }
  });
}

function sendJson(res, obj) {
  res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS));
  res.end(JSON.stringify(obj));
}

// ── entry point ──────────────────────────────────────────────────────────────

// `node server.js --login` runs the GitHub Copilot device-flow login and exits
// instead of starting the server.
function runLogin() {
  const auth = require('./providers/copilot-auth');
  auth.login({
    onPrompt({ user_code, verification_uri }) {
      console.log('\nTo sign in to GitHub Copilot:');
      console.log('  1. Open ' + verification_uri);
      console.log('  2. Enter the code: ' + user_code);
      console.log('\nWaiting for authorization…');
      auth.openBrowser(verification_uri);
    },
  }).then(({ file }) => {
    console.log('\n✓ Signed in to GitHub Copilot. Token saved to ' + file);
    process.exit(0);
  }).catch((err) => {
    console.error('\nLogin failed: ' + err.message);
    process.exit(1);
  });
}

if (process.argv.includes('--login')) {
  runLogin();
  return;
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, Object.assign({
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }, CORS));
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end('Bad JSON'); return; }
      handleChat(body, res);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/tool') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end('Bad JSON'); return; }
      tools.run(body.name, body.input || {}).then((result) => sendJson(res, result));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/login') {
    handleLogin(res);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/config') {
    providers.available()
      .then((list) => sendJson(res, { providers: list }))
      .catch((e) => sendJson(res, { providers: [], error: e.message }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions') {
    handleGetSessions(res);
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/session?')) {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id');
    handleGetSession(id, res);
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('cake listening on http://localhost:' + PORT);
  // All providers load; report which ones already have credentials/config.
  // The rest still appear once configured (or, for Copilot, after sign-in).
  const configured = providers.list().filter((p) => p.isConfigured()).map((p) => p.id);
  console.log('providers: ' + (configured.length
    ? configured.join(', ') + ' configured'
    : 'none configured yet — set an API key, start Ollama, or sign in to Copilot'));
});
