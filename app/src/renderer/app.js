import { icon, spark } from './icons.js';
import { esc } from './markdown.js';
import { h, openMenu, closeMenu, confirmDialog, promptDialog, toast, openModal, fmtTokens } from './ui.js';
import { Thread } from './thread.js';
import { Composer } from './composer.js';
import { openSettings } from './settings.js';

const A = window.aster;
const $ = (id) => document.getElementById(id);

let S = null; // state from the main process
let convs = []; // sidebar list
let current = null; // the open conversation (null = new chat)
let draftCwd = null; // working folder picked before a new chat's first message
let suspended = false; // while a re-render is pending, live events are only logged
let monthTokens = 0;
let procList = []; // background processes the model started
const active = new Set();
const logs = new Map(); // convId -> events since its turn started (for replay when opened)

// ---------------------------------------------------------------- app facade for the components

const app = {
  state: () => S,
  settings: () => S.settings,
  models: () => S.models,
  efforts: () => S.efforts,
  mcpServers: () => S.mcp || [],
  toolsConfig: () => S.tools,
  showCost: () => S.settings.showCost,
  modelName(id) {
    if (!id) return '';
    return S.models.find((m) => m.id === app.modeOf(id))?.name || 'Quick';
  },
  // how full the model's context window was at the last answer of the open chat
  contextUse() {
    const metas = Object.entries(current?.meta || {}).sort((a, b) => Number(a[0]) - Number(b[0])).map((e) => e[1]).filter((m) => m.ctx && m.usage);
    const m = metas[metas.length - 1];
    if (!m) return null;
    return { used: (m.usage.input_tokens || 0) + (m.usage.output_tokens || 0), ctx: m.ctx };
  },
  async reloadState() {
    const st = await A.getState();
    S.models = st.models;
    S.settings = st.settings;
    composer.refresh();
  },
  effortName: (id) => S.efforts.find((e) => e.id === id)?.name || id,
  currentModel: () => app.modeOf(current?.model || S.settings.model),
  modeOf: (id) => (id === 'local-agent' ? 'smart' : S.models.some((m) => m.id === id) ? id : 'quick'),
  currentCwd: () => current?.cwd || draftCwd || S.tools.workingDirectory || S.defaultCwd,
  isBusy: () => !!current && active.has(current.id),
  async saveSettings(patch) {
    const before = S.settings;
    S.settings = await A.saveSettings(patch);
    applyAppearance();
    composer.refresh();
    if (before.name !== S.settings.name) {
      renderProfile();
      renderGreeting();
    }
    return S.settings;
  },
  applySettings(s) {
    S.settings = s;
    composer.refresh();
  },
  async setModel(id) {
    if (current) {
      current.model = id;
      await A.setConversationModel(current.id, id);
    }
    await app.saveSettings({ model: id });
  },
  send,
  stop() {
    if (current) A.stop(current.id);
  },
  approve(toolUseId, decision) {
    if (current) A.approve(current.id, toolUseId, decision);
  },
  answer(toolUseId, text) {
    if (current) A.approve(current.id, toolUseId, text);
  },
  processes: () => procList,
  openNotes: () => A.openNotes(app.currentCwd()),
  openMemory: async () => {
    const r = await A.openMemory(app.currentCwd());
    if (r) toast(r);
  },
  processesMenu: (anchor) => processesMenu(anchor),
  retry: () => regenerate(),
  retryMenu(btn) {
    const items = [{ label: 'Retry', icon: 'retry', onClick: () => regenerate() }, { sep: true }, { title: 'Retry with' }];
    for (const m of S.models) if (m.id !== app.currentModel()) items.push({ label: m.name, desc: m.desc, onClick: () => regenerate(m.id) });
    openMenu(btn, items, { placement: 'auto' });
  },
  editMessage,
  preview,
  openSettings: (tab) => openSettings(app, tab),
  onSettingsClosed() {
    app.refreshSettingsPage = null;
  },
  refreshSettingsPage: null,
  onConfig(r) {
    S.config = r.status;
    S.tools = r.tools;
    S.mcp = r.mcp;
    composer.refresh();
  },
  async pickFolder() {
    if (current) {
      current.cwd = await A.pickFolder(current.id);
      toast(`Working folder: ${current.cwd}`);
    } else {
      const p = await A.pickFolderDraft(draftCwd || '');
      if (p) {
        draftCwd = p;
        toast(`Working folder for the new chat: ${p}`);
      }
    }
  },
};

