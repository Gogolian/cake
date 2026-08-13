#!/usr/bin/env node
'use strict';

// cake — minimal, dependency-free code-agent harness.
//
// This file is the HTTP server, router, and CLI entry point.
// Business logic lives in: chat.js, session.js, tools.js, providers/.

const http = require('http');
const fs   = require('fs');
const path = require('path');

const providers = require('./providers');
const tools     = require('./tools');
const { handleChat }                                                         = require('./chat');
const { listSessionFiles, extractSessionTitle, parseMdHistory, sessionMdPath } = require('./session');

const PORT       = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CORS       = { 'Access-Control-Allow-Origin': '*' };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.ico':  'image/x-icon',
};

function serveStatic(req, res) {
  const urlPath  = req.url.split('?')[0];
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const rel      = safePath === '/' || safePath === '.' ? 'index.html' : safePath;
  const file     = path.join(PUBLIC_DIR, rel);
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

function sendEvent(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

function sendJson(res, obj) {
  res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS));
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString())); }
    catch (e) { cb(e); }
  });
}

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
    // Drop the model cache so /api/config reflects newly available Copilot models.
    providers.clearCache();
    sendEvent(res, { type: 'done' });
    res.end();
  }).catch((e) => {
    sendEvent(res, { type: 'error', error: e.message });
    res.end();
  });
}

// `node server.js --login` runs the GitHub Copilot device-flow login and exits.
function runLogin() {
  const auth = require('./providers/copilot-auth');
  auth.login({
    onPrompt({ user_code, verification_uri }) {
      console.log('\nTo sign in to GitHub Copilot:');
      console.log('  1. Open ' + verification_uri);
      console.log('  2. Enter the code: ' + user_code);
      console.log('\nWaiting for authorization\u2026');
      auth.openBrowser(verification_uri);
    },
  }).then(({ file }) => {
    console.log('\n\u2713 Signed in to GitHub Copilot. Token saved to ' + file);
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
      .catch((e)   => sendJson(res, { providers: [], error: e.message }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions') {
    const files = listSessionFiles();
    sendJson(res, files.map(f => ({ id: f.id, date: f.date, title: extractSessionTitle(f.filePath) })));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/session?')) {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id');
    if (!id || !/^\d+$/.test(id)) { res.writeHead(400); res.end('Invalid id'); return; }
    try {
      sendJson(res, { id, history: parseMdHistory(fs.readFileSync(sessionMdPath(id), 'utf8')) });
    } catch (_) {
      sendJson(res, { id, history: [] });
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('cake listening on http://localhost:' + PORT);
  const configured = providers.list().filter((p) => p.isConfigured()).map((p) => p.id);
  console.log('providers: ' + (configured.length
    ? configured.join(', ') + ' configured'
    : 'none configured yet \u2014 set an API key, start Ollama, or sign in to Copilot'));
});

