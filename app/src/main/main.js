const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, nativeTheme, protocol } = require('electron');

// test hook: a separate profile folder, so test runs never touch the real chats or key
if (process.env.ASTER_USERDATA) app.setPath('userData', path.resolve(process.env.ASTER_USERDATA));
else {
  // Chats and settings live next to the notes (<LocalClaude>data), not in %APPDATA%: the app
  // stays one self-contained folder, and every way of starting it sees the same chats.
  const lcRoot = require('./project').root();
  if (lcRoot) app.setPath('userData', path.join(lcRoot, 'data'));
}
// test hook: an off-screen window that keeps painting, so automated runs can take screenshots
const TEST_OFFSCREEN = process.env.ASTER_TEST_OFFSCREEN === '1';
if (TEST_OFFSCREEN) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const store = require('./store');
const config = require('./config');
const mcp = require('./mcp');
const chat = require('./chat');
const tools = require('./tools');
const ollama = require('./ollama');
const colibri = require('./colibri');
const hardware = require('./hardware');
const project = require('./project');
const processes = require('./processes');
const { MODELS, EFFORTS, modeOf } = require('./models');

// HTML/SVG previews load from their own origin (aster-preview://), so they run in a sandboxed
// frame with none of the app's privileges and aren't bound by the app's content policy.
protocol.registerSchemesAsPrivileged([{ scheme: 'aster-preview', privileges: { standard: true, secure: true } }]);
const previews = new Map(); // id -> html (the newest 30)

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId('localclaude.chat');

let win = null;

function createWindow() {
  const s = store.getSettings();
  const dark = s.theme === 'dark' || (s.theme === 'system' && nativeTheme.shouldUseDarkColors);
  const b = s.windowBounds || {};
  win = new BrowserWindow({
    width: TEST_OFFSCREEN ? 1280 : b.width || 1280,
    height: TEST_OFFSCREEN ? 860 : b.height || 860,
    x: TEST_OFFSCREEN ? -4000 : b.x,
    y: TEST_OFFSCREEN ? 40 : b.y,
    skipTaskbar: TEST_OFFSCREEN,
    minWidth: 680,
    minHeight: 520,
    show: false,
    title: 'Local Claude',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    backgroundColor: dark ? '#262624' : '#faf9f5',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#c2c0b6' : '#3d3929', height: 48 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: !TEST_OFFSCREEN,
    },
  });
  if (b.maximized && !TEST_OFFSCREEN) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // links open in the real browser; the app window never navigates away
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
    if (input.type === 'keyDown' && input.control && !input.shift && ['=', '+', '-', '0'].includes(input.key)) {
      const z = win.webContents.getZoomLevel();
      win.webContents.setZoomLevel(input.key === '0' ? 0 : Math.max(-3, Math.min(4, z + (input.key === '-' ? -0.5 : 0.5))));
      e.preventDefault();
    }
  });

  const saveBounds = () => {
    if (!win || win.isDestroyed() || TEST_OFFSCREEN) return;
    store.saveSettings({ windowBounds: { ...(win.isMaximized() ? store.getSettings().windowBounds || {} : win.getBounds()), maximized: win.isMaximized() } });
  };
  win.on('close', saveBounds);
  win.on('closed', () => (win = null));
}

const send = (channel, ...args) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

chat.setEmitter((convId, ev) => send('chat:event', convId, ev));
mcp.onStatus((s) => send('mcp:status', s));
config.onChange(() => {
  send('config:changed', { status: config.status(), tools: config.get().tools, servers: Object.keys(config.get().mcpServers) });
  mcp.sync();
});

// ---------------------------------------------------------------- helpers

