// Entry point: agentic loop, send, Copilot sign-in, config, init.

import { escapeHtml, setStatus, addMsg, updateMsg, setModelLabel, addThinkBlock, updateThinkBlock, $msgContainer } from './ui.js';
import { selectedModel, buildPicker, updateContext }                               from './picker.js';
import { readSSE, streamChat, executeTool }                                        from './stream.js';
import { sessions, activeSessionId, newSession, refreshSessionItem,
         refreshSessionList, loadSession }                                          from './sessions.js';

const $input           = document.getElementById('input');
const $sendBtn         = document.getElementById('send-btn');
const $reasoningPicker = document.getElementById('reasoning-picker');
const $loginBtn        = document.getElementById('login-btn');

let currentAbort = null;

const MAX_STEPS = 20;

// ── agentic loop ───────────────────────────────────────────────────────────
async function agentLoop(sessId, userText) {
  const sess = sessions.get(sessId);
  if (!sess) return;

  sess.history.push({ role: 'user', content: userText });
  addMsg(sess.pane, 'user', userText);

  for (let step = 0; step < MAX_STEPS; step++) {
    const el = addMsg(sess.pane, 'assistant', '\u2026');
    el.querySelector('.body').classList.add('thinking');

    currentAbort = new AbortController();
    let thinkEl = null;
    let result;
    try {
      result = await streamChat(
        sess.history, sessId, selectedModel(),
        (text) => updateMsg(el, text),
        (meta) => setModelLabel(el, meta),
        {
          signal: currentAbort.signal,
          reasoningEffort: $reasoningPicker.value || undefined,
          onThink(thinking) {
            if (!thinkEl) thinkEl = addThinkBlock(sess.pane, el);
            updateThinkBlock(thinkEl, thinking);
          },
        },
      );
    } catch (err) {
      currentAbort = null;
      if (err.name === 'AbortError') { updateMsg(el, '(stopped)'); return; }
      updateMsg(el, 'Error: ' + err.message);
      return;
    }
    currentAbort = null;

    const text      = result.text.trim();
    const toolCalls = result.tool_calls.filter(tc => tc && tc.name);

    if (text)              updateMsg(el, text);
    else if (toolCalls.length) updateMsg(el, '(using tools\u2026)');
    else                   el.remove();

    if (text || toolCalls.length) {
      sess.history.push({ role: 'assistant', content: text, tool_calls: toolCalls });
    }

    if (!toolCalls.length) { updateContext(sessions, activeSessionId); break; }

    for (const tc of toolCalls) {
      const preview    = JSON.stringify(tc.input, null, 2);
      const toolEl     = addMsg(sess.pane, 'tool', preview, tc.name);
      const toolResult = await executeTool(tc.name, tc.input);
      const output     = JSON.stringify(toolResult, null, 2);
      updateMsg(toolEl, preview + '\n\n\u2192 ' + output);
      sess.history.push({ role: 'tool', tool_call_id: tc.id, content: output });
    }
    updateContext(sessions, activeSessionId);
  }
}

// ── send ───────────────────────────────────────────────────────────────────
async function send() {
  const text = $input.value.trim();
  if (!text) return;

  if (!activeSessionId || !sessions.has(activeSessionId)) newSession();
  const sessId = activeSessionId;
  const sess   = sessions.get(sessId);
  if (!sess || sess.busy) return;

  if (!sess.title) { sess.title = text.slice(0, 60); refreshSessionItem(sessId); }

  $input.value        = '';
  $input.style.height = 'auto';
  sess.busy           = true;
  $sendBtn.innerHTML  = '&#x25A0;';
  $sendBtn.title      = 'Stop';
  setStatus('thinking\u2026');
  refreshSessionItem(sessId);

  try {
    await agentLoop(sessId, text);
    setStatus('ready', 'ok');
  } catch (e) {
    setStatus('error: ' + e.message, 'err');
  }

  sess.busy = false;
  refreshSessionItem(sessId);
  refreshSessionList();

  if (activeSessionId === sessId) {
    $sendBtn.innerHTML = '&#x25BA;';
    $sendBtn.title     = 'Send';
    $input.focus();
  }
  updateContext(sessions, activeSessionId);
}

