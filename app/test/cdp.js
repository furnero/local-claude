// Drives a running Aster test instance over the Chrome DevTools Protocol.
// Start the app with --remote-debugging-port=9333, then:
//   node test/cdp.js eval "<js expression>"        (awaits promises, prints JSON)
//   node test/cdp.js shot out.png [width height]    (screenshot of the window)
//   node test/cdp.js wait "<js expression>" [ms]    (until the expression is truthy)
const fs = require('node:fs');

const PORT = process.env.CDP_PORT || 9333;

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error('no Aster page found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { send, close: () => ws.close() };
}

async function evaluate(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

(async () => {
  const [cmd, a, b, d] = process.argv.slice(2);
  const c = await connect();
  try {
    if (cmd === 'eval') console.log(JSON.stringify(await evaluate(c, a), null, 2));
    else if (cmd === 'wait') {
      const until = Date.now() + Number(b || 15000);
      for (;;) {
        const v = await evaluate(c, a).catch(() => null);
        if (v) {
          console.log('ok', JSON.stringify(v));
          break;
        }
        if (Date.now() > until) throw new Error(`timed out waiting for: ${a}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    } else if (cmd === 'shot') {
      if (b && d) await c.send('Emulation.setDeviceMetricsOverride', { width: Number(b), height: Number(d), deviceScaleFactor: 1, mobile: false });
      const r = await c.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(a, Buffer.from(r.data, 'base64'));
      if (b && d) await c.send('Emulation.clearDeviceMetricsOverride');
      console.log('saved', a);
    }
  } finally {
    c.close();
  }
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