// a user message that isn't tool results (those may also carry messages queued mid-turn)
const isAutoCheck = (m) => Array.isArray(m.content) && m.content[0]?.type === 'text' && m.content[0].text.startsWith(chat.CHECK_MARK);
const isRealUser = (m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')) && !isAutoCheck(m);

function truncate(conv, index) {
  conv.messages = conv.messages.slice(0, index);
  for (const k of Object.keys(conv.meta)) if (Number(k) >= index) delete conv.meta[k];
  for (const k of Object.keys(conv.attachNames || {})) if (Number(k) >= index) delete conv.attachNames[k];
}

function turnOpts(o = {}) {
  const s = store.getSettings();
  return {
    effort: o.effort ?? s.effort,
    webSearch: o.webSearch ?? s.webSearch,
    computer: o.computer ?? s.computer,
  };
}

function start(conv, o) {
  chat.runTurn(conv, turnOpts(o)).catch((e) => send('chat:event', conv.id, { type: 'turn_end', error: { message: String(e.message || e), kind: 'other' } }));
}

function getConv(id) {
  const c = store.getConversation(id);
  if (!c) throw new Error('That chat no longer exists.');
  c.meta ||= {};
  c.attachNames ||= {};
  return c;
}

// ---------------------------------------------------------------- IPC

const handle = (ch, fn) => ipcMain.handle(ch, (_e, ...args) => fn(...args));
const modelInfoOf = (id) => MODELS.find((m) => m.id === modeOf(id));

// ---------------------------------------------------------------- setup for this PC's hardware

const SETUP_MODES = MODELS.filter((m) => !m.engine).map((m) => m.id);

/**
 * What this PC has, what the app would pick for it, and what is installed already.
 * `override` replaces the detected hardware; only the test API honours it.
 */
async function setupPlan(override) {
  let hw = await hardware.probe();
  if (ollama.FAKE && override && typeof override === 'object') hw = { ...hw, ...override, gpu: override.gpu || null, gpus: override.gpu ? [override.gpu] : [] };
  const rec = hardware.recommend(hw);
  const st = await ollama.installState();
  const isIn = (base) => ollama.has(st.names, base);
  const modes = {};
  for (const id of SETUP_MODES) {
    const cur = ollama.modeConfig(id);
    const pick = rec.modes[id];
    modes[id] = {
      name: modelInfoOf(id).name,
      pick: { base: pick.base, sizeMb: pick.sizeMb, ctx: pick.ctx, where: pick.where, spillMb: pick.spillMb, installed: isIn(pick.base) },
      current: { base: cur.base, ctx: cur.ctx, installed: isIn(cur.base) },
      choices: hardware.LADDERS[id].map((m) => ({ base: m.base, sizeMb: m.sizeMb, installed: isIn(m.base), ...hardware.fitModel(m, hw) })),
    };
  }
  const s = store.getSettings();
  const missing = SETUP_MODES.filter((id) => !modes[id].current.installed);
  return {
    hw: { gpu: hw.gpu, gpus: hw.gpus, ramMb: hw.ramMb, cpu: hw.cpu, disk: hw.disk },
    card: rec.card,
    notes: rec.notes,
    modes,
    ollama: { found: st.found, ok: st.ok },
    // the dialog opens by itself only on a PC where the app cannot work yet, and only until it was answered once
    needed: !s.setup?.done && !s.setup?.dismissed && (!st.ok || missing.length > 0),
    done: !!s.setup?.done,
    colibri: { available: colibri.available() },
  };
}
handle('setup:plan', (override) => setupPlan(override));

/**
 * Saves the chosen model and context per mode. A mode is only saved when its model is really
 * installed, so a cancelled download never leaves a mode pointing at nothing.
 */
handle('setup:apply', async (picks) => {
  const st = await ollama.installState();
  const modes = { ...(store.getSettings().modes || {}) };
  const saved = [];
  const skipped = [];
  const warnings = [];
  for (const id of SETUP_MODES) {
    const p = picks?.[id];
    if (!p || typeof p.base !== 'string') continue;
    if (!ollama.has(st.names, p.base)) {
      skipped.push(id);
      continue;
    }
    const ctx = Math.round(Math.min(Math.max(Number(p.ctx) || 49152, 2048), 1048576));
    modes[id] = { base: p.base, ctx };
    saved.push(id);
    const caps = await ollama.capsOf(p.base);
    if (caps && !caps.includes('tools')) warnings.push(`${p.base} has no tool support: ${modelInfoOf(id).name} mode can only chat with it.`);
  }
  const done = saved.length > 0 && !skipped.length;
  store.saveSettings({ modes, setup: { ...(store.getSettings().setup || {}), done: done || !!store.getSettings().setup?.done, at: Date.now() } });
  ollama.settingsChanged();
  return { saved, skipped, warnings };
});
handle('setup:dismiss', () => {
  store.saveSettings({ setup: { ...(store.getSettings().setup || {}), dismissed: true } });
  return true;
});

handle('state:get', () => ({
  hasKey: true, // no key: everything runs on the local Ollama
  keyHint: null,
  defaultCwd: config.workingDirectory(),
  // a default mode whose engine is not on this PC falls back to Smart (the saved setting stays)
  settings: modelInfoOf(store.getSettings().model)?.engine === 'colibri' && !colibri.available() ? { ...store.getSettings(), model: 'smart' } : store.getSettings(),
  // "unavailable" modes stay in the list so old chats keep their name, but the mode menu leaves them out
  models: MODELS.map(({ id, name, desc, smart, engine }) =>
    engine === 'colibri'
      ? { id, name, desc, smart, engine, base: colibri.labelOf(colibri.config()), ctx: colibri.config().ctx, unavailable: !colibri.available() }
      : { id, name, desc: `${ollama.modeConfig(id).base} · ${desc}`, smart, base: ollama.modeConfig(id).base, ctx: ollama.modeConfig(id).ctx },
  ),
  efforts: EFFORTS,
  config: config.status(),
  tools: config.get().tools,
  mcp: mcp.status(),
  shells: Object.keys(tools.findShells()),
  version: app.getVersion(),
  active: chat.activeIds(),
  userData: store.dir(),
}));

// project notes / Claude memory of a working folder
handle('project:info', (cwd) => {
  const info = project.resolve(cwd || config.workingDirectory());
  return { ...info, notesExists: require('node:fs').existsSync(info.notesFile), notesRoot: project.notesRoot() };
});
handle('project:openNotes', (cwd) => {
  const folder = cwd || config.workingDirectory();
  const info = project.resolve(folder);
  project.ensureNotes(info, folder);
  return shell.openPath(info.notesFile);
});
handle('project:openMemory', (cwd) => {
  const info = project.resolve(cwd || config.workingDirectory());
  return info.memDir ? shell.openPath(info.memDir) : 'No Claude memory for this folder.';
});

// background processes the model started
handle('procs:list', () => processes.list());
handle('procs:stop', (id) => {
  const p = processes.get(id);
  if (p) processes.stop(p);
  return true;
});
handle('procs:log', (id) => {
  const p = processes.get(id);
  if (p) shell.openPath(p.logFile);
});

handle('ollama:overview', () => ollama.overview());
handle('colibri:status', () => colibri.status());
handle('colibri:stop', async () => {
  await colibri.stop();
  return colibri.status();
});
handle('colibri:pickFolder', async (current) => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the folder', defaultPath: current || undefined, properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0] || null;
});
handle('ollama:pull', (name) => {
  name = String(name || '').trim();
  if (!/^[\w.\-/]+(:[\w.\-]+)?$/.test(name)) return { ok: false, error: 'That does not look like a model name (example: qwen3.5:9b).' };
  return ollama.pull(name, (p) => send('ollama:pull', { name, ...p }));
});
handle('ollama:cancelPull', () => ollama.cancelPull());

