// Runs one prompt in a running Local Claude (real Ollama) and reports what the model did.
//   node test/drive-real.js "<prompt>" [--model quick|smart|coder] [--cwd <folder>] [--answer "Stay in Quick"] [--deny] [--timeout 600]
// Approvals are clicked "Allow once" (or "Deny" with --deny); question cards get --answer
// (default: their first option). Prints the tool calls, the questions, the final text and timing.
const PORT = process.env.CDP_PORT || 9333;
const args = process.argv.slice(2);
const prompt = args[0];
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i > 0 ? args[i + 1] : d;
};
const model = opt('--model', null);
const answer = opt('--answer', null);
const deny = args.includes('--deny');
const timeout = Number(opt('--timeout', 600)) * 1000;
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
      pending.set(i, (msg) => (msg.error || msg.result.exceptionDetails ? reject(new Error(JSON.stringify(msg.error || msg.result.exceptionDetails))) : resolve(msg.result.result.value)));
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });

  await ev('window.__aster.newChat()');
  if (model) await ev(`window.__aster.app.setModel(${JSON.stringify(model)})`);
  const cwd = opt('--cwd', null);
  if (cwd) await ev(`window.__aster.setDraftCwd(${JSON.stringify(cwd)})`);
  const started = Date.now();
  await ev(`window.__aster.app.send([{type:'text',text:${JSON.stringify(prompt)}}], [])`);
  await sleep(500);
  const asked = [];
  while (Date.now() - started < timeout) {
    const st = await ev(`(() => {
      const card = [...document.querySelectorAll('.tool')].find(t => t.querySelector('.approval'));
      if (!card) return { busy: window.__aster.app.isBusy() };
      const ask = card.querySelector('.approval.ask');
      return { busy: true, ask: !!ask, q: card.querySelector('.approval .q')?.innerText, opts: [...card.querySelectorAll('.approval .btns .btn')].map(b => b.innerText), title: card.querySelector('.tname')?.innerText, sum: card.querySelector('.tsum')?.innerText };
    })()`);
    if (!st.busy) break;
    if (st.q) {
      if (st.ask) {
        const pick = answer && st.opts.includes(answer) ? answer : answer || st.opts[0];
        asked.push(`${st.title}: ${st.q.replace(/\s+/g, ' ')} -> ${pick}`);
        if (st.opts.includes(pick)) await ev(`[...document.querySelectorAll('.approval.ask .btns .btn')].find(b => b.innerText === ${JSON.stringify(pick)}).click()`);
        else await ev(`(() => { const i = document.querySelector('.approval.ask .ask-input'); i.value = ${JSON.stringify(pick || 'ok')}; i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); })()`);
      } else {
        asked.push(`approval: ${st.title} ${st.sum || ''} -> ${deny ? 'Deny' : 'Allow once'}`);
        await ev(`document.querySelector('.tool .approval .btn.${deny ? 'danger-ghost' : 'dark'}').click()`);
      }
    }
    await sleep(700);
  }
  const timedOut = Date.now() - started >= timeout;
  if (timedOut) await ev('window.__aster.app.stop()');
  const out = await ev(`(() => {
    const conv = window.__aster.current();
    const calls = [];
    for (const m of conv?.messages || []) if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_use') calls.push(b.name + ' ' + JSON.stringify(b.input).slice(0, 160));
    const thinking = (conv?.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'thinking').map(b => b.thinking.length);
    const last = [...document.querySelectorAll('.turn-assistant')].pop();
    return { model: conv?.model, calls, thinkingChars: thinking, meta: last?.querySelector('.a-meta')?.innerText, text: [...(last?.querySelectorAll('.md.block') || [])].map(e => e.innerText).join('\\n').slice(-1500), error: document.querySelector('.notice.error')?.innerText };
  })()`);
  console.log(`time: ${Math.round((Date.now() - started) / 1000)}s${timedOut ? ' (TIMED OUT, stopped)' : ''}`);
  console.log(`model at end: ${out.model}`);
  console.log(`thinking blocks (chars): ${JSON.stringify(out.thinkingChars)}`);
  for (const a of asked) console.log(`asked  ${a}`);
  for (const c of out.calls) console.log(`tool   ${c}`);
  console.log(`footer: ${out.meta}`);
  if (out.error) console.log(`ERROR: ${out.error}`);
  console.log(`--- final text ---\n${out.text}`);
  ws.close();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
