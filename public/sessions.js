// Session state and sidebar management.

import { createPane, addMsg } from './ui.js';
import { updateContext }      from './picker.js';

const $sessionList = document.getElementById('session-list');
const $sendBtn     = document.getElementById('send-btn');

export const sessions          = new Map();
export let   activeSessionId   = null;
export let   serverSessionList = [];

export function createLocalSession(id) {
  id = id || String(Date.now());
  const pane = createPane(id);
  sessions.set(id, { id, history: [], busy: false, pane, title: null });
  return id;
}

export function switchSession(id) {
  if (activeSessionId) {
    const prev = sessions.get(activeSessionId);
    if (prev) prev.pane.classList.remove('active');
    const oldItem = $sessionList.querySelector('.session-item[data-id="' + activeSessionId + '"]');
    if (oldItem) oldItem.classList.remove('active');
  }
  activeSessionId = id;
  const sess = sessions.get(id);
  if (!sess) return;
  sess.pane.classList.add('active');
  sess.pane.scrollTop = sess.pane.scrollHeight;
  $sendBtn.disabled = sess.busy;
  $sessionList.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  const newItem = $sessionList.querySelector('.session-item[data-id="' + id + '"]');
  if (newItem) newItem.classList.add('active');
  updateContext(sessions, activeSessionId);
}

export function refreshSessionItem(id) {
  const item = $sessionList.querySelector('.session-item[data-id="' + id + '"]');
  if (!item) { renderSessionList(); return; }
  const sess = sessions.get(id);
  item.classList.toggle('active', id === activeSessionId);
  item.classList.toggle('busy', !!(sess && sess.busy));
  if (sess && sess.title) {
    const t = item.querySelector('.sess-title');
    if (t) t.textContent = sess.title;
  }
}

export function renderSessionList() {
  $sessionList.innerHTML = '';
  const serverIds = new Set(serverSessionList.map(s => s.id));
  const localOnly = [...sessions.values()]
    .filter(s => !serverIds.has(s.id))
    .sort((a, b) => Number(b.id) - Number(a.id));
  for (const s of localOnly) {
    _appendSessionItem({ id: s.id, title: s.title || 'New conversation', date: null });
  }
  for (const s of serverSessionList) {
    const mem = sessions.get(s.id);
    _appendSessionItem({
      id:    s.id,
      title: (mem && mem.title) || s.title || ('Session ' + (s.date || s.id)),
      date:  s.date,
    });
  }
}

function _appendSessionItem({ id, title, date }) {
  const item      = document.createElement('div');
  item.className  = 'session-item';
  item.dataset.id = id;
  if (id === activeSessionId) item.classList.add('active');
  const sess = sessions.get(id);
  if (sess && sess.busy) item.classList.add('busy');

  const t = document.createElement('span');
  t.className   = 'sess-title';
  t.textContent = title;
  item.appendChild(t);

  if (date) {
    const d = document.createElement('span');
    d.className   = 'sess-date';
    d.textContent = date;
    item.appendChild(d);
  }

  item.addEventListener('click', () => loadSession(id));
  $sessionList.appendChild(item);
}

export async function refreshSessionList() {
  try {
    const resp = await fetch('/api/sessions');
    if (resp.ok) serverSessionList = await resp.json();
  } catch (_) {}
  renderSessionList();
}

export async function loadSession(id) {
  if (!sessions.has(id)) {
    const pane = createPane(id);
    sessions.set(id, { id, history: [], busy: false, pane, title: null });
    try {
      const resp = await fetch('/api/session?id=' + encodeURIComponent(id));
      if (resp.ok) {
        const data = await resp.json();
        const sess = sessions.get(id);
        if (sess && Array.isArray(data.history)) {
          sess.history = data.history;
          for (const msg of data.history) {
            if (msg.role === 'user') {
              addMsg(pane, 'user', msg.content || '');
              if (!sess.title && msg.content) sess.title = msg.content.slice(0, 60);
            } else if (msg.role === 'assistant') {
              addMsg(pane, 'assistant', msg.content || '(used tools)');
            } else if (msg.role === 'tool') {
              addMsg(pane, 'tool', msg.content || '', 'tool result');
            }
          }
        }
      }
    } catch (_) {}
  }
  switchSession(id);
  renderSessionList();
}

export function newSession() {
  const id = createLocalSession();
  renderSessionList();
  switchSession(id);
  return id;
}