const composer = new Composer(app);
const thread = new Thread($('thread'), $('scroller'), $('to-bottom'), app);

// ---------------------------------------------------------------- appearance

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyAppearance() {
  const t = S.settings.theme;
  const dark = t === 'dark' || (t === 'system' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.font = S.settings.chatFont || 'serif';
  document.documentElement.dataset.thinkOpen = S.settings.thinkingOpen === false ? '0' : '1';
  A.setTitleBar({ symbolColor: dark ? '#c2c0b6' : '#3d3929' });
}
darkQuery.addEventListener('change', () => applyAppearance());

// ---------------------------------------------------------------- sidebar

function setCollapsed(c) {
  $('app').classList.toggle('collapsed', c);
  A.saveSettings({ sidebarCollapsed: c }).then((s) => (S.settings = s));
}

function renderSidebarChrome() {
  $('sb-toggle').innerHTML = icon('sidebar', 19);
  $('sb-toggle').onclick = () => setCollapsed(!$('app').classList.contains('collapsed'));
  $('wordmark').innerHTML = `${spark(20)}<span>Local Claude</span>`;
  $('sb-new').innerHTML = `<span class="new-chat-ic">${icon('plus', 15)}</span><span class="sb-label">New chat</span><span class="kbd">Ctrl N</span>`;
  $('sb-new').onclick = () => newChat();
  $('sb-search').innerHTML = `<span class="ic-wrap">${icon('search', 18)}</span><span class="sb-label">Search</span><span class="kbd">Ctrl K</span>`;
  $('sb-search').onclick = () => openSearch();
  $('profile').onclick = () => profileMenu();
}

function dayBucket(ts) {
  const d = new Date(ts);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= start) return 'Today';
  if (ts >= start - 864e5) return 'Yesterday';
  if (ts >= start - 7 * 864e5) return 'Previous 7 days';
  if (ts >= start - 30 * 864e5) return 'Previous 30 days';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

async function loadList() {
  convs = await A.listConversations();
  renderList();
}

function renderList() {
  const box = $('sb-lists');
  box.innerHTML = '';
  if (!convs.length) {
    box.append(h('div', { class: 'sb-section', text: 'Recents' }), h('div', { class: 'sb-empty', text: 'Your chats will show up here.' }));
    return;
  }
  const starred = convs.filter((c) => c.starred);
  const groups = [];
  if (starred.length) groups.push(['Starred', starred]);
  let last = null;
  for (const c of convs.filter((x) => !x.starred)) {
    const b = dayBucket(c.updatedAt);
    if (!last || last[0] !== b) groups.push((last = [b, []]));
    last[1].push(c);
  }
  for (const [label, items] of groups) {
    box.append(h('div', { class: 'sb-section', text: label }));
    for (const c of items) box.append(listItem(c));
  }
}

function listItem(c) {
  const more = h('button', { class: 'icon-btn sm more', title: 'More', html: icon('dots', 16) });
  const el = h('div', { class: `conv-item${current?.id === c.id ? ' active' : ''}`, title: c.title, 'data-id': c.id }, active.has(c.id) ? h('span', { class: 'busy' }) : null, h('span', { class: 't', text: c.title }), more);
  el.onclick = (e) => {
    if (!more.contains(e.target)) openConv(c.id);
  };
  more.onclick = (e) => {
    e.stopPropagation();
    convMenu(more, c);
  };
  el.oncontextmenu = (e) => {
    e.preventDefault();
    convMenu(more, c);
  };
  return el;
}

function convMenu(anchor, c) {
  openMenu(
    anchor,
    [
      { label: c.starred ? 'Unstar' : 'Star', icon: 'star', onClick: () => starConv(c.id, !c.starred) },
      { label: 'Rename', icon: 'pencil', onClick: () => renameConv(c.id, c.title) },
      { sep: true },
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteConv(c.id, c.title) },
    ],
    { placement: 'below' },
  );
}

