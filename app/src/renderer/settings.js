// Settings window (General, Local models, Tools & MCP, Usage). No onboarding: nothing to link.
import { icon, spark } from './icons.js';
import { esc } from './markdown.js';
import { h, openModal, confirmDialog, toast, fmtTokens } from './ui.js';

const TABS = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'key', label: 'Local models', icon: 'brain' },
  { id: 'tools', label: 'Tools & MCP', icon: 'terminal' },
  { id: 'usage', label: 'Usage', icon: 'chart' },
];

function seg(options, value, onPick) {
  const el = h('div', { class: 'seg' });
  for (const o of options) {
    const b = h('button', { class: o.id === value ? 'on' : '', html: `${o.icon ? icon(o.icon, 14) : ''}${esc(o.label)}` });
    b.onclick = () => {
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      onPick(o.id);
    };
    el.append(b);
  }
  return el;
}

function row(title, sub, control) {
  return h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('b', { text: title }), sub ? h('span', { text: sub }) : null), control);
}

function toggle(on, onChange) {
  const t = h('button', { class: `toggle${on ? ' on' : ''}`, role: 'switch' });
  t.onclick = () => {
    t.classList.toggle('on');
    onChange(t.classList.contains('on'));
  };
  return t;
}

export function openSettings(app, tab = 'general') {
  const nav = h('div', { class: 'set-nav' }, h('h2', { text: 'Settings' }));
  const body = h('div', { class: 'set-body' });
  const closeBtn = h('button', { class: 'icon-btn set-close', html: icon('x', 18), title: 'Close' });
  const modal = h('div', { class: 'modal' }, nav, body);
  const close = openModal(modal, { onClose: () => app.onSettingsClosed() });
  closeBtn.onclick = close;
  const show = (id) => {
    nav.querySelectorAll('.set-tab').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
    body.innerHTML = '';
    body.append(closeBtn);
    const page = h('div', { class: 'set-page' });
    body.append(page);
    ({ general, key, tools, usage })[id](app, page, close);
  };
  for (const t of TABS) {
    const b = h('button', { class: 'set-tab', 'data-id': t.id, html: `${icon(t.icon, 17)}<span>${t.label}</span>` });
    b.onclick = () => show(t.id);
    nav.append(b);
  }
  show(tab);
  app.refreshSettingsPage = () => {
    const on = nav.querySelector('.set-tab.on')?.dataset.id;
    if (on === 'tools') show('tools');
  };
}

function general(app, page) {
  const s = app.settings();
  const name = h('input', { class: 'input', value: s.name || '', placeholder: 'Your name' });
  name.onchange = () => app.saveSettings({ name: name.value.trim() });
  const ci = h('textarea', { class: 'textarea', placeholder: 'For example: "Answer in German. Keep answers short. I mostly work with Python and PowerShell."' });
  ci.value = s.customInstructions || '';
  ci.onchange = () => app.saveSettings({ customInstructions: ci.value });
  const model = h('select', { class: 'select', style: { width: '200px' } });
  for (const m of app.models()) model.append(h('option', { value: m.id, text: m.name, selected: m.id === s.model }));
  model.onchange = () => app.saveSettings({ model: model.value });
  for (const o of model.options) o.selected = o.value === app.modeOf(s.model);
  page.append(
    h('h3', { text: 'General' }),
    h('div', { class: 'field' }, h('label', { text: 'What should the assistant call you?' }), name),
    row('Appearance', null, seg([{ id: 'system', label: 'System', icon: 'monitor' }, { id: 'light', label: 'Light', icon: 'sun' }, { id: 'dark', label: 'Dark', icon: 'moon' }], s.theme, (v) => app.saveSettings({ theme: v }))),
    row('Chat font', null, seg([{ id: 'serif', label: 'Serif' }, { id: 'sans', label: 'Sans' }, { id: 'system', label: 'System' }], s.chatFont, (v) => app.saveSettings({ chatFont: v }))),
    row('Send with', null, seg([{ id: 'enter', label: 'Enter' }, { id: 'ctrl', label: 'Ctrl+Enter' }], s.sendWithEnter ? 'enter' : 'ctrl', (v) => app.saveSettings({ sendWithEnter: v === 'enter' }))),
    row('Default mode', 'Used for new chats', model),
    row('Check its own work', 'Before it finishes a job where it changed or ran things, the model must verify the results with its tools. Takes longer, catches mistakes.', seg([{ id: 'off', label: 'Off' }, { id: 'smart', label: 'Smart + Coder' }, { id: 'always', label: 'Always' }], s.selfCheck || 'smart', (v) => app.saveSettings({ selfCheck: v }))),
    row('Keep thought process open', 'Shows the reasoning expanded after it finishes (it is always shown while the model thinks)', toggle(s.thinkingOpen !== false, (v) => app.saveSettings({ thinkingOpen: v }))),
    row('Show tokens and speed', 'Under each answer: tokens, tokens per second, time, context use', toggle(s.showCost, (v) => app.saveSettings({ showCost: v }))),
    h('div', { class: 'field' }, h('label', { text: 'Custom instructions' }), h('div', { class: 'hint', text: 'Sent with every message.' }), ci),
  );
}

