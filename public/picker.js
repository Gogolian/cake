// Model picker and context-token meter.

const $picker  = document.getElementById('model-picker');
const $context = document.getElementById('context');

let modelMax = {};

export function selectedModel() {
  const val   = $picker.value || '';
  const slash = val.indexOf('/');
  if (slash < 0) return null;
  return { provider: val.slice(0, slash), model: val.slice(slash + 1), max: modelMax[val] || 0 };
}

export function buildPicker(list) {
  const prev = $picker.value;
  $picker.innerHTML = '';
  modelMax = {};
  let count = 0;
  for (const p of list) {
    if (!p.models || !p.models.length) continue;
    const group = document.createElement('optgroup');
    group.label = p.label || p.id;
    for (const m of p.models) {
      const val = p.id + '/' + m.id;
      modelMax[val] = m.maxContext || 0;
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = val;
      group.appendChild(opt); count++;
    }
    $picker.appendChild(group);
  }
  if (!count) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = 'no models available';
    $picker.appendChild(opt); $picker.disabled = true; return;
  }
  $picker.disabled = false;
  if (prev && Object.prototype.hasOwnProperty.call(modelMax, prev)) $picker.value = prev;
}

function fmtTokens(n) {
  n = Number(n) || 0;
  return n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n);
}

function countStr(s) {
  let t = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if      (cp > 0x1FFFF)                      t += 3;    // emoji / rare high planes
    else if (cp >= 0x4E00 && cp <= 0x9FFF)      t += 2;    // CJK unified ideographs
    else if (cp > 0x7F)                          t += 1.5;  // other non-ASCII
    else if (/\w/.test(ch))                      t += 0.27; // ASCII word chars (~3.7 chars/token)
    else                                         t += 1;    // ASCII punctuation / symbols
  }
  return t;
}

function estimateTokens(hist) {
  let tokens = 0;
  for (const m of hist) {
    if (typeof m.content === 'string') {
      tokens += countStr(m.content);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) if (b && b.text) tokens += countStr(b.text);
    }
    for (const tc of m.tool_calls || []) {
      tokens += countStr((tc.name || '') + JSON.stringify(tc.input || {}));
    }
  }
  return Math.ceil(tokens);
}

export function updateContext(sessions, activeSessionId) {
  const sess = activeSessionId ? sessions.get(activeSessionId) : null;
  const hist = sess ? sess.history : [];
  const sel  = selectedModel();
  const used = estimateTokens(hist);
  if (sel && sel.max) $context.textContent = 'ctx \u2248 ' + fmtTokens(used) + ' / ' + fmtTokens(sel.max);
  else if (used)      $context.textContent = 'ctx \u2248 ' + fmtTokens(used);
  else                $context.textContent = '';
}
