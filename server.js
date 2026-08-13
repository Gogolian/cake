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
  let provider;
  try { provider = providers.select(); }
  catch (e) { res.writeHead(400, CORS); res.end(e.message); return; }

  res.writeHead(200, Object.assign({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  }, CORS));

  provider.buildRequest({
    messages: body.messages || [],
    tools: tools.definitions,
    system: body.system,
    model: body.model,
    maxTokens: body.max_tokens,
  }).then((upstreamReq) => {
    const client = upstreamReq.transport === 'http' ? http : https;
    const parser = provider.createParser();

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
      upstream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          for (const evt of parser.feed(data)) sendEvent(res, evt);
        }
      });
      upstream.on('end', () => {
        for (const evt of parser.flush()) sendEvent(res, evt);
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

  if (req.method === 'GET' && req.url === '/api/config') {
    let provider;
    try { provider = providers.select(); }
    catch (e) { sendJson(res, { error: e.message }); return; }
    sendJson(res, {
      provider: provider.id,
      label: provider.label,
      model: provider.model(),
      configured: provider.isConfigured(),
    });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  let info;
  try {
    const p = providers.select();
    info = p.label + ' (' + p.model() + ')' + (p.isConfigured() ? '' : ' — not configured');
  } catch (e) {
    info = e.message;
  }
  console.log('cake listening on http://localhost:' + PORT);
  console.log('provider: ' + info);
});
