// Supervising helper: lets a running chat continue, approving ONLY edit_file / write_file calls
// whose path is the given file. Stops at the first other approval, at a question, or when the
// turn ends, and says which.
//   node test/approve-only.js "<absolute or relative file path>" [--wait 540]
const PORT = process.env.CDP_PORT || 9333;
const target = process.argv[2].replace(/\//g, '\\').toLowerCase();
const wi = process.argv.indexOf('--wait');
const WAIT_MS = (wi > 0 ? Number(process.argv[wi + 1]) : 540) * 1000;
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
      pending.set(i, (msg) => (msg.error || msg.result.exceptionDetails ? reject(new Error(JSON.stringify(msg.error || msg.result.exceptionDetails).slice(0, 300))) : resolve(msg.result.result.value)));
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });

  const started = Date.now();
  let approved = 0;
  let why = 'time is up, still working';
  while (Date.now() - started < WAIT_MS) {
    const st = await ev(`(async () => {
      const card = [...document.querySelectorAll('.tool')].find(t => t.querySelector('.approval'));
      if (!card) return { busy: window.__aster.app.isBusy() };
      if (card.querySelector('.approval.ask')) return { busy: true, ask: card.querySelector('.approval .q')?.innerText };
      const conv = await window.aster.getConversation(window.__aster.current().id);
      const uses = conv.messages.filter(m => m.role === 'assistant').flatMap(m => m.content).filter(b => b.type === 'tool_use');
      // the pending call is the first one without a result
      const done = new Set(conv.messages.filter(m => m.role === 'user' && Array.isArray(m.content)).flatMap(m => m.content).filter(b => b.type === 'tool_result').map(b => b.tool_use_id));
      const u = uses.find(x => !done.has(x.id));
      return { busy: true, use: u ? { name: u.name, input: u.input } : null, cwd: conv.cwd };
    })()`);
    if (!st.busy) {
      why = 'the turn ended';
      break;
    }
    if (st.ask) {
      why = `it asks a question: ${st.ask}`;
      break;
    }
    if (st.use) {
      const p = String(st.use.input?.path || '').replace(/\//g, '\\').toLowerCase();
      const abs = /^[a-z]:\\/.test(p) ? p : `${String(st.cwd).toLowerCase()}\\${p}`;
      const ok = (st.use.name === 'edit_file' || st.use.name === 'write_file') && (abs === target || abs.endsWith(`\\${target}`));
      if (!ok) {
        why = `it wants something else: ${st.use.name} ${JSON.stringify(st.use.input).slice(0, 400)}`;
        break;
      }
      await ev(`[...document.querySelectorAll('.tool')].find(t => t.querySelector('.approval'))?.querySelector('.approval:not(.ask) .btn.dark')?.click()`);
      approved++;
      const what = st.use.name === 'edit_file' ? `edit: ${JSON.stringify(st.use.input.old_string || '').slice(0, 90)} -> ${JSON.stringify(st.use.input.new_string || '').slice(0, 110)}` : `write (${String(st.use.input.content || '').length} chars)`;
      console.log(`approved ${approved}: ${what}`);
      await sleep(1500);
    }
    await sleep(1000);
  }
  console.log(`\nSTOPPED after ${Math.round((Date.now() - started) / 1000)}s, ${approved} approved: ${why}`);
  ws.close();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
