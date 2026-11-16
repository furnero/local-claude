// Step through a chat in a running Local Claude by hand (for supervising the model):
//   node test/step.js start "<prompt>" [--model smart|quick] [--cwd <folder>]
//   node test/step.js wait                 until it needs an approval/answer or is done
//   node test/step.js approve | deny       decide the pending tool call, then wait
//   node test/step.js answer "<text>"      answer the pending question card, then wait
//   node test/step.js say "<text>"         send a message (queued while it works), then wait
// Every command ends with a report: what the model thought and said last, the tool calls so
// far with the start of their results, and what it is waiting for.
const PORT = process.env.CDP_PORT || 9333;
const [cmd, ...rest] = process.argv.slice(2);
const opt = (k, d) => {
  const i = rest.indexOf(k);
  return i >= 0 ? rest[i + 1] : d;
};
const WAIT_MS = Number(opt('--wait', 540)) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const ev = (expr) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error || msg.result.exceptionDetails ? reject(new Error(JSON.stringify(msg.error || msg.result.exceptionDetails).slice(0, 400))) : resolve(msg.result.result.value)));
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
  const J = JSON.stringify;

  const pendingCard = `[...document.querySelectorAll('.tool')].find(t => t.querySelector('.approval'))`;
  if (cmd === 'start') {
    await ev('window.__aster.newChat()');
    const model = opt('--model', null);
    if (model) await ev(`window.__aster.app.setModel(${J(model)})`);
    const cwd = opt('--cwd', null);
    if (cwd) await ev(`window.__aster.setDraftCwd(${J(cwd)})`);
    await ev(`window.__aster.app.send([{type:'text',text:${J(rest[0])}}], [])`);
  } else if (cmd === 'approve' || cmd === 'deny') {
    const ok = await ev(`(() => { const b = ${pendingCard}?.querySelector('.approval:not(.ask) .btn.${cmd === 'approve' ? 'dark' : 'danger-ghost'}'); if (b) b.click(); return !!b; })()`);
    if (!ok) console.log('(nothing was waiting for approval)');
  } else if (cmd === 'answer') {
    const ok = await ev(`(() => { const i = ${pendingCard}?.querySelector('.approval.ask .ask-input'); if (!i) return false; i.value = ${J(rest[0])}; i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); return true; })()`);
    if (!ok) console.log('(no question was waiting)');
  } else if (cmd === 'say') {
    await ev(`window.__aster.app.send([{type:'text',text:${J(rest[0])}}], [])`);
  } else if (cmd !== 'wait') {
    console.log('unknown command');
    process.exit(1);
  }
  await sleep(1200);

  const started = Date.now();
  let st;
  for (;;) {
    st = await ev(`(() => {
      const card = ${pendingCard};
      return { busy: window.__aster.app.isBusy(), waiting: card ? { ask: !!card.querySelector('.approval.ask'), q: card.querySelector('.approval .q')?.innerText, opts: [...card.querySelectorAll('.approval .btns .btn')].map(b => b.innerText) } : null };
    })()`);
    if (!st.busy || st.waiting || Date.now() - started > WAIT_MS) break;
    await sleep(1000);
  }

  const rep = await ev(`(async () => {
    const live = window.__aster.current();
    const conv = (live && await window.aster.getConversation(live.id).catch(() => null)) || live;
    const msgs = conv?.messages || [];
    const results = new Map();
    for (const m of msgs) if (m.role === 'user' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, (b.is_error ? 'ERROR: ' : '') + (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)));
    const calls = [];
    for (const m of msgs) if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_use') calls.push({ name: b.name, input: b.input, result: results.get(b.id) ?? null });
    const lastA = [...msgs].reverse().find(m => m.role === 'assistant');
    // what is on screen for the message being written right now
    const liveThinking = [...document.querySelectorAll('.thinking-text')].pop()?.innerText || '';
    const liveText = [...document.querySelectorAll('.turn-assistant')].pop()?.querySelectorAll('.md.block');
    return {
      model: conv?.model, cwd: conv?.cwd, count: msgs.length, calls,
      thinking: (lastA?.content || []).filter(b => b.type === 'thinking').map(b => b.thinking).join('\\n') || liveThinking,
      text: (lastA?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\\n'),
      screenText: liveText ? [...liveText].map(e => e.innerText).join('\\n').slice(-1200) : '',
      footer: [...document.querySelectorAll('.a-meta')].pop()?.innerText || '',
      error: document.querySelector('.notice.error')?.innerText || '',
      notices: [...document.querySelectorAll('.notice.info')].map(n => n.innerText),
      checks: document.querySelectorAll('.auto-check').length,
    };
  })()`);

  const cut = (s, n) => (s && s.length > n ? `${s.slice(0, n)} …[+${s.length - n}]` : s || '');
  console.log(`== ${rep.model} mode · ${rep.count} messages · folder ${rep.cwd} · ${Math.round((Date.now() - started) / 1000)}s waited`);
  const shown = rep.calls.slice(-Number(opt('--calls', 4)));
  if (rep.calls.length > shown.length) console.log(`(${rep.calls.length - shown.length} earlier tool calls not shown)`);
  for (const c of shown) {
    console.log(`\n-- ${c.name} ${cut(J(c.input), 700)}`);
    console.log(c.result == null ? '   (no result yet)' : `   => ${cut(c.result.replace(/\r/g, ''), 900)}`);
  }
  if (rep.thinking) console.log(`\n-- thinking (end): ${cut(rep.thinking.slice(-700), 700)}`);
  if (rep.text) console.log(`\n-- says: ${cut(rep.text, 1500)}`);
  if (rep.checks) console.log(`\n(self-check passes so far: ${rep.checks})`);
  for (const n of rep.notices) console.log(`NOTICE: ${n}`);
  if (rep.error) console.log(`ERROR: ${rep.error}`);
  if (st.waiting) console.log(`\n>> WAITING ${st.waiting.ask ? 'for an ANSWER' : 'for APPROVAL'}: ${st.waiting.q}${st.waiting.ask ? `  options: ${st.waiting.opts.join(' | ')}` : ''}`);
  else if (st.busy) console.log('\n>> still working (wait again)');
  else console.log(`\n>> DONE  ${rep.footer}\n-- on screen: ${rep.screenText}`);
  ws.close();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