async function starConv(id, on) {
  await A.starConversation(id, on);
  if (current?.id === id) current.starred = on;
  await loadList();
  renderTitlebar();
}

async function renameConv(id, title) {
  const t = await promptDialog({ title: 'Rename chat', value: title });
  if (t == null || !t.trim()) return;
  const nt = await A.renameConversation(id, t);
  if (current?.id === id) current.title = nt;
  await loadList();
  renderTitlebar();
}

async function deleteConv(id, title) {
  const ok = await confirmDialog({ title: 'Delete chat?', body: `"${title}" will be deleted permanently.`, confirm: 'Delete', danger: true });
  if (!ok) return;
  await A.deleteConversation(id);
  logs.delete(id);
  active.delete(id);
  if (current?.id === id) newChat();
  await loadList();
}

function renderProfile() {
  const name = S.settings.name || 'You';
  const running = procList.filter((p) => p.running).length;
  const sub = running ? `${running} background process${running === 1 ? '' : 'es'} running` : `Offline · ${fmtTokens(monthTokens)} tokens this month`;
  $('profile').innerHTML = `<span class="avatar">${esc(name.slice(0, 1).toUpperCase())}</span><span class="profile-text"><span class="profile-name">${esc(name)}</span><span class="profile-sub">${esc(sub)}</span></span>`;
}

async function refreshSpend() {
  try {
    const u = await A.getUsage();
    const m = u.months?.[u.month];
    monthTokens = m ? (m.input || 0) + (m.output || 0) : 0;
    renderProfile();
  } catch {}
}

function processesMenu(anchor) {
  const items = [{ title: 'Background processes' }];
  if (!procList.length) items.push({ note: 'None. The model starts them with start_process (for example a test server).' });
  for (const p of procList) {
    items.push({
      label: `${p.id} · ${p.name}`,
      desc: p.running ? `running · pid ${p.pid} · click to stop` : `exited (${p.exitCode}) · click for the log`,
      icon: p.running ? 'terminal' : 'file',
      onClick: async () => {
        if (!p.running) return A.openProcessLog(p.id);
        const ok = await confirmDialog({ title: `Stop ${p.name}?`, body: `${p.command}\n\nThe process and everything it started is killed.`, confirm: 'Stop', danger: true });
        if (ok) A.stopProcess(p.id);
      },
    });
  }
  openMenu(anchor, items, { placement: 'auto' });
}

function profileMenu() {
  openMenu(
    $('profile'),
    [
      { label: 'Settings', icon: 'settings', right: 'Ctrl ,', onClick: () => openSettings(app) },
      { label: 'Project notes', icon: 'fileEdit', onClick: () => app.openNotes() },
      { label: 'Claude memory (read-only)', icon: 'brain', onClick: () => app.openMemory() },
      { label: `Background processes${procList.some((p) => p.running) ? ` (${procList.filter((p) => p.running).length})` : ''}`, icon: 'terminal', onClick: () => processesMenu($('profile')) },
      { label: 'Usage', icon: 'chart', onClick: () => openSettings(app, 'usage') },
      { label: 'Tools & MCP', icon: 'wrench', onClick: () => openSettings(app, 'tools') },
      { label: 'Open config.json', icon: 'wrench', onClick: () => A.openConfig() },
    ],
    { placement: 'above' },
  );
}

// ---------------------------------------------------------------- title bar

function renderTitlebar() {
  const tb = $('titlebar');
  tb.innerHTML = '';
  if (!current) return;
  const b = h('button', { class: 'title-btn', html: `${current.starred ? `<span class="star-on">${icon('star', 15)}</span>` : ''}<span class="t">${esc(current.title)}</span>${icon('chevronDown', 15)}` });
  b.onclick = () => convMenu(b, current);
  tb.append(b);
}

