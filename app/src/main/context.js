// Keeps a request inside the model's context window. Ollama silently cuts off the start of
// a prompt that is too long, which loses instructions and confuses the model, so the app
// trims the history itself, oldest and least useful parts first. The saved conversation is
// never changed: this only shapes what is sent.
const CHARS_PER_TOKEN = 3.2; // on the safe side for code and logs

// Pictures cost the model a fixed amount (they are turned into image tokens), so their
// base64 text must not count by length: one photo would look like a full context window.
const IMAGE_CHARS = 1500 * CHARS_PER_TOKEN;
const size = (x) => JSON.stringify(x, (k, v) => (k === 'data' && typeof v === 'string' && v.length > 2000 ? 'x'.repeat(IMAGE_CHARS) : v)).length;
const tokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);
const isToolResults = (m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');

function stub(text, keep) {
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return s.length <= keep ? s : `${s.slice(0, keep)}\n[... ${s.length - keep} more characters left out to save context ...]`;
}

/**
 * Returns { messages, trimmed, usedTokens, budgetTokens }.
 * budget = context window minus room for the answer, the system prompt and the tool list.
 */
function fit(messages, { ctx, system, tools, maxTokens }) {
  const fixed = tokens((system || '').length + (tools ? size(tools) : 0));
  const budget = Math.max(1500, ctx - Math.min(maxTokens, Math.floor(ctx * 0.3)) - fixed - 300);
  let msgs = messages.map((m) => ({ role: m.role, content: Array.isArray(m.content) ? m.content.map((b) => ({ ...b })) : m.content }));
  const total = () => tokens(msgs.reduce((s, m) => s + size(m.content), 0));
  let trimmed = false;
  if (total() <= budget) return { messages: msgs, trimmed, usedTokens: total() + fixed, budgetTokens: budget + fixed };

  // 1. old reasoning is never needed again
  const lastAssistant = msgs.map((m) => m.role).lastIndexOf('assistant');
  msgs.forEach((m, i) => {
    if (m.role === 'assistant' && i !== lastAssistant && Array.isArray(m.content)) {
      const kept = m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
      if (kept.length && kept.length !== m.content.length) m.content = kept;
    }
  });

  // 2. shorten old tool output and old file contents in tool calls (keep the last 6 messages whole)
  for (const keep of [1500, 300]) {
    if (total() <= budget) break;
    trimmed = true;
    for (let i = 0; i < msgs.length - 6 && total() > budget; i++) {
      const m = msgs[i];
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === 'tool_result') b.content = stub(typeof b.content === 'string' ? b.content : (b.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') || '(output)', keep);
        else if (b.type === 'tool_use' && b.input && size(b.input) > keep * 2) {
          b.input = Object.fromEntries(Object.entries(b.input).map(([k, v]) => [k, typeof v === 'string' ? stub(v, keep) : v]));
        } else if (b.type === 'image' || b.type === 'document') {
          b.type = 'text';
          b.text = '[an attachment from earlier was left out to save context]';
          delete b.source;
          delete b.title;
        }
      }
    }
  }

  // 2b. the recent messages alone are too big (a huge file or log): cap single blocks, the
  //     newest ones most generously, so the model keeps the thread of what it was doing
  const budgetChars = budget * CHARS_PER_TOKEN;
  const cap = (m, max) => {
    if (!Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const s = typeof b.content === 'string' ? b.content : (b.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') || '(output)';
        if (s.length > max) b.content = stub(s, max);
      } else if (b.type === 'tool_use' && b.input && size(b.input) > max) {
        b.input = Object.fromEntries(Object.entries(b.input).map(([k, v]) => [k, typeof v === 'string' ? stub(v, Math.floor(max / 2)) : v]));
      } else if (b.type === 'text' && b.text.length > max) b.text = stub(b.text, max);
    }
  };
  for (const share of [0.3, 0.12, 0.05]) {
    if (total() <= budget) break;
    trimmed = true;
    const from = Math.max(0, msgs.length - 6);
    for (let i = from; i < msgs.length; i++) cap(msgs[i], Math.floor(budgetChars * (i === msgs.length - 1 ? Math.max(share, 0.3) : share)));
  }

  // 3. drop the oldest turns; a turn starts at a user message that isn't tool results
  if (total() > budget) {
    trimmed = true;
    const starts = msgs.map((m, i) => (m.role === 'user' && !isToolResults(m) ? i : -1)).filter((i) => i >= 0);
    let cut = 0;
    for (const s of starts.slice(1)) {
      cut = s;
      if (tokens(msgs.slice(s).reduce((a, m) => a + size(m.content), 0)) <= budget - 80) break;
    }
    if (cut > 0) {
      msgs = [
        { role: 'user', content: [{ type: 'text', text: '[The start of this conversation was left out to fit your context window. What you saved in your notes file is still there; use search_memory if you need something from before.]' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Understood.' }] },
        ...msgs.slice(cut),
      ];
    }
  }

  // 4. a single turn that is still too long: shorten everything but the last 2 messages hard
  if (total() > budget) {
    for (let i = 0; i < msgs.length - 2; i++) {
      const m = msgs[i];
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === 'tool_result') b.content = stub(typeof b.content === 'string' ? b.content : '(output)', 120);
        else if (b.type === 'text' && b.text.length > 1500) b.text = stub(b.text, 1500);
      }
    }
  }
  return { messages: msgs, trimmed, usedTokens: total() + fixed, budgetTokens: budget + fixed };
}

module.exports = { fit, tokens };
