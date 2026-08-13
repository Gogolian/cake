'use strict';

// Session file storage: path helpers, write, parse, and list.
// No HTTP dependency — callers handle request/response.

const fs   = require('fs');
const path = require('path');

function sessionMdPath(id) {
  const d     = new Date(Number(id));
  const year  = String(d.getFullYear());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day   = String(d.getDate()).padStart(2, '0');
  return path.join(__dirname, 'sessions', year, month, day, id + '.md');
}

function appendEntry(filePath, role, content, prov, mod, toolCallId) {
  if (!filePath || !content) return;
  const actor = role === 'user' ? 'human' : role === 'assistant' ? 'assistant' : role === 'tool' ? 'tool' : (role || 'other');
  const ts    = new Date().toISOString();
  const meta  = (prov || 'na') + '/' + (mod || 'na') + '/' + Math.ceil((content.length || 0) / 4);
  // tool entries carry the tool_call_id as a 3rd pipe-delimited field for lossless reconstruction.
  const headerExtra = (actor === 'tool' && toolCallId) ? ' | ' + toolCallId : '';
  const entry = '\n\n### ' + actor + ' | ' + meta + headerExtra + ' | ' + ts + '\n\n' + content + '\n';
  fs.appendFile(filePath, entry, (err) => { if (err) console.error('Failed to append session entry', err); });
}

// Parse a session .md file back into a provider-neutral history array.
// Handles both old entries (no tool_call_id) and new ones (with it).
function parseMdHistory(text) {
  const history  = [];
  const headerRe = /^### (human|assistant|tool)\s*\|(.+)$/gm;
  const headers  = [];
  let m;
  while ((m = headerRe.exec(text)) !== null) {
    headers.push({ actor: m[1], meta: m[2], pos: m.index, bodyStart: m.index + m[0].length });
  }
  for (let i = 0; i < headers.length; i++) {
    const h       = headers[i];
    const nextPos = i + 1 < headers.length ? headers[i + 1].pos : text.length;
    const body    = text.slice(h.bodyStart, nextPos).replace(/^\n+/, '').replace(/\n+$/, '');
    const parts   = h.meta.split('|').map(s => s.trim());
    if (h.actor === 'human') {
      if (body) history.push({ role: 'user', content: body });
    } else if (h.actor === 'assistant') {
      const toolBlockRe = /\*\*\u2192 ([^\n*`]+)\*\* `([^\n`]+)`\n```json\n([\s\S]*?)\n```/g;
      const tool_calls  = [];
      let tcm;
      while ((tcm = toolBlockRe.exec(body)) !== null) {
        try { tool_calls.push({ name: tcm[1].trim(), id: tcm[2], input: JSON.parse(tcm[3]) }); } catch (_) {}
      }
      const cleanBody = body.replace(/\n*\*\*\u2192 [^\n*`]+\*\* `[^\n`]+`\n```json\n[\s\S]*?\n```/g, '').trim();
      const entry = { role: 'assistant', content: cleanBody };
      if (tool_calls.length) entry.tool_calls = tool_calls;
      history.push(entry);
    } else if (h.actor === 'tool') {
      // Only include tool results that have a tool_call_id — orphan entries break provider validation.
      if (parts.length >= 3) {
        history.push({ role: 'tool', tool_call_id: parts[1], content: body });
      }
    }
  }
  return history;
}

// Recursively collect all .md session files, sorted newest-first.
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

function extractSessionTitle(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8').slice(0, 1200);
    const m    = text.match(/###\s+human\s+\|[^\n]*\n\n([\s\S]+?)(?:\n\n###|$)/);
    if (m) return m[1].trim().replace(/\s+/g, ' ').slice(0, 80);
  } catch (_) {}
  return null;
}

module.exports = { sessionMdPath, appendEntry, parseMdHistory, listSessionFiles, extractSessionTitle };
