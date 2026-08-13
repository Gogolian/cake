// Message rendering utilities and DOM helpers. No module-level state.

export const $msgContainer = document.getElementById('messages-container');
const $status              = document.getElementById('status');

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderMarkdown(text) {
  // Strip tool-call IDs before rendering — name + input are sufficient for display.
  const t = text.replace(/(\*\*\u2192 [^*\n]+\*\*) `[^\n`]+`/g, '$1');
  return escapeHtml(t)
    .replace(/```([\s\S]*?)```/g, (_, c) => '<pre><code>' + c.trim() + '</code></pre>')
    .replace(/`([^`]+)`/g,        (_, c) => '<code>' + c + '</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>');
}

export function setStatus(msg, cls) {
  $status.textContent = msg;
  $status.className   = cls || '';
}

export function createPane(id) {
  const pane = document.createElement('div');
  pane.className        = 'session-pane';
  pane.dataset.sessionId = id;
  $msgContainer.appendChild(pane);
  return pane;
}

export function addMsg(pane, role, content, extra) {
  const el     = document.createElement('div');
  el.className = 'msg ' + role;
  const label  = role === 'user' ? 'You' : role === 'tool' ? (extra || 'tool') : 'Assistant';
  el.innerHTML = '<div class="label">' + escapeHtml(label) + '</div>'
    + '<div class="body">' + renderMarkdown(content) + '</div>';
  pane.appendChild(el);
  if (pane.classList.contains('active')) el.scrollIntoView({ block: 'end' });
  return el;
}

export function updateMsg(el, text) {
  el.querySelector('.body').innerHTML = renderMarkdown(text);
  const pane = el.closest('.session-pane');
  if (pane && pane.classList.contains('active')) el.scrollIntoView({ block: 'end' });
}

export function setModelLabel(el, meta) {
  if (!meta || !meta.model) return;
  const label = el.querySelector('.label');
  if (!label) return;
  label.textContent = 'Assistant ';
  const tag       = document.createElement('span');
  tag.className   = 'model';
  tag.textContent = meta.provider ? meta.provider + '/' + meta.model : meta.model;
  label.appendChild(tag);
}

export function addThinkBlock(pane, beforeEl) {
  const el = document.createElement('details');
  el.className = 'think-block';
  el.innerHTML = '<summary>thinking\u2026</summary><div class="think-body"></div>';
  if (beforeEl) beforeEl.before(el);
  else pane.appendChild(el);
  if (pane.classList.contains('active')) el.scrollIntoView({ block: 'end' });
  return el;
}

export function updateThinkBlock(el, text) {
  el.querySelector('.think-body').textContent = text;
  const pane = el.closest('.session-pane');
  if (pane && pane.classList.contains('active')) el.scrollIntoView({ block: 'end' });
}