async function key(app, page) {
  page.append(h('h3', { text: 'Local models' }));
  const loading = h('div', { class: 'hint', text: 'Asking Ollama…' });
  page.append(loading);
  const [ov, proj, coli, srv] = await Promise.all([window.aster.ollamaOverview(), window.aster.projectInfo(app.currentCwd()), window.aster.colibriStatus(), window.aster.serverStatus()]);
  loading.remove();
  const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
  const vram = ov.gpu?.vramMb || 0;
  const ctxLabel = (n) => (n % 1024 === 0 ? `${n / 1024}k tokens` : `${n.toLocaleString()} tokens`);
  // same rough rule as the app uses: what does not fit on the graphics card goes into RAM
  const ramNeed = (m, ctx) => Math.max(0, Math.round(m.sizeMb * 1.08 + (ctx / 1024) * 28 - vram * 0.95));

  // how a model of this size sits on the GPU (weights plus working memory for the context)
  const fitText = (m, ctx) => {
    if (!m) return 'Not installed';
    if (!vram) return gb(m.sizeMb);
    const need = m.sizeMb * 1.08 + (ctx / 1024) * 28;
    if (need <= vram * 0.95) return `${gb(m.sizeMb)} · fits on the ${ov.gpu.name}`;
    if (m.sizeMb <= vram * 0.95) return `${gb(m.sizeMb)} · fits, but this context size spills onto the CPU (slower)`;
    return `${gb(m.sizeMb)} · bigger than the ${ov.gpu.name}'s ${gb(vram)}: runs partly on the CPU, much slower`;
  };

  const modeCard = (mode, title, sub) => {
    const cfg = ov.modes[mode];
    const sel = h('select', { class: 'select' });
    const names = ov.models.map((m) => m.name);
    if (!names.includes(cfg.base)) sel.append(h('option', { value: cfg.base, text: `${cfg.base} (not installed)`, selected: true }));
    for (const m of ov.models) sel.append(h('option', { value: m.name, text: `${m.name}${m.params ? ` · ${m.params}` : ''}`, selected: m.name === cfg.base }));
    const ctxSel = h('select', { class: 'select' });
    const ctxInput = h('input', { class: 'input', type: 'number', min: String(ov.minCtx), step: '1024', placeholder: 'tokens', title: 'Context size in tokens' });
    const ctxWrap = h('div', { class: 'ctx-custom', hidden: true }, ctxInput, h('span', { class: 'hint', text: 'tokens. Enter to save.' }));
    let custom = !ov.ctxChoices.includes(cfg.ctx);
    const maxOf = () => ov.models.find((x) => x.name === sel.value)?.maxCtx || 1048576;
    const ctxOf = () => (custom ? Math.round(Math.min(Math.max(Number(ctxInput.value) || cfg.ctx, ov.minCtx), maxOf())) : Number(ctxSel.value));
    const info = h('div', { class: 'cap-row' });
    const fillCtx = () => {
      const m = ov.models.find((x) => x.name === sel.value);
      const max = m?.maxCtx || 0;
      const want = custom ? ctxOf() : Number(ctxSel.value) || cfg.ctx;
      ctxSel.innerHTML = '';
      const choices = ov.ctxChoices.filter((c) => !max || c <= max);
      if (!choices.length) choices.push(ov.ctxChoices[0]);
      const pick = choices.includes(want) ? want : choices.reduce((a, c) => (Math.abs(c - want) < Math.abs(a - want) ? c : a), choices[0]);
      for (const c of choices) ctxSel.append(h('option', { value: String(c), text: ctxLabel(c), selected: !custom && c === pick }));
      ctxSel.append(h('option', { value: 'custom', text: 'Custom…', selected: custom }));
      ctxWrap.hidden = !custom;
      if (custom) ctxInput.value = String(want);
      ctxInput.max = String(maxOf());
    };
    const drawInfo = () => {
      const m = ov.models.find((x) => x.name === sel.value);
      info.innerHTML = '';
      const badge = (ok, yes, no) => h('span', { class: `badge ${ok ? 'ok' : 'err'}`, text: ok ? yes : no });
      if (m) {
        info.append(badge(m.caps.includes('tools'), 'Tools', 'No tools: chat only'), badge(m.caps.includes('thinking'), 'Thinking', 'No visible thinking'));
        if (m.caps.includes('vision')) info.append(h('span', { class: 'badge ok', text: 'Images' }));
      }
      info.append(h('span', { class: 'hint', text: fitText(m, ctxOf()) }));
      const need = m ? ramNeed(m, ctxOf()) : 0;
      if (need > 0) info.append(h('span', { class: `hint${ov.ramLimitGb && need > ov.ramLimitGb * 1024 ? ' over' : ''}`, text: `· needs roughly ${gb(need)} of RAM${ov.ramLimitGb && need > ov.ramLimitGb * 1024 ? ` (over your ${ov.ramLimitGb} GB limit)` : ''}` }));
    };
    const save = async () => {
      const modes = { ...(app.settings().modes || {}), [mode]: { base: sel.value, ctx: ctxOf() } };
      await app.saveSettings({ modes });
      ov.modes[mode] = modes[mode];
      await app.reloadState();
      drawInfo();
      toast(`${title} now uses ${sel.value} (${ctxLabel(ctxOf())})`);
    };
    sel.onchange = () => {
      fillCtx();
      save();
    };
    ctxSel.onchange = () => {
      if (ctxSel.value === 'custom') {
        // start from the current size; nothing is saved until a number is confirmed
        ctxInput.value = String(cfg.ctx);
        custom = true;
        ctxWrap.hidden = false;
        ctxInput.focus();
        ctxInput.select();
        return;
      }
      custom = false;
      ctxWrap.hidden = true;
      save();
    };
    const saveCustom = () => {
      if (!custom) return;
      ctxInput.value = String(ctxOf()); // show the value after clamping to what the model allows
      save();
    };
    ctxInput.addEventListener('change', saveCustom);
    ctxInput.addEventListener('keydown', (e) => e.key === 'Enter' && ctxInput.blur());
    fillCtx();
    drawInfo();
    return h('div', { class: 'card' }, h('b', { text: title }), h('div', { class: 'hint', text: sub }), h('div', { class: 'model-pick' }, sel, ctxSel), ctxWrap, info);
  };

  // Coder 30B: the colibri engine
  const colibriCard = () => {
    const save = async (patch) => {
      await app.saveSettings({ colibri: { ...(app.settings().colibri || {}), ...patch } });
      await app.reloadState();
      page.innerHTML = '';
      key(app, page);
    };
    const folderRow = (label, sub, value, field) =>
      row(label, `${value}${sub ? ` · ${sub}` : ''}`, h('button', { class: 'btn ghost sm', text: 'Change', onclick: async () => {
        const p = await window.aster.colibriPickFolder(value);
        if (p) save({ [field]: p });
      } }));
    const cap = h('select', { class: 'select', style: { width: '170px' } });
    for (const n of coli.capChoices) cap.append(h('option', { value: String(n), text: n ? `${n} per layer` : 'Automatic', selected: n === coli.cap }));
    cap.onchange = () => save({ cap: Number(cap.value) });
    const ctxSel = h('select', { class: 'select', style: { width: '170px' } });
    for (const n of [8192, 16384, 32768, 49152, 65536]) ctxSel.append(h('option', { value: String(n), text: ctxLabel(n), selected: n === coli.ctx }));
    if (![8192, 16384, 32768, 49152, 65536].includes(coli.ctx)) ctxSel.append(h('option', { value: String(coli.ctx), text: ctxLabel(coli.ctx), selected: true }));
    ctxSel.onchange = () => save({ ctx: Number(ctxSel.value) });
    const gpu = h('select', { class: 'select', style: { width: '170px' } });
    for (const [v, label] of [['auto', 'Use it (Vulkan)'], ['none', 'CPU only']]) gpu.append(h('option', { value: v, text: label, selected: v === coli.gpu }));
    gpu.onchange = () => save({ gpu: gpu.value });
    const state = coli.running ? 'Running' : !coli.installed ? 'Engine not found' : !coli.modelReady ? 'Model not found' : 'Stopped';
    const stopBtn = h('button', { class: 'btn ghost sm', text: 'Stop', onclick: async () => {
      await window.aster.colibriStop();
      toast('colibrì stopped');
      page.innerHTML = '';
      key(app, page);
    } });
    return h(
      'div',
      { class: 'card' },
      h('b', { text: 'Coder 30B mode (colibrì engine)' }),
      h('div', { class: 'hint', text: 'A 30B coding model that could never fit on the graphics card. colibrì keeps the shared part in RAM and reads the specialist blocks from the SSD as needed. Stronger than the 9B models, and slow: on a GTX 1070 with 16 GB of RAM it writes one to two words a second, and the first answer of a chat takes about 10 minutes while it reads the instructions. Later messages in the same chat start within seconds, unless you pressed Stop or the chat outgrew the context: then it reads everything again. Close other programs first: free RAM is what makes it faster. The app starts it when a Coder 30B chat needs it and stops it when another mode needs the memory.' }),
      row('Status', coli.running ? `Answering on 127.0.0.1:${coli.port}` : 'Starts on the first message in this mode (about a minute)', coli.running ? stopBtn : h('span', { class: `badge ${coli.installed && coli.modelReady ? '' : 'err'}`, text: state })),
      folderRow('Engine folder', coli.installed ? '' : 'coli.cmd not found here', coli.dir, 'dir'),
      folderRow('Model folder', coli.modelReady ? '' : 'no model found here', coli.modelDir, 'modelDir'),
      row('Blocks kept in RAM', 'More is faster and needs more RAM: 32 is about 4 GB, 128 about 15 GB. Automatic sizes it from the RAM that is free when it starts.', cap),
      row('Context size', 'How much of the chat it sees at once. A full 16k costs about 1.4 GB of RAM.', ctxSel),
      row('Graphics card', 'Cards older than the RTX 30 series go through Vulkan. Pick CPU only if that fails.', gpu),
      h('div', { class: 'hint', text: 'Changes apply the next time the engine starts (Stop it first).' }),
    );
  };

  // Server mode: a model on another machine of the user's
  const serverCard = () => {
    const save = async (patch) => {
      await app.saveSettings({ server: { ...(app.settings().server || {}), ...patch } });
      await app.reloadState();
      page.innerHTML = '';
      key(app, page);
    };
    const text = (value, placeholder, field, width = '260px') => {
      const i = h('input', { class: 'input mono', value: value || '', placeholder, spellcheck: 'false', style: { width } });
      i.addEventListener('change', () => save({ [field]: i.value.trim() }));
      i.addEventListener('keydown', (e) => e.key === 'Enter' && i.blur());
      return i;
    };
    const keyRow = h('div', { style: { display: 'flex', gap: '8px' } }, text(srv.key, 'optional', 'key', '180px'), h('button', { class: 'btn ghost sm', text: 'Browse', onclick: async () => {
      const p = await window.aster.serverPickKey(srv.key);
      if (p) save({ key: p });
    } }));
    const port = h('input', { class: 'input', type: 'number', min: '1024', max: '65535', value: String(srv.port), style: { width: '110px' } });
    port.addEventListener('change', () => save({ port: Number(port.value) || 11435 }));
    let model;
    if (srv.models.length) {
      model = h('select', { class: 'select', style: { width: '260px' } });
      if (srv.base && !srv.models.includes(srv.base)) model.append(h('option', { value: srv.base, text: `${srv.base} (not on the server)`, selected: true }));
      if (!srv.base) model.append(h('option', { value: '', text: 'Pick a model', selected: true }));
      for (const n of srv.models) model.append(h('option', { value: n, text: n, selected: n === srv.base }));
      model.onchange = () => save({ base: model.value });
    } else model = text(srv.base, 'for example  qwen3-coder:30b', 'base');
    const ctxSel = h('select', { class: 'select', style: { width: '170px' } });
    for (const n of srv.ctxChoices) ctxSel.append(h('option', { value: String(n), text: ctxLabel(n), selected: n === srv.ctx }));
    if (!srv.ctxChoices.includes(srv.ctx)) ctxSel.append(h('option', { value: String(srv.ctx), text: ctxLabel(srv.ctx), selected: true }));
    ctxSel.onchange = () => save({ ctx: Number(ctxSel.value) });
    const state = h('span', { class: `badge ${srv.reachable ? 'ok' : srv.configured ? 'err' : ''}`, text: srv.reachable ? 'Connected' : srv.ssh || srv.url ? 'Not connected' : 'Not set up' });
    const result = h('div', { class: 'hint', text: srv.error || '' });
    if (srv.error) result.style.color = 'var(--danger)';
    const check = h('button', { class: 'btn ghost sm', text: 'Connect and check', onclick: async () => {
      check.disabled = true;
      result.style.color = '';
      result.textContent = 'Connecting…';
      const r = await window.aster.serverStatus(true);
      if (r.reachable) {
        toast(`Connected: ${r.models.length} model${r.models.length === 1 ? '' : 's'} on the server`);
        page.innerHTML = '';
        key(app, page);
        return;
      }
      check.disabled = false;
      result.textContent = r.error || 'The server does not answer.';
      result.style.color = 'var(--danger)';
    } });
    return h(
      'div',
      { class: 'card', 'data-card': 'server' },
      h('b', { text: 'Server mode (a model on another machine)' }),
      h('div', { class: 'hint', text: 'Runs the model on a server of yours that has Ollama, for example one with more RAM than this PC. The tools still act on this PC; only the model runs over there. The app opens an SSH tunnel when a chat needs it and closes it when the app closes. The SSH key must work without a password prompt, and you must have connected to the server once before, so its identity is known. The mode shows up in the mode menu once a server and a model are entered.' }),
      row('Status', srv.reachable ? `${srv.models.length} model${srv.models.length === 1 ? '' : 's'} on the server` : 'Fill in the server, then connect', h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, state, check)),
      result,
      row('SSH target', 'user@host, or a host name from your SSH config', text(srv.ssh, 'user@host', 'ssh')),
      row('SSH key file', 'Leave empty to use your default key', keyRow),
      row('Port on this PC', 'The local end of the tunnel. 11434 is this PC\'s own Ollama, so use another one.', port),
      row('Direct address instead', 'Only for a server on your own network without SSH, for example http://192.168.1.20:11434', text(srv.url, 'empty when SSH is used', 'url')),
      row('Model', 'A model that is installed in the server\'s Ollama', model),
      row('Context size', 'Each 16k costs the server about 1.5 GB of RAM with a 30B model.', ctxSel),
    );
  };

  // RAM limit + how long a model stays loaded
  const memoryCard = () => {
    const limit = h('input', { class: 'input', type: 'number', min: '0', step: '0.5', placeholder: 'no limit', value: ov.ramLimitGb ? String(ov.ramLimitGb) : '', style: { width: '110px' } });
    const saveLimit = async () => {
      const v = Math.max(0, Math.min(Number(limit.value) || 0, 1024));
      limit.value = v ? String(v) : '';
      if (v === ov.ramLimitGb) return;
      await app.saveSettings({ ramLimitGb: v });
      toast(v ? `RAM limit for models: ${v} GB` : 'RAM limit switched off');
      page.innerHTML = '';
      key(app, page);
    };
    limit.addEventListener('change', saveLimit);
    limit.addEventListener('keydown', (e) => e.key === 'Enter' && limit.blur());
    const keep = h('select', { class: 'select', style: { width: '230px' } });
    for (const [v, label] of [['0', 'Unload right after each answer'], ['5m', '5 minutes'], ['30m', '30 minutes'], ['-1', 'Until the app closes']]) keep.append(h('option', { value: v, text: label, selected: v === ov.keepAlive }));
    keep.onchange = async () => {
      await app.saveSettings({ keepAlive: keep.value });
      ov.keepAlive = keep.value;
      toast('Saved');
    };
    const now = ov.loaded.length
      ? ov.loaded.map((m) => `${m.name}: ${gb(m.ramMb)} RAM + ${gb(m.vramMb)} graphics memory`).join(' · ')
      : 'No model is loaded right now.';
    return h(
      'div',
      { class: 'card' },
      h('b', { text: 'Memory' }),
      row('RAM limit for models (GB)', 'The part of a model that does not fit on the graphics card sits in normal RAM. If a model takes more RAM than this, the app unloads it again and tells you, instead of letting the PC run out. Empty = no limit.', limit),
      row('Keep the model in memory', 'Longer = the next answer starts faster. Shorter = the memory is free again sooner.', keep),
      h('div', { class: 'hint', text: `In memory now: ${now}` }),
    );
  };

  // download
  const pullInput = h('input', { class: 'input mono', placeholder: 'for example  qwen3.5:27b', spellcheck: 'false' });
  const pullBtn = h('button', { class: 'btn dark sm', text: 'Download' });
  const pullState = h('div', { class: 'hint' });
  const bar = h('div', { class: 'pull-bar', hidden: true }, h('i'));
  let off = null;
  const pull = async () => {
    const name = pullInput.value.trim();
    if (!name) return;
    if (pullBtn.dataset.busy) {
      window.aster.cancelPull();
      return;
    }
    pullBtn.dataset.busy = '1';
    pullBtn.textContent = 'Cancel';
    bar.hidden = false;
    pullState.textContent = 'Starting…';
    off = window.aster.on('ollama:pull', (p) => {
      pullState.textContent = `${p.status}${p.percent != null ? ` · ${p.percent}%` : ''}`;
      if (p.percent != null) bar.firstChild.style.width = `${p.percent}%`;
    });
    const r = await window.aster.pullModel(name);
    off?.();
    delete pullBtn.dataset.busy;
    pullBtn.textContent = 'Download';
    bar.hidden = true;
    bar.firstChild.style.width = '0';
    if (!r.ok) {
      pullState.textContent = r.error;
      pullState.style.color = 'var(--danger)';
      return;
    }
    toast(`${name} downloaded`);
    page.innerHTML = '';
    key(app, page);
  };
  pullBtn.onclick = pull;
  pullInput.addEventListener('keydown', (e) => e.key === 'Enter' && pull());

  page.append(
    h(
      'div',
      { class: 'card' },
      h('b', { text: 'This PC' }),
      row('Ollama', ov.fake ? 'Test API' : 'http://127.0.0.1:11434 · started automatically when needed', h('span', { class: `badge ${ov.ok ? 'ok' : 'err'}`, text: ov.ok ? 'Running' : 'Not running' })),
      row('System RAM', `${gb(ov.ram.totalMb)} in total · ${gb(ov.ram.freeMb)} free right now`, h('span')),
      row('Graphics card', ov.gpu ? `${ov.gpu.name} · ${gb(ov.gpu.vramMb)} of memory` : ov.hw?.gpu ? `${ov.hw.gpu.name} · ${gb(ov.hw.gpu.vramMb)}: too little for the models, they run on the CPU` : 'None found with its own memory (models run on the CPU)', h('span')),
      row('Models for this PC', 'Checks the hardware again and shows which model it would run in each mode. Nothing changes until you apply it.', h('button', { class: 'btn ghost sm', text: 'Check this PC', onclick: () => app.openSetup() })),
      h('div', { class: 'hint', text: ov.models.length ? `${ov.models.length} model${ov.models.length === 1 ? '' : 's'} installed. Chatting needs no internet; only downloading a model does.` : ov.ok ? 'No models installed yet. Download one below.' : 'Ollama is not running, so the installed models are unknown. Is Ollama installed?' }),
    ),
    modeCard('quick', 'Quick mode', 'The fast everyday model. Pick one that fits fully on the graphics card.'),
    modeCard('smart', 'Smart mode', 'The model for complex jobs. Bigger is better here; with a bigger card you can pick a much bigger model.'),
    modeCard('coder', 'Coder mode', 'A coding model with the refusals removed ("abliterated"), used with the same careful method as Smart. It still asks before commands and file changes.'),
    colibriCard(),
    serverCard(),
    memoryCard(),
    h(
      'div',
      { class: 'card' },
      h('b', { text: 'Download a model' }),
      h('div', { class: 'hint', text: 'Any model name from the Ollama library. Needs internet once; for tool use pick a model that lists "tools". Rough guide for size: the file should be smaller than your card\'s memory (8 GB card: up to 9B, 24 GB: about 30B, 32 GB: about 35B, more only with several cards or lots of patience).' }),
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } }, pullInput, pullBtn),
      bar,
      pullState,
    ),
    h(
      'div',
      { class: 'card' },
      h('b', { text: 'Context window' }),
      h('div', { class: 'hint', text: 'How much of a chat the model can see at once. Ollama\'s own default is too small for tool use, so the app sets the size you pick above for each mode. A bigger window needs more graphics memory. When a chat outgrows it, the app leaves out the oldest tool output first, and the bar next to the mode name shows how full it is.' }),
    ),
    h(
      'div',
      { class: 'card' },
      h('b', { text: 'Notes and Claude memory' }),
      row('Project notes', proj.notesFile, h('button', { class: 'btn ghost sm', text: 'Open', onclick: () => app.openNotes() })),
      row('All notes', proj.notesRoot, h('span')),
      row('Claude memory (read-only)', proj.memDir || 'None for this folder', proj.memDir ? h('button', { class: 'btn ghost sm', text: 'Open', onclick: () => app.openMemory() }) : h('span')),
      h('div', { class: 'hint', text: 'The working folder of a chat picks its project. The model reads and updates its own notes; Claude\'s memory is read-only for it.' }),
    ),
  );
}