// ---------------------------------------------------------------- views

function greetingText() {
  const hr = new Date().getHours();
  const part = hr < 5 ? 'Up late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  return S.settings.name ? `${part}, ${S.settings.name}` : `${part}`;
}

function renderGreeting() {
  $('greet').innerHTML = `${spark(40, 'idle')}<h1>${esc(greetingText())}</h1>`;
}

const CHIPS = [
  { icon: 'pencil', label: 'Write', text: 'Help me write ' },
  { icon: 'code', label: 'Code', text: 'Write a script that ' },
  { icon: 'terminal', label: 'My PC', text: 'Check my PC and tell me ' },
  { icon: 'globe', label: 'Test server', text: 'Set up a local test server for ' },
  { icon: 'brain', label: 'Where was I', text: "What's the state of " },
];

function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  CHIPS.forEach((c, i) => {
    const b = h('button', { class: 'chip', html: `${icon(c.icon, 16)}<span>${c.label}</span>`, style: { animationDelay: `${0.15 + i * 0.05}s` } });
    b.onclick = () => composer.setText(c.text);
    box.append(b);
  });
}

function showWelcome() {
  $('welcome').hidden = false;
  $('thread-view').hidden = true;
  composer.mount($('slot-welcome'));
  composer.setPlaceholder('How can I help you today?');
  renderGreeting();
  renderChips();
}

function showThread() {
  $('welcome').hidden = true;
  $('thread-view').hidden = false;
  composer.mount($('slot-dock'));
  composer.setPlaceholder('Reply…');
}

function newChat() {
  current = null;
  draftCwd = null;
  closePreview();
  showWelcome();
  renderTitlebar();
  renderList();
  composer.setBusy(false);
  composer.refresh();
  composer.focus();
}

async function openConv(id) {
  if (current?.id === id) return;
  let conv;
  try {
    conv = await A.getConversation(id);
  } catch (e) {
    toast(String(e.message || e), { error: true });
    await loadList();
    return;
  }
  current = conv;
  closePreview();
  showThread();
  thread.render(conv);
  replay(conv.id);
  renderTitlebar();
  renderList();
  composer.setBusy(active.has(conv.id));
  composer.refresh();
  composer.focus();
}

function replay(id) {
  for (const ev of logs.get(id) || []) thread.apply(ev);
}

// ---------------------------------------------------------------- sending

function turnOpts() {
  return { effort: S.settings.effort, webSearch: S.settings.webSearch, computer: S.settings.computer, cwd: draftCwd || undefined };
}

async function send(blocks, names) {
  // still answering: queue the message; the model gets it at its next step
  if (current && active.has(current.id)) {
    try {
      const r = await A.send({ convId: current.id, content: blocks, attachNames: names, model: current.model, opts: turnOpts() });
      if (r.queued) thread.appendQueued(blocks);
      return true;
    } catch (e) {
      toast(cleanErr(e), { error: true });
      return false;
    }
  }
  try {
    if (current) {
      const index = current.messages.length;
      thread.appendUser({ role: 'user', content: blocks }, index);
      if (names.length) current.attachNames[index] = names;
      composer.setBusy(true);
      await A.send({ convId: current.id, content: blocks, attachNames: names, model: current.model, opts: turnOpts() });
    } else {
      suspended = true;
      composer.setBusy(true);
      const res = await A.send({ convId: null, content: blocks, attachNames: names, model: S.settings.model, opts: turnOpts() });
      current = res.conv;
      draftCwd = null;
      showThread();
      thread.render(current);
      thread.root.querySelector('.turn-user')?.style.removeProperty('animation');
      suspended = false;
      replay(current.id);
      renderTitlebar();
      loadList();
    }
    composer.setBusy(active.has(current.id) || true);
    return true;
  } catch (e) {
    suspended = false;
    composer.setBusy(false);
    toast(cleanErr(e), { error: true });
    if (current) {
      // take the optimistic bubble back out
      const conv = await A.getConversation(current.id).catch(() => null);
      if (conv) {
        current = conv;
        thread.render(conv);
      }
    }
    return false;
  }
}

