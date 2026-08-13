// Server API: SSE streaming and tool execution.

export async function readSSE(response, onEvent) {
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let   buf     = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      let ev;
      try { ev = JSON.parse(raw); } catch (_) { continue; }
      onEvent(ev);
    }
  }
}

// sel = { provider, model } as returned by selectedModel(); passed in so this module stays stateless.
// opts = { signal, reasoningEffort, onThink }
export async function streamChat(messages, sessionId, sel, onText, onMeta, opts = {}) {
  const { signal, reasoningEffort, onThink } = opts;
  const resp = await fetch('/api/chat', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      messages,
      provider:         sel ? sel.provider : undefined,
      model:            sel ? sel.model    : undefined,
      session_start:    sessionId,
      reasoning_effort: reasoningEffort || undefined,
    }),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const result = { text: '', tool_calls: [], meta: null };
  let thinkBuf = '';
  await readSSE(resp, (ev) => {
    if      (ev.type === 'meta')  { result.meta = ev; if (onMeta) onMeta(ev); }
    else if (ev.type === 'text')  { result.text += ev.text; if (onText) onText(result.text); }
    else if (ev.type === 'think') { thinkBuf += ev.text; if (onThink) onThink(thinkBuf); }
    else if (ev.type === 'tool')  result.tool_calls.push({ id: ev.id, name: ev.name, input: ev.input });
    else if (ev.type === 'error') throw new Error(ev.error);
  });
  return result;
}

export async function executeTool(name, input) {
  const resp = await fetch('/api/tool', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, input }),
  });
  return resp.json();
}