function tools(app, page) {
  const st = app.state();
  const t = st.tools;
  const cfgErr = st.config.error ? h('div', { class: 'server' }, h('div', { class: 'err', text: st.config.error })) : null;
  const btn = (label, ic, fn) => h('button', { class: 'btn ghost sm', html: `${icon(ic, 15)}${label}`, onclick: fn });
  const servers = app.mcpServers();
  const list = h('div', {});
  if (!servers.length) list.append(h('div', { class: 'hint', text: 'No MCP servers configured.' }));
  for (const s of servers) {
    const restart = h('button', { class: 'btn ghost sm', text: 'Restart' });
    restart.onclick = async () => {
      restart.disabled = true;
      await window.aster.restartServer(s.name);
    };
    list.append(
      h(
        'div',
        { class: 'server' },
        h('div', { class: 'top' }, h('span', { class: `dot ${s.state}` }), h('span', { class: 'nm', text: s.name }), h('span', { class: 'badge', text: s.state === 'ready' ? `${s.tools.length} tools` : s.state }), restart),
        s.state === 'ready' && s.tools.length ? h('div', { class: 'tl', text: s.tools.map((x) => x.name).join(', ') }) : null,
        s.error ? h('div', { class: 'err', text: s.error }) : null,
      ),
    );
  }
  const allowed = Object.keys(app.settings().toolPermissions || {});
  const resetPerm = h('button', { class: 'btn ghost sm', text: 'Ask again for all' });
  resetPerm.onclick = async () => {
    const s = await window.aster.resetPermissions();
    app.applySettings(s);
    toast('Approvals reset');
    page.innerHTML = '';
    tools(app, page);
  };
  const example = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Users\\\\you\\\\Documents"]
    }
  },
  "tools": {
    "shell": { "enabled": true, "approval": "ask", "timeoutSeconds": 120 },
    "files": { "enabled": true, "readApproval": "auto", "writeApproval": "ask" },
    "web": { "enabled": true, "approval": "ask" },
    "workingDirectory": ""
  }
}`;
  page.append(
    h('h3', { text: 'Tools & MCP' }),
    h(
      'div',
      { class: 'card' },
      h('b', { text: 'config.json' }),
      h('div', { class: 'mono-path', text: st.config.path }),
      h('div', { class: 'hint', text: 'Works like Claude Desktop\'s claude_desktop_config.json: add servers under "mcpServers". Changes are picked up automatically when you save the file.' }),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        btn('Open', 'file', () => window.aster.openConfig()),
        btn('Show in folder', 'folder', () => window.aster.revealConfig()),
        btn('Reload', 'retry', async () => {
          const r = await window.aster.reloadConfig();
          app.onConfig(r);
          toast(r.status.error ? 'config.json has an error' : 'Config reloaded', { error: !!r.status.error });
        }),
        btn('Import from Claude Desktop', 'download', async () => {
          const r = await window.aster.importClaudeDesktop();
          if (!r.ok) toast(r.error, { error: true });
          else toast(r.added.length ? `Imported ${r.added.join(', ')}` : 'All of those servers are already in config.json');
        }),
      ),
      cfgErr,
    ),
    h(
      'div',
      { class: 'card' },
      h('b', { text: 'Built-in computer tools' }),
      row('Terminal', t.shell.enabled ? `${st.shells.join(', ')} · ${t.shell.approval === 'auto' ? 'runs without asking' : 'asks before each command'} · ${t.shell.timeoutSeconds}s timeout` : 'Switched off in config.json', h('span', { class: `badge ${t.shell.enabled ? 'ok' : ''}`, text: t.shell.enabled ? 'On' : 'Off' })),
      row('Files', t.files.enabled ? `Reading ${t.files.readApproval === 'auto' ? 'without asking' : 'asks'} · writing ${t.files.writeApproval === 'auto' ? 'without asking' : 'asks'}` : 'Switched off in config.json', h('span', { class: `badge ${t.files.enabled ? 'ok' : ''}`, text: t.files.enabled ? 'On' : 'Off' })),
      row('Web', t.web?.enabled === false ? 'Switched off in config.json' : `Search and read pages while online · ${t.web?.approval === 'auto' ? 'without asking' : 'asks before each request'}`, h('span', { class: `badge ${t.web?.enabled === false ? '' : 'ok'}`, text: t.web?.enabled === false ? 'Off' : 'On' })),
      row('Always allowed', allowed.length ? allowed.join(', ') : 'Nothing yet', allowed.length ? resetPerm : h('span')),
    ),
    h('div', { class: 'card' }, h('b', { text: 'MCP servers' }), list),
    h('div', { class: 'field' }, h('div', { class: 'lbl', text: 'Example config.json' }), h('pre', { class: 'tool-pre', text: example })),
  );
}

async function usage(app, page) {
  page.append(h('h3', { text: 'Usage' }));
  const u = await window.aster.getUsage();
  const m = u.months?.[u.month] || { input: 0, output: 0, requests: 0, byModel: {} };
  const tot = (x) => (x.input || 0) + (x.output || 0);
  page.append(
    h(
      'div',
      { class: 'stat-grid' },
      h('div', { class: 'stat' }, h('div', { class: 'v', text: fmtTokens(m.output) }), h('div', { class: 'l', text: 'Tokens written this month' })),
      h('div', { class: 'stat' }, h('div', { class: 'v', text: String(m.requests) }), h('div', { class: 'l', text: 'Requests this month' })),
      h('div', { class: 'stat' }, h('div', { class: 'v', text: fmtTokens(m.input) }), h('div', { class: 'l', text: 'Tokens read this month' })),
    ),
  );
  const entries = Object.entries(m.byModel || {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  const bars = h('div', { class: 'bars' });
  for (const [id, c] of entries) {
    bars.append(h('div', { class: 'bar-row' }, h('span', { text: app.modelName(id) }), h('div', { class: 'bar' }, h('i', { style: { width: `${Math.max(2, (c / max) * 100)}%` } })), h('span', { text: fmtTokens(c), style: { textAlign: 'right' } })));
  }
  if (entries.length) page.append(h('div', { class: 'card' }, h('b', { text: 'Tokens by mode this month' }), bars));
  const months = Object.entries(u.months || {}).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12);
  if (months.length > 1) {
    const mb = h('div', { class: 'bars' });
    const mmax = Math.max(...months.map((x) => tot(x[1])), 1);
    for (const [k, v] of months) mb.append(h('div', { class: 'bar-row' }, h('span', { text: k }), h('div', { class: 'bar' }, h('i', { style: { width: `${Math.max(2, (tot(v) / mmax) * 100)}%` } })), h('span', { text: fmtTokens(tot(v)), style: { textAlign: 'right' } })));
    page.append(h('div', { class: 'card' }, h('b', { text: 'By month' }), mb));
  }
  page.append(h('div', { class: 'hint', text: 'Local models cost nothing per token; these counts only show how much work the GPU did.' }));
}