const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function regenerate(model) {
  if (!current || active.has(current.id)) return;
  suspended = true;
  try {
    const res = await A.regenerate({ convId: current.id, model, opts: turnOpts() });
    current = res.conv;
    thread.render(current);
    composer.setBusy(true);
    composer.refresh();
  } catch (e) {
    toast(cleanErr(e), { error: true });
  }
  suspended = false;
  replay(current.id);
}

async function editMessage(index, blocks) {
  if (!current || active.has(current.id)) return;
  suspended = true;
  try {
    const res = await A.edit({ convId: current.id, msgIndex: index, content: blocks, model: current.model, opts: turnOpts() });
    current = res.conv;
    thread.render(current);
    composer.setBusy(true);
  } catch (e) {
    toast(cleanErr(e), { error: true });
  }
  suspended = false;
  replay(current.id);
}

// ---------------------------------------------------------------- live events

A.on('chat:event', async (convId, ev) => {
  if (ev.type === 'turn_start') {
    active.add(convId);
    logs.set(convId, []);
    markBusy(convId, true);
  }
  logs.get(convId)?.push(ev);
  const isCurrent = current && current.id === convId;
  // a queued message can start the next turn right after one ends
  if (ev.type === 'turn_start' && isCurrent) composer.setBusy(true);
  if (isCurrent && !suspended) thread.apply(ev);
  if (ev.type === 'model_switched' && isCurrent) {
    current.model = ev.model;
    composer.refresh();
    toast(`Switched to ${app.modelName(ev.model)} mode`);
  }
  if (ev.type === 'status' && isCurrent) toast(ev.text, { ms: 6000 });
  if (ev.type === 'title') {
    const c = convs.find((x) => x.id === convId);
    if (c) c.title = ev.title;
    if (isCurrent) {
      current.title = ev.title;
      renderTitlebar();
    }
    renderList();
  }
  if (ev.type === 'turn_end') {
    active.delete(convId);
    logs.delete(convId);
    markBusy(convId, false);
    if (isCurrent) {
      composer.setBusy(false);
      const fresh = await A.getConversation(convId).catch(() => null);
      if (fresh && current?.id === convId) {
        const title = current.title;
        current = fresh;
        if (title !== 'New chat' && fresh.title === 'New chat') fresh.title = title;
        thread.conv = fresh;
        thread.turns.forEach((t) => thread.updateFoot(t));
        composer.refresh();
      }
    }
    refreshSpend();
    loadList();
    // "Always allow" decisions are saved by the main process during the turn
    A.getState().then((st) => (S.settings = st.settings)).catch(() => {});
  }
});

function markBusy(convId, on) {
  const el = document.querySelector(`.conv-item[data-id="${convId}"]`);
  if (!el) return;
  const dot = el.querySelector('.busy');
  if (on && !dot) el.prepend(h('span', { class: 'busy' }));
  if (!on && dot) dot.remove();
}

A.on('procs:changed', (list) => {
  procList = list;
  renderProfile();
});

A.on('mcp:status', (s) => {
  S.mcp = s;
  composer.refresh();
  app.refreshSettingsPage?.();
});
A.on('config:changed', (d) => {
  S.config = d.status;
  S.tools = d.tools;
  composer.refresh();
  if (d.status.error) toast(d.status.error, { error: true, ms: 6000 });
  app.refreshSettingsPage?.();
});

// ---------------------------------------------------------------- preview panel

let previewCode = '';
async function preview(code, lang) {
  previewCode = code;
  const isSvg = /svg/.test(lang) || /^\s*<svg[\s>]/i.test(code);
  const html = isSvg ? `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100vh}</style></head><body>${code}</body></html>` : code;
  const url = await A.createPreview(html);
  $('preview-title').textContent = isSvg ? 'SVG preview' : 'HTML preview';
  $('preview-frame').src = url;
  $('preview-code').textContent = code;
  setPreviewTab('preview');
  $('app').classList.add('previewing');
}

