'use strict';

// Chat endpoint: relay the provider SSE stream to the browser and persist turns.

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const providers = require('./providers');
const tools     = require('./tools');
const session   = require('./session');

const CORS = { 'Access-Control-Allow-Origin': '*' };

function sendEvent(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

function handleChat(body, res) {
  let sessionFilePath = null;
  try {
    const sessionMark = body && (body.session_start || body.sessionId || body.session);
    if (sessionMark) {
      const tsString    = String(sessionMark);
      sessionFilePath   = session.sessionMdPath(tsString);
      const sessionsDir = path.dirname(sessionFilePath);
      try { fs.mkdirSync(sessionsDir, { recursive: true }); } catch (e) { console.error('Failed to create sessions directory', e); }

      const lastMsg = Array.isArray(body.messages) && body.messages.length
        ? body.messages[body.messages.length - 1] : null;

      if (!fs.existsSync(sessionFilePath)) {
        const providerInfo = (body.provider || '') + (body.model ? '/' + body.model : '');
        const md = '# Session started ' + new Date().toISOString() + '\n\n'
          + '**Provider (requested):** ' + providerInfo + '\n\n'
          + '## Conversation\n\n';
        try { fs.writeFileSync(sessionFilePath, md); } catch (e) { console.error('Failed to write session file', e); }
      }

      if (lastMsg && lastMsg.role !== 'assistant' && lastMsg.content) {
        const prov = lastMsg.role === 'user' ? 'human' : (body.provider || 'na');
        const mod  = lastMsg.role === 'user' ? 'na'    : (body.model    || 'na');
        session.appendEntry(sessionFilePath, lastMsg.role, lastMsg.content, prov, mod, lastMsg.tool_call_id || null);
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

  // Tell the browser which provider/model is actually answering.
  sendEvent(res, { type: 'meta', provider: provider.id, model });

  provider.buildRequest({
    messages:        body.messages || [],
    tools:           tools.definitions,
    system:          body.system,
    model,
    maxTokens:       body.max_tokens,
    reasoningEffort: body.reasoning_effort || undefined,
  }).then((upstreamReq) => {
    const client = upstreamReq.transport === 'http' ? http : https;
    const parser = provider.createParser();
    let assistantBuffer  = '';
    // toolCallsBuffer captures tool calls for lossless session reconstruction.
    let toolCallsBuffer  = [];

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
            session.appendEntry(sessionFilePath, 'assistant', content || '(tool call)', provider.id || 'na', model || 'na');
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

module.exports = { handleChat };