// ── event handlers ─────────────────────────────────────────────────────────
$sendBtn.addEventListener('click', () => { if (currentAbort) currentAbort.abort(); else send(); });
$input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$input.addEventListener('input', () => {
  $input.style.height = 'auto';
  $input.style.height = Math.min($input.scrollHeight, 200) + 'px';
});
document.getElementById('model-picker').addEventListener('change', () => updateContext(sessions, activeSessionId));
document.getElementById('new-session-btn').addEventListener('click', () => { newSession(); $input.focus(); });

// ── copilot sign-in ────────────────────────────────────────────────────────
function showLoginPrompt(userCode, verificationUri) {
  const sess   = activeSessionId ? sessions.get(activeSessionId) : null;
  const pane   = (sess && sess.pane) || $msgContainer;
  const el     = document.createElement('div');
  el.className = 'msg assistant';
  const linkHtml = /^https:\/\//.test(verificationUri)
    ? '<a href="' + escapeHtml(verificationUri) + '" target="_blank" rel="noopener">' + escapeHtml(verificationUri) + '</a>'
    : escapeHtml(verificationUri);
  el.innerHTML = '<div class="label">Assistant</div><div class="body">'
    + 'Sign in to GitHub Copilot:<br><br>'
    + '1. Open ' + linkHtml + '<br>'
    + '2. Enter the code: <strong>' + escapeHtml(userCode) + '</strong><br><br>'
    + 'A browser window should have opened automatically. Waiting for you to authorize\u2026'
    + '</div>';
  pane.appendChild(el);
  el.scrollIntoView({ block: 'end' });
  return el;
}

async function signInCopilot() {
  const sess = activeSessionId ? sessions.get(activeSessionId) : null;
  if (sess && sess.busy) return;
  $loginBtn.disabled = true;
  $sendBtn.disabled  = true;
  setStatus('starting GitHub sign-in\u2026');
  let promptEl = null;
  try {
    const resp = await fetch('/api/login', { method: 'POST' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    await readSSE(resp, (ev) => {
      if (ev.type === 'prompt') {
        setStatus('waiting for GitHub authorization\u2026');
        promptEl = showLoginPrompt(ev.user_code, ev.verification_uri);
      } else if (ev.type === 'error') {
        throw new Error(ev.error);
      }
    });
    if (promptEl) updateMsg(promptEl, 'Signed in to GitHub Copilot \u2713');
    await refreshConfig();
  } catch (e) {
    if (promptEl) updateMsg(promptEl, 'Sign-in failed: ' + e.message);
    setStatus('sign-in failed: ' + e.message, 'err');
  } finally {
    $loginBtn.disabled = false;
    const activeSess   = activeSessionId ? sessions.get(activeSessionId) : null;
    $sendBtn.disabled  = !!(activeSess && activeSess.busy);
  }
}

$loginBtn.addEventListener('click', signInCopilot);

// ── config + init ──────────────────────────────────────────────────────────
async function refreshConfig() {
  try {
    const cfg  = await fetch('/api/config').then(r => r.json());
    const list = cfg.providers || [];
    buildPicker(list);
    const copilot = list.find(p => p.id === 'copilot');
    $loginBtn.style.display = (copilot && (!copilot.models || !copilot.models.length)) ? '' : 'none';
    const total = list.reduce((n, p) => n + ((p.models && p.models.length) || 0), 0);
    if (total) setStatus('ready', 'ok');
    else       setStatus('no providers configured \u2014 set an API key, start Ollama, or sign in', 'err');
    updateContext(sessions, activeSessionId);
  } catch (e) {
    setStatus('server error', 'err');
  }
}

async function init() {
  await refreshConfig();
  await refreshSessionList();
  newSession();
}

init();