function setPreviewTab(t) {
  $('preview-frame').hidden = t !== 'preview';
  $('preview-code').hidden = t !== 'code';
  $('preview-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
}

function closePreview() {
  $('app').classList.remove('previewing');
  setTimeout(() => {
    if (!$('app').classList.contains('previewing')) $('preview-frame').src = 'about:blank';
  }, 400);
}

function initPreview() {
  const seg = $('preview-seg');
  for (const [t, label] of [
    ['preview', 'Preview'],
    ['code', 'Code'],
  ]) {
    const b = h('button', { 'data-t': t, text: label });
    b.onclick = () => setPreviewTab(t);
    seg.append(b);
  }
  const copy = h('button', { class: 'icon-btn sm', title: 'Copy code', html: icon('copy', 16) });
  copy.onclick = () => navigator.clipboard.writeText(previewCode).then(() => toast('Copied'));
  seg.after(copy);
  $('preview-close').innerHTML = icon('x', 17);
  $('preview-close').onclick = closePreview;
}

// ---------------------------------------------------------------- search palette

function openSearch() {
  const input = h('input', { placeholder: 'Search chats…' });
  const res = h('div', { class: 'res' });
  const pal = h('div', { class: 'search-pal' }, h('div', { class: 'sbar', html: icon('search', 18) }, input), res);
  pal.querySelector('.sbar').append(input);
  const close = openModal(pal);
  let sel = 0;
  let results = [];
  let timer = null;
  const draw = () => {
    res.innerHTML = '';
    if (!results.length) res.append(h('div', { class: 'sb-empty', text: input.value ? 'No chats found.' : 'No chats yet.' }));
    results.forEach((r, i) => {
      const row = h('div', { class: `r${i === sel ? ' sel' : ''}` }, h('span', { html: icon('chat', 16) }), h('span', { class: 't', text: r.title }), h('span', { class: 'd', text: r.snippet || dayBucket(r.updatedAt) }));
      row.onclick = () => {
        close();
        openConv(r.id);
      };
      res.append(row);
    });
  };
  const run = async () => {
    const q = input.value.trim();
    results = q ? await A.searchConversations(q) : convs.slice(0, 30);
    sel = 0;
    draw();
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = Math.max(0, Math.min(results.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
      draw();
      res.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && results[sel]) {
      close();
      openConv(results[sel].id);
    }
  });
  run();
  setTimeout(() => input.focus(), 30);
}

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
  if (document.querySelector('.onboard')) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && !e.shiftKey && !e.altKey) {
    if (k === 'n') {
      e.preventDefault();
      closeMenu();
      newChat();
    } else if (k === 'k') {
      e.preventDefault();
      closeMenu();
      if (!document.querySelector('.search-pal')) openSearch();
    } else if (k === 'b') {
      e.preventDefault();
      setCollapsed(!$('app').classList.contains('collapsed'));
    } else if (k === ',') {
      e.preventDefault();
      if (!document.querySelector('.modal')) openSettings(app);
    }
    return;
  }
  if (e.key === 'Escape' && app.isBusy() && !document.querySelector('.overlay,.menu')) {
    app.stop();
    return;
  }
  // start typing anywhere to write into the message box
  const t = e.target;
  const typing = t.closest?.('input, textarea, select, [contenteditable]');
  if (!typing && !document.querySelector('.overlay') && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) composer.focus();
});

// ---------------------------------------------------------------- start

async function init() {
  S = await A.getState();
  for (const id of S.active || []) active.add(id);
  applyAppearance();
  if (S.settings.sidebarCollapsed) $('app').classList.add('collapsed');
  renderSidebarChrome();
  initPreview();
  renderProfile();
  composer.refresh();
  composer.fit();
  showWelcome();
  await loadList();
  refreshSpend();
  A.listProcesses().then((l) => {
    procList = l;
    renderProfile();
  });
  composer.focus();
  window.__aster = { app, thread, composer, state: () => S, current: () => current, openConv, newChat, setDraftCwd: (p) => (draftCwd = p) }; // test hook
}

init();
