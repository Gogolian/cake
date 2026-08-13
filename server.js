#!/usr/bin/env node
'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');

const PORT     = process.env.PORT || 3000;
const API_KEY  = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '';
const PROVIDER = process.env.PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');

// ── static file helper ─────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.ico':  'image/x-icon',
};

const PUBLIC_DIR = path.join(__dirname, 'public');

function serveStatic(req, res) {
  // Strip query string and normalize to prevent path traversal
  const urlPath   = req.url.split('?')[0];
  const safePath  = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const rel       = safePath === '/' || safePath === '.' ? 'index.html' : safePath;
  const file      = path.join(PUBLIC_DIR, rel);
  // Double-check: resolved path must be inside PUBLIC_DIR
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const ext = path.extname(file);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── LLM proxy ──────────────────────────────────────────────────────────────

function proxyAnthropic(body, res) {
  const payload = JSON.stringify({
    model:      body.model || 'claude-opus-4-5',
    max_tokens: body.max_tokens || 4096,
    stream:     true,
    system:     body.system || 'You are a helpful coding assistant.',
    messages:   body.messages,
  });

  const options = {
    hostname: 'api.anthropic.com',
    path:     '/v1/messages',
    method:   'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         API_KEY,
      'anthropic-version': '2023-06-01',
    },
  };

  const upstream = https.request(options, (ur) => {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    ur.pipe(res);
  });
  upstream.on('error', (e) => { res.writeHead(502); res.end(e.message); });
  upstream.end(payload);
}

function proxyOpenAI(body, res) {
  const payload = JSON.stringify({
    model:      body.model || 'gpt-4o',
    stream:     true,
    max_tokens: body.max_tokens || 4096,
    messages: [
      { role: 'system', content: body.system || 'You are a helpful coding assistant.' },
      ...(body.messages || []),
    ],
  });

  const bearerToken = 'Bearer ' + API_KEY;
  const options = {
    hostname: 'api.openai.com',
    path:     '/v1/chat/completions',
    method:   'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': bearerToken,
    },
  };

  const upstream = https.request(options, (ur) => {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    ur.pipe(res);
  });
  upstream.on('error', (e) => { res.writeHead(502); res.end(e.message); });
  upstream.end(payload);
}

// ── tool execution ──────────────────────────────────────────────────────────

function runTool(name, input, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });

  if (name === 'bash') {
    const child = spawn('bash', ['-c', input.command || ''], { timeout: 30000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      res.end(JSON.stringify({ stdout, stderr, exit_code: code }));
    });
    child.on('error', (e) => {
      res.end(JSON.stringify({ stdout: '', stderr: e.message, exit_code: 1 }));
    });
  } else if (name === 'read_file') {
    const filePath = path.resolve(input.path || '');
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) res.end(JSON.stringify({ error: err.message }));
      else     res.end(JSON.stringify({ content: data }));
    });
  } else if (name === 'write_file') {
    const filePath = path.resolve(input.path || '');
    fs.writeFile(filePath, input.content || '', 'utf8', (err) => {
      if (err) res.end(JSON.stringify({ error: err.message }));
      else     res.end(JSON.stringify({ ok: true }));
    });
  } else if (name === 'list_dir') {
    const dir = path.resolve(input.path || '.');
    fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
      if (err) res.end(JSON.stringify({ error: err.message }));
      else     res.end(JSON.stringify({ entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) }));
    });
  } else {
    res.end(JSON.stringify({ error: 'Unknown tool: ' + name }));
  }
}

// ── request router ──────────────────────────────────────────────────────────

function readBody(req, cb) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString())); }
    catch (e) { cb(e); }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end('Bad JSON'); return; }
      if (PROVIDER === 'anthropic') proxyAnthropic(body, res);
      else                          proxyOpenAI(body, res);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/tool') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end('Bad JSON'); return; }
      runTool(body.name, body.input || {}, res);
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ provider: PROVIDER, hasKey: !!API_KEY }));
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('cake listening on http://localhost:' + PORT);
  console.log('provider: ' + PROVIDER + '  |  key: ' + (API_KEY ? 'set' : 'missing (set ANTHROPIC_API_KEY or OPENAI_API_KEY)'));
});