handle('settings:save', (patch) => {
  const s = store.saveSettings(patch || {});
  if (patch && (patch.modes || 'ramLimitGb' in patch || 'keepAlive' in patch)) ollama.settingsChanged();
  return s;
});

handle('conv:list', () => store.listConversations());
handle('conv:get', (id) => getConv(id));
handle('conv:rename', (id, title) => {
  const c = getConv(id);
  c.title = String(title || '').trim().slice(0, 120) || c.title;
  store.saveConversation(c);
  return c.title;
});
handle('conv:star', (id, starred) => {
  const c = getConv(id);
  c.starred = !!starred;
  store.saveConversation(c);
  return c.starred;
});
handle('conv:delete', (id) => {
  chat.stop(id);
  store.deleteConversation(id);
  return true;
});
handle('conv:setModel', (id, model) => {
  const c = getConv(id);
  c.model = modeOf(model);
  store.saveConversation(c);
  return true;
});
handle('conv:pickFolder', async (id) => {
  const c = getConv(id);
  const r = await dialog.showOpenDialog(win, { title: 'Working folder for this chat', defaultPath: c.cwd, properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return c.cwd;
  c.cwd = r.filePaths[0];
  store.saveConversation(c);
  return c.cwd;
});

handle('conv:pickFolderDraft', async (current) => {
  const r = await dialog.showOpenDialog(win, { title: 'Working folder for the new chat', defaultPath: current || config.workingDirectory(), properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0] || null;
});
handle('conv:search', (q) => {
  const needle = String(q || '').toLowerCase().trim();
  if (!needle) return [];
  const out = [];
  for (const meta of store.listConversations()) {
    if (meta.title.toLowerCase().includes(needle)) {
      out.push({ ...meta, snippet: '' });
      continue;
    }
    const c = store.getConversation(meta.id);
    for (const m of c?.messages || []) {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
      const hit = blocks.find((b) => b.type === 'text' && b.text.toLowerCase().includes(needle));
      if (hit) {
        const i = hit.text.toLowerCase().indexOf(needle);
        out.push({ ...meta, snippet: `…${hit.text.slice(Math.max(0, i - 30), i + 50).replace(/\s+/g, ' ')}…` });
        break;
      }
    }
    if (out.length >= 40) break;
  }
  return out;
});
handle('preview:create', (html) => {
  const id = crypto.randomBytes(8).toString('hex');
  previews.set(id, String(html));
  while (previews.size > 30) previews.delete(previews.keys().next().value);
  return `aster-preview://p/${id}`;
});

handle('chat:send', ({ convId, content, attachNames, model, opts }) => {
  let conv;
  if (convId) conv = getConv(convId);
  else {
    conv = chat.createConversation(model);
    if (opts?.cwd) conv.cwd = opts.cwd;
    conv.title = chat.titleFor(content) || conv.title;
  }
  // still answering: queue it; it reaches the model at its next step
  if (convId && chat.enqueue(conv.id, content)) return { convId: conv.id, queued: true };
  if (chat.isActive(conv.id)) throw new Error('This chat is still answering.');
  if (model) conv.model = modeOf(model);
  const index = conv.messages.length;
  conv.messages.push({ role: 'user', content });
  if (attachNames?.length) conv.attachNames[index] = attachNames;
  conv.updatedAt = Date.now();
  store.saveConversation(conv);
  start(conv, opts);
  return { convId: conv.id, msgIndex: index, conv };
});

handle('chat:regenerate', ({ convId, model, opts }) => {
  const conv = getConv(convId);
  if (chat.isActive(conv.id)) throw new Error('This chat is still answering.');
  let last = -1;
  conv.messages.forEach((m, i) => {
    if (isRealUser(m)) last = i;
  });
  if (last < 0) throw new Error('Nothing to regenerate.');
  truncate(conv, last + 1);
  if (model) conv.model = modeOf(model);
  store.saveConversation(conv);
  start(conv, opts);
  return { conv };
});

handle('chat:edit', ({ convId, msgIndex, content, model, opts }) => {
  const conv = getConv(convId);
  if (chat.isActive(conv.id)) throw new Error('This chat is still answering.');
  if (!conv.messages[msgIndex] || !isRealUser(conv.messages[msgIndex])) throw new Error("Can't edit that message.");
  const names = conv.attachNames[msgIndex];
  truncate(conv, msgIndex);
  conv.messages.push({ role: 'user', content });
  if (names) conv.attachNames[msgIndex] = names;
  if (model) conv.model = modeOf(model);
  store.saveConversation(conv);
  start(conv, opts);
  return { conv };
});

handle('chat:stop', (convId) => chat.stop(convId));
handle('chat:approve', (convId, toolUseId, decision) => chat.approve(convId, toolUseId, decision));

handle('config:open', () => shell.openPath(config.configPath()));
handle('config:reveal', () => shell.showItemInFolder(config.configPath()));
handle('config:reload', async () => {
  config.load();
  await mcp.sync();
  return { status: config.status(), tools: config.get().tools, mcp: mcp.status() };
});
handle('config:import', () => config.importClaudeDesktop());
handle('mcp:restart', (name) => mcp.restart(name));
handle('mcp:status', () => mcp.status());

handle('usage:get', () => ({ ...store.getUsage(), month: store.monthKey() }));
handle('permissions:reset', () => store.saveSettings({ toolPermissions: {} }));

handle('window:titlebar', ({ symbolColor }) => {
  if (win && !win.isDestroyed()) {
    try {
      win.setTitleBarOverlay({ color: '#00000000', symbolColor, height: 48 });
    } catch {}
  }
});
handle('app:openExternal', (url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
});
handle('app:revealData', () => shell.openPath(store.dir()));

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('aster-preview', (req) => {
    const id = new URL(req.url).pathname.replace(/^\//, '');
    const html = previews.get(id);
    if (html == null) return new Response('Preview expired', { status: 404 });
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  mcp.setVersion(app.getVersion());
  config.load();
  config.watch();
  processes.init({ dir: path.join(store.dir(), 'process-logs'), kill: tools.killTree, changed: () => send('procs:changed', processes.list()) });
  ollama.ensureServer().catch(() => {}); // the first chat waits for it anyway
  createWindow();
  mcp.sync();
});

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  for (const id of chat.activeIds()) chat.stop(id);
  processes.stopAll();
  e.preventDefault();
  Promise.race([Promise.all([mcp.shutdown(), ollama.unloadAll(), colibri.stop()]), new Promise((r) => setTimeout(r, 2500))]).finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
