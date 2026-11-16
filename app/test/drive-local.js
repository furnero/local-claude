// End-to-end check of the Local Claude features against test/fake-api.js.
// Start the fake API and the app first (see README "Testing"), then:
//   node test/drive-local.js <api-log.jsonl> <notes-dir> <download-path> [shots-dir]
// Prints PASS/FAIL per check and exits 1 if anything failed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const [logFile, notesDir, dlPath, shots] = process.argv.slice(2);
const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

async function connect() {
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
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => {
    if (!shots) return;
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(r.data, 'base64'));
  };
  return { ev, shot, close: () => ws.close() };
}

const requests = () =>
  fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.path === '/v1/messages');

(async () => {
  const c = await connect();
  const waitFor = async (expr, ms = 20000) => {
    const until = Date.now() + ms;
    for (;;) {
      const v = await c.ev(expr).catch(() => null);
      if (v) return v;
      if (Date.now() > until) return null;
      await sleep(150);
    }
  };
  const say = (t) => c.ev(`window.__aster.app.send([{type:'text',text:${JSON.stringify(t)}}], [])`);
  const idle = () => waitFor('!window.__aster.app.isBusy()', 60000);
  const lastCard = `[...document.querySelectorAll('.tool')].pop()`;
  const clickFirst = (sel) => c.ev(`(() => { const b = ${lastCard}?.querySelector(${JSON.stringify(sel)}); if (b) b.click(); return !!b; })()`);
  const cardText = () => c.ev(`${lastCard}?.innerText || ''`);
  const lastText = () => c.ev(`[...document.querySelectorAll('.turn-assistant')].pop()?.innerText || ''`);

  // 1. plain answer with visible thinking
  await c.ev('window.__aster.newChat()');
  await say('hello there');
  const sawOpenThinking = await waitFor(`document.querySelector('.step.thinking.open .thinking-text')?.innerText.length > 5`, 10000);
  check('thinking is shown expanded while it streams', !!sawOpenThinking);
  await idle();
  await c.shot('1-answer');
  check('answer rendered (table + code)', await c.ev(`!!document.querySelector('.turn-assistant table') && !!document.querySelector('.turn-assistant pre')`));
  check('thinking stays open (setting on)', await c.ev(`!!document.querySelector('.step.thinking.open')`));
  check('footer shows tokens, no $ cost', await c.ev(`(() => { const t = document.querySelector('.a-meta')?.innerText || ''; return /tokens/.test(t) && !/\\$/.test(t) ? t : false })()`));
  let r = requests().pop();
  check('request uses the Quick model with a context window', r.body.model === 'lc-qwen3.5-4b-48k', r.body.model);
  check('thinking enabled in request', r.body.thinking?.type === 'enabled');
  check('quick request offers suggest_smart_mode + ask_user', ['suggest_smart_mode', 'ask_user'].every((n) => r.body.tools.some((t) => t.name === n)));
  check('plan, notes, memory and web tools offered', ['update_plan', 'save_note', 'remove_note', 'search_memory', 'web_search', 'web_fetch'].every((n) => r.body.tools.some((t) => t.name === n)));
  check('process + download tools offered', ['start_process', 'process_output', 'send_input', 'stop_process', 'download_file', 'search_files'].every((n) => r.body.tools.some((t) => t.name === n)));
  check('no Claude-only params (betas, cache, web search)', !r.beta && !r.body.cache_control && !r.body.tools.some((t) => t.type && t.type !== 'custom'));
  check('system prompt holds notes + Claude memory + quick check', /Your notes file for this project/.test(r.body.system) && /Claude memory \(read-only\)/.test(r.body.system) && /Quick mode: check the task first/.test(r.body.system));
  check('chat got a title from the first message', !!(await waitFor(`window.__aster.current()?.title === 'Hello there'`, 5000)));

  // 2. quick mode suggests smart mode; user switches
  await say('this is a complex job, set up a server');
  check('smart-mode question card appears', !!(await waitFor(`!!${lastCard}?.querySelector('.approval.ask')`)));
  await c.shot('2-smart-question');
  check('options are Switch / Stay', /Switch to Smart[\s\S]*Stay in Quick/.test(await cardText()));
  await clickFirst('.approval.ask .btn.dark');
  await idle();
  check('chat switched to Smart', (await c.ev('window.__aster.current().model')) === 'smart');
  check('mode button shows Smart', /Smart/.test(await c.ev(`document.querySelector('.model-btn').innerText`)));
  r = requests().pop();
  check('next request uses the Smart model', r.body.model === 'lc-qwen3.5-9b-48k', r.body.model);
  check('smart system prompt has the careful method', /Smart mode: careful working method/.test(r.body.system) && !/Quick mode: check/.test(r.body.system));
  check('smart request no longer offers suggest_smart_mode', !r.body.tools.some((t) => t.name === 'suggest_smart_mode'));

  // 3. ask_user with an own typed answer
  await say('pick one for me');
  check('ask_user card appears', !!(await waitFor(`!!${lastCard}?.querySelector('.ask-input')`)));
  await c.ev(`(() => { const i = ${lastCard}.querySelector('.ask-input'); i.value = 'Use 1.21.1 please'; i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); })()`);
  await idle();
  r = requests().pop();
  const tr = r.body.messages[r.body.messages.length - 1].content.find((b) => b.type === 'tool_result');
  check('typed answer reached the model', /The user answered: Use 1.21.1 please/.test(JSON.stringify(tr?.content)));

  // 4. background process: start (approval), watch, type, stop
  await say('start server now');
  check('start_process asks for approval', !!(await waitFor(`!!${lastCard}?.querySelector('.approval:not(.ask)')`)));
  await clickFirst('.approval .btn.dark');
  await idle();
  check('process started (p1 running)', /p1 "fake server" running/.test(await cardText()));
  check('smart mode ran the automatic self-check', !!(await waitFor(`document.querySelectorAll('.auto-check').length >= 1 && /Checked: everything verified/.test([...document.querySelectorAll('.turn-assistant')].pop().innerText)`, 5000)), (await lastText()).slice(-120));
  r = requests().pop();
  check('self-check prompt reached the model', /^\[Automatic check\]/.test(r.body.messages[r.body.messages.length - 1].content[0].text));
  check('self-check is not shown as a user bubble', !(await c.ev(`[...document.querySelectorAll('.bubble')].some(b => /Automatic check/.test(b.innerText))`)));
  check('process listed in the app', !!(await waitFor(`window.__aster.app.processes().some(p => p.id === 'p1' && p.running)`, 5000)));
  await say('watch server output');
  await idle();
  check('process_output waited for "tick 8"', /"tick 8" appeared/.test(await cardText()));
  await say('type into the server');
  await waitFor(`!!${lastCard}?.querySelector('.approval')`);
  await clickFirst('.approval .btn.dark');
  await idle();
  check('send_input typed "stop"', /Typed "stop" into p1/.test(await cardText()));
  await say('kill server');
  await waitFor(`!!${lastCard}?.querySelector('.approval')`);
  await clickFirst('.approval .btn.dark');
  await idle();
  check('stop_process ended it', /p1 "fake server" exited/.test(await cardText()), (await cardText()).slice(0, 120));
  await c.shot('4-process');

  // 5. download
  await say('download it');
  await waitFor(`!!${lastCard}?.querySelector('.approval')`);
  await clickFirst('.approval .btn.dark');
  await idle();
  const size = fs.existsSync(dlPath) ? fs.statSync(dlPath).size : -1;
  check('download_file saved the file', size === 3 * 1048576 + 123, `${size} bytes`);
  check('download result has SHA-256', /SHA-256 [0-9a-f]{64}/.test(await cardText()));

  // 6. own notes: written without approval
  await say('note this down');
  await idle();
  const notes = fs.readdirSync(notesDir).map((f) => fs.readFileSync(path.join(notesDir, f), 'utf8')).join('\n');
  check('notes edit ran without approval', /fake test entry/.test(notes));
  check('notes file has the template + Folder line', /## Needs fixing/.test(notes) && /Folder: /.test(notes));

  // 7. Claude memory is read-only
  await say('touch memory please');
  await idle();
  const blocked = path.join(os.homedir(), '.claude', 'zz-should-not-exist.md');
  check('write under ~/.claude was blocked', !fs.existsSync(blocked) && /read-only/.test(await cardText()));

  // 8. search_files
  await say('find files with productName');
  await idle();
  check('search_files found package.json', /package\.json/.test(await cardText()));

  // 8b. plan checklist, notes tools, memory search, web page
  await say('make a plan first');
  await idle();
  check('plan card shows a checklist', (await c.ev(`(() => { const l = [...document.querySelectorAll('.todo-list')].pop(); return l ? [...l.children].map(li => li.className).join(',') : '' })()`)) === 'done,doing,pending');
  await say('remember this please');
  await idle();
  const readNotes = () => fs.readdirSync(notesDir).map((f) => fs.readFileSync(path.join(notesDir, f), 'utf8')).join('\n');
  check('save_note wrote a dated entry under Facts', /## Facts and decisions\r?\n- \d{4}-\d\d-\d\d: fake fact 42 lives in the attic/.test(readNotes()), (readNotes().split('## Facts')[1] || '').slice(0, 90));
  await say('recall it now');
  await idle();
  check('search_memory found the note', /your notes[\s\S]*fake fact 42/.test(await cardText()));
  await say('forget it again');
  await idle();
  check('remove_note deleted the entry', !/fake fact 42/.test(readNotes()) && /fake test entry/.test(readNotes()));
  await say('read the page for me');
  check('web_fetch asks for approval', !!(await waitFor(`!!${lastCard}?.querySelector('.approval:not(.ask)')`)));
  await clickFirst('.approval .btn.dark');
  await idle();
  const pageText = await cardText();
  check('web_fetch returned readable text (no script/nav)', /Fake Page/.test(pageText) && /newest build is 1\.21\.1-99 & it is stable/.test(pageText) && !/var hidden|menu/.test(pageText.split('OUTPUT')[1] || ''));

  // 8c. a message sent while it works is queued and delivered with the tool result
  await say('slow job please');
  await waitFor(`!!${lastCard}?.querySelector('.approval')`);
  await clickFirst('.approval .btn.dark');
  await sleep(800);
  check(
    'send button: Stop when the box is empty, Send when there is text',
    await c.ev(`(() => { const ta = document.querySelector('textarea'); const btn = document.querySelector('.send-btn'); const c = window.__aster.composer; ta.value = 'x'; c.updateSend(); const send = !btn.classList.contains('stop'); ta.value = ''; c.updateSend(); return send && btn.classList.contains('stop'); })()`),
  );
  await say('also use port 25570');
  check('queued bubble is shown', !!(await waitFor(`!!document.querySelector('.user-wrap.is-queued')`, 3000)));
  await idle();
  const withQueue = requests().find((q) => q.body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result') && m.content.some((b) => b.type === 'text' && /while you were working[\s\S]*also use port 25570/.test(b.text))));
  check('queued message reached the model with the tool result', !!withQueue);
  check('queued bubble marked as delivered', (await c.ev(`document.querySelectorAll('.user-wrap.was-queued').length`)) === 1 && !(await c.ev(`!!document.querySelector('.user-wrap.is-queued')`)));
  check('integer sent as a string was accepted ("30")', /slow done/.test(await c.ev(`[...document.querySelectorAll('.tool')].filter(t => /Start-Sleep/.test(t.innerText)).pop()?.innerText || ''`)));
  await c.shot('8-queued');

  // 8d. history looks the same after reopening the chat
  const convId = await c.ev('window.__aster.current().id');
  await c.ev('window.__aster.newChat()');
  await c.ev(`window.__aster.openConv('${convId}')`);
  await sleep(600);
  check(
    'reopened chat keeps the queued bubble, check notes and plan',
    await c.ev(`document.querySelectorAll('.user-wrap.was-queued').length === 1 && document.querySelectorAll('.auto-check').length >= 1 && !!document.querySelector('.todo-list') && ![...document.querySelectorAll('.bubble')].some(b => /Automatic check|while you were working/.test(b.innerText))`),
  );

  // 8e. settings: pick another model for Smart mode
  await c.ev(`window.__aster.app.openSettings('key')`);
  check('models page lists installed models and the GPU', !!(await waitFor(`document.querySelectorAll('.model-pick').length === 3 && /Test GPU/.test(document.querySelector('.modal').innerText)`, 5000)));
  await c.shot('8-models');
  await c.ev(`(() => { const s = document.querySelectorAll('.model-pick')[1].querySelector('select'); s.value = 'plainchat:7b'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(700);
  check('context choices follow the model (8k max, plus Custom)', (await c.ev(`[...document.querySelectorAll('.model-pick')[1].querySelectorAll('select')[1].options].map(o => o.value).join(',')`)) === '8192,custom');
  check('page warns about missing tools', /No tools: chat only/.test(await c.ev(`document.querySelector('.modal').innerText`)));
  await c.ev(`document.querySelector('.set-close').click()`);
  await say('hello once more');
  await idle();
  r = requests().pop();
  check('other model is used, without the tools or thinking it lacks', r.body.model === 'lc-plainchat-7b-8k' && !r.body.tools && !r.body.thinking, `${r.body.model} tools:${!!r.body.tools}`);
  check('max_tokens follows the smaller window', r.body.max_tokens <= 2731, String(r.body.max_tokens));
  await c.ev(`window.__aster.app.saveSettings({ modes: {} }).then(() => window.__aster.app.reloadState())`);

  // 8f. settings: RAM limit, keep in memory, a context size typed by hand
  await c.ev(`window.__aster.app.openSettings('key')`);
  await waitFor(`document.querySelectorAll('.model-pick').length === 3`, 5000);
  const modalText = () => c.ev(`document.querySelector('.modal').innerText`);
  check('models page shows RAM, the limit field and the keep-in-memory choice', /System RAM/.test(await modalText()) && /RAM limit for models/.test(await modalText()) && /Keep the model in memory/.test(await modalText()));
  check('mode card estimates the RAM a model needs', /needs roughly [\d.]+ GB of RAM/.test(await modalText()));
  // type a custom context size for Quick mode
  await c.ev(`(() => { const s = document.querySelectorAll('.model-pick')[0].querySelectorAll('select')[1]; s.value = 'custom'; s.dispatchEvent(new Event('change')); })()`);
  check('choosing Custom shows a number field', await c.ev(`!document.querySelectorAll('.ctx-custom')[0].hidden`));
  await c.ev(`(() => { const i = document.querySelectorAll('.ctx-custom')[0].querySelector('input'); i.value = '20000'; i.dispatchEvent(new Event('change')); })()`);
  await sleep(700);
  check('custom context is saved', (await c.ev(`window.__aster.app.settings().modes.quick.ctx`)) === 20000);
  // a value below the minimum is raised to it
  await c.ev(`(() => { const i = document.querySelectorAll('.ctx-custom')[0].querySelector('input'); i.value = '100'; i.dispatchEvent(new Event('change')); })()`);
  await sleep(700);
  check('too small a context is raised to the minimum', (await c.ev(`window.__aster.app.settings().modes.quick.ctx`)) === 2048);
  await c.ev(`(() => { const i = document.querySelectorAll('.ctx-custom')[0].querySelector('input'); i.value = '20000'; i.dispatchEvent(new Event('change')); })()`);
  await sleep(700);
  // RAM limit far below what Smart needs
  await c.ev(`(() => { const i = [...document.querySelectorAll('.modal .set-row')].find(r => /RAM limit for models/.test(r.innerText)).querySelector('input'); i.value = '0.1'; i.dispatchEvent(new Event('change')); })()`);
  await waitFor(`/over your 0.1 GB limit/.test(document.querySelector('.modal')?.innerText || '')`, 5000);
  check('RAM limit is saved and the too-big mode is marked', (await c.ev(`window.__aster.app.settings().ramLimitGb`)) === 0.1 && /over your 0.1 GB limit/.test(await modalText()));
  await c.ev(`(() => { const s = [...document.querySelectorAll('.modal .set-row')].find(r => /Keep the model in memory/.test(r.innerText)).querySelector('select'); s.value = '0'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(500);
  check('keep-in-memory choice is saved', (await c.ev(`window.__aster.app.settings().keepAlive`)) === '0');
  await c.shot('8-memory');
  await c.ev(`document.querySelector('.set-close').click()`);
  // Smart mode is over the limit: the turn is refused with a pointer to the settings
  await say('hello under a tight limit');
  await idle();
  const errText = await c.ev(`document.querySelector('.notice.error')?.innerText || ''`);
  check('a model over the RAM limit is refused with a clear message', /RAM limit is 0\.1 GB/.test(errText) && /Open settings/.test(errText), errText.slice(0, 120));
  // Quick with the typed context size still fits and runs
  await c.ev('window.__aster.newChat()');
  await c.ev(`window.__aster.app.setModel('quick')`);
  await say('hello with a custom context');
  await idle();
  r = requests().pop();
  check('typed context size is used for the model', r.body.model === 'lc-qwen3.5-4b-20000t', r.body.model);
  await c.ev(`window.__aster.app.saveSettings({ modes: {}, ramLimitGb: 0, keepAlive: '5m' }).then(() => window.__aster.app.reloadState())`);
  await c.ev(`window.__aster.app.setModel('smart')`);

  // 8g. the third mode: Coder
  check('the mode menu offers Quick, Smart, Coder and Coder 30B', (await c.ev(`window.__aster.state().models.map(m => m.name).join(',')`)) === 'Quick,Smart,Coder,Coder 30B');
  await c.ev('window.__aster.newChat()');
  await c.ev(`window.__aster.app.setModel('coder')`);
  check('mode button shows Coder', /Coder/.test(await c.ev(`document.querySelector('.model-btn').innerText`)));
  await say('hello from coder mode');
  await idle();
  r = requests().pop();
  check('Coder mode uses the abliterated coding model', r.body.model === 'lc-huihui-ai-qwen3.5-abliterated-9b-omnicoder-48k', r.body.model);
  check('Coder prompt has the coder section and the careful method', /# Coder mode/.test(r.body.system) && /Smart mode: careful working method/.test(r.body.system) && !/Quick mode: check/.test(r.body.system));
  check('Coder does not offer suggest_smart_mode', !r.body.tools.some((t) => t.name === 'suggest_smart_mode'));
  check('the chat keeps Coder mode and shows it under the answer', (await c.ev('window.__aster.current().model')) === 'coder' && /Coder/.test(await c.ev(`[...document.querySelectorAll('.a-meta')].pop()?.innerText || ''`)));
  await c.ev(`window.__aster.app.setModel('smart')`);

  // 8h. the colibri engine mode
  await c.ev('window.__aster.newChat()');
  await c.ev(`window.__aster.app.setModel('coder30')`);
  check('mode button shows Coder 30B', /Coder 30B/.test(await c.ev(`document.querySelector('.model-btn').innerText`)));
  await say('hello from the big coder');
  await idle();
  r = requests().pop();
  check('Coder 30B sends the colibri model, with tools and without a thinking setting', r.body.model === 'qwen3-coder-30b' && Array.isArray(r.body.tools) && !r.body.thinking, `${r.body.model} thinking:${JSON.stringify(r.body.thinking)}`);
  check('Coder 30B prompt names the model and has the coder section', /Qwen3-Coder 30B/.test(r.body.system) && /# Coder mode/.test(r.body.system));
  check('the chat keeps Coder 30B and shows it under the answer', (await c.ev('window.__aster.current().model')) === 'coder30' && /Coder 30B/.test(await c.ev(`[...document.querySelectorAll('.a-meta')].pop()?.innerText || ''`)));
  await c.ev(`window.__aster.app.openSettings('key')`);
  check('settings show the colibrì card with its folders', !!(await waitFor(`/Coder 30B mode \\(colibrì engine\\)/.test(document.querySelector('.modal')?.innerText || '') && /Engine folder/.test(document.querySelector('.modal').innerText) && /Blocks kept in RAM/.test(document.querySelector('.modal').innerText)`, 5000)));
  check('the Ollama mode cards are still three', (await c.ev(`document.querySelectorAll('.model-pick').length`)) === 3);
  await c.shot('8-colibri');
  await c.ev(`document.querySelector('.set-close').click()`);
  await c.ev(`window.__aster.app.setModel('smart')`);

  // 9. thinking off
  await c.ev(`window.__aster.app.saveSettings({ effort: 'off' })`);
  await say('hello again');
  await idle();
  r = requests().pop();
  check('thinking off sends thinking disabled', r.body.thinking?.type === 'disabled');
  await c.ev(`window.__aster.app.saveSettings({ effort: 'default' })`);
  await c.shot('9-final');

  c.close();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
