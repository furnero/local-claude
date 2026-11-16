// The local model server. Starts `ollama serve` when it isn't running, and turns the model the
// user picked for a mode (Settings -> Local models) into a ready-to-use model with a real
// context window: Ollama's default window is far too small for tool use, so the app derives
// "lc-<model>-<N>k" from the base model with num_ctx set. Derived models share the base
// model's files, so they cost no disk space.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const store = require('./store');
const { modeOf, MODELS } = require('./models');
const hardware = require('./hardware');

// test hook: a fake Anthropic-style API instead of Ollama (see test/fake-api.js)
const BASE = process.env.ASTER_BASE_URL || 'http://127.0.0.1:11434';
const FAKE = !!process.env.ASTER_BASE_URL;

const DEFAULT_MODES = {
  quick: { base: 'qwen3.5:4b', ctx: 49152 },
  smart: { base: 'qwen3.5:9b', ctx: 49152 },
  coder: { base: 'huihui_ai/qwen3.5-abliterated:9b-OmniCoder', ctx: 49152 },
};
const MIN_CTX = 2048;
const MB = 1048576;

/** keep_alive value for Ollama from the setting. */
function keepAliveValue() {
  const k = String(store.getSettings().keepAlive ?? '5m');
  return k === '0' ? 0 : k === '-1' ? -1 : k;
}
const ramLimitMb = () => Math.max(0, Math.round((Number(store.getSettings().ramLimitGb) || 0) * 1024));

/**
 * Rough guess of how much system RAM a model takes: what does not fit on the graphics card.
 * Weights plus working memory for the context. Only used for hints (and by the test API);
 * the real number comes from Ollama once the model is loaded.
 */
function estimateRamMb(sizeMb, ctx, vramMb) {
  return Math.max(0, Math.round(sizeMb * 1.08 + (ctx / 1024) * 28 - (vramMb || 0) * 0.95));
}

function limitError(base, ctx, ramMb, limitMb, guessed) {
  const gb = (mb) => (mb / 1024).toFixed(1);
  const e = new Error(
    `${base} with a ${Math.round(ctx / 1024)}k context ${guessed ? 'would need about' : 'needs'} ${gb(ramMb)} GB of system RAM (the part that does not fit on the graphics card), and your RAM limit is ${gb(limitMb)} GB. ${guessed ? 'It was not loaded.' : 'It was unloaded again.'} Pick a smaller context size or model, or raise the limit, in Settings → Local models.`,
  );
  e.kind = 'settings';
  return e;
}

/** The models Ollama has in memory right now: [{ name, ramMb, vramMb }]. */
async function loaded() {
  if (FAKE) return [];
  try {
    return ((await api('/api/ps')).models || []).map((m) => ({ name: m.name, ramMb: Math.max(0, Math.round(((m.size || 0) - (m.size_vram || 0)) / MB)), vramMb: Math.round((m.size_vram || 0) / MB) }));
  } catch {
    return [];
  }
}

/** Loads the model (if it is not loaded yet) and enforces the RAM limit on what Ollama reports. */
async function loadWithinLimit(rt, onStatus) {
  const limit = ramLimitMb();
  const find = async () => (await loaded()).find((m) => m.name === rt.model || m.name === `${rt.model}:latest`);
  let m = await find();
  if (!m) {
    onStatus(`Loading ${rt.base}…`);
    // Loaded for the turn that follows: never with "unload at once", or it would be gone again
    // before it can be measured and used. The user's setting is applied when the turn ends (release).
    await api('/api/generate', { model: rt.model, keep_alive: keepAliveValue() === 0 ? '5m' : keepAliveValue() }, 15 * 60 * 1000);
    m = await find();
  }
  if (m && limit && m.ramMb > limit) {
    try {
      await api('/api/generate', { model: rt.model, keep_alive: 0 }, 60000);
    } catch {}
    throw limitError(rt.base, rt.ctx, m.ramMb, limit, false);
  }
}

/** After a turn: tell Ollama how long this model may stay in memory (0 unloads it now). */
async function release(model) {
  if (FAKE || !model) return;
  try {
    await api('/api/generate', { model, keep_alive: keepAliveValue() }, 60000);
  } catch {}
}

/** Unloads every model this app loaded, whatever the keep-in-memory setting (another engine needs the memory). */
async function unloadLoaded() {
  if (FAKE) return;
  for (const m of await loaded()) {
    if (!isDerived(m.name)) continue;
    try {
      await api('/api/generate', { model: m.name, keep_alive: 0 }, 15000);
    } catch {}
  }
}

/** When the app closes: models kept "until the app closes" are unloaded. */
async function unloadAll() {
  if (FAKE || keepAliveValue() !== -1) return;
  for (const m of await loaded()) {
    if (!isDerived(m.name)) continue;
    try {
      await api('/api/generate', { model: m.name, keep_alive: 0 }, 5000);
    } catch {}
  }
}

const CTX_CHOICES = [8192, 16384, 32768, 49152, 65536, 98304, 131072, 262144];

const showCache = new Map(); // model name -> /api/show answer
const FAKE_MODELS = [
  { name: 'qwen3.5:4b', sizeMb: 3400, params: '4B', caps: ['completion', 'tools', 'thinking', 'vision'], maxCtx: 262144 },
  { name: 'qwen3.5:9b', sizeMb: 6600, params: '9B', caps: ['completion', 'tools', 'thinking', 'vision'], maxCtx: 262144 },
  { name: 'huihui_ai/qwen3.5-abliterated:9b-OmniCoder', sizeMb: 6100, params: '9B', caps: ['completion', 'tools', 'thinking', 'vision'], maxCtx: 262144 },
  { name: 'plainchat:7b', sizeMb: 4100, params: '7B', caps: ['completion'], maxCtx: 8192 },
];

function exe() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');
  return fs.existsSync(local) ? local : 'ollama';
}

async function api(route, body, ms = 8000) {
  const r = await fetch(`${BASE}${route}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms) });
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      msg = (await r.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return r.json();
}

async function up() {
  try {
    await api('/api/version', null, 2000);
    return true;
  } catch {
    return false;
  }
}

let starting = null;
async function ensureServer() {
  if (FAKE || (await up())) return;
  if (!starting) {
    starting = (async () => {
      try {
        const child = spawn(exe(), ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', () => {});
        child.unref();
      } catch {}
      for (let i = 0; i < 60; i++) {
        if (await up()) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error("Ollama isn't running and couldn't be started. Install it from ollama.com (once, with internet), then try again.");
    })().finally(() => (starting = null));
  }
  return starting;
}

async function tags() {
  return (await api('/api/tags')).models || [];
}

async function show(name) {
  if (showCache.has(name)) return showCache.get(name);
  const j = await api('/api/show', { model: name });
  showCache.set(name, j);
  return j;
}

function modeConfig(mode) {
  const m = modeOf(mode);
  const saved = (store.getSettings().modes || {})[m] || {};
  const cfg = { ...DEFAULT_MODES[m], ...saved };
  cfg.ctx = Math.round(Math.min(Math.max(Number(cfg.ctx) || DEFAULT_MODES[m].ctx, MIN_CTX), 1048576));
  return cfg;
}

// a context size typed by hand keeps its exact number in the name ("-20000t")
const derivedName = (base, ctx) => `lc-${base.toLowerCase().replace(/[^a-z0-9.]+/g, '-')}-${ctx % 1024 === 0 ? `${ctx / 1024}k` : `${ctx}t`}`;
const isDerived = (name) => /^lc-.*-\d+[kt](:latest)?$/.test(name) || /^local-agent/.test(name);
// tags differ in letter case between publishers ("4B", "9b"); Ollama itself does not care
const has = (names, n) => names.some((x) => x.toLowerCase() === n.toLowerCase() || x.toLowerCase() === `${n.toLowerCase()}:latest`);

const building = new Map();
/**
 * Makes the mode's model ready. Returns { model, base, ctx, caps } where model is the name to
 * send to the API and caps is the list of capabilities ('tools', 'thinking', 'vision', ...).
 */
async function prepare(mode, onStatus = () => {}) {
  const cfg = modeConfig(mode);
  const model = derivedName(cfg.base, cfg.ctx);
  if (FAKE) {
    const fm = FAKE_MODELS.find((m) => m.name === cfg.base);
    const need = estimateRamMb(fm?.sizeMb || 4000, cfg.ctx, 8192);
    if (ramLimitMb() && need > ramLimitMb()) throw limitError(cfg.base, cfg.ctx, need, ramLimitMb(), false);
    return { model, base: cfg.base, ctx: cfg.ctx, caps: [...(fm?.caps || ['completion', 'tools', 'thinking'])] };
  }
  await ensureServer();
  const list = await tags();
  const names = list.map((m) => m.name);
  // a model whose file alone is far too big for the graphics card plus the RAM limit is never loaded
  if (ramLimitMb()) {
    const file = list.find((m) => m.name === cfg.base || m.name === `${cfg.base}:latest`);
    const g = await gpu();
    const least = file ? Math.round((file.size || 0) / MB) - (g?.vramMb || 0) : 0;
    if (least > ramLimitMb()) throw limitError(cfg.base, cfg.ctx, least, ramLimitMb(), true);
  }
  if (!has(names, cfg.base)) {
    throw new Error(`The model "${cfg.base}" isn't installed in Ollama. Pick another one in Settings → Local models, or download it there (needs internet once).`);
  }
  if (!has(names, model)) {
    if (!building.has(model)) {
      onStatus(`Preparing ${cfg.base} with a ${Math.round(cfg.ctx / 1024)}k context window…`);
      building.set(
        model,
        api('/api/create', { model, from: cfg.base, parameters: { num_ctx: cfg.ctx }, stream: false }, 120000).finally(() => building.delete(model)),
      );
    }
    try {
      await building.get(model);
    } catch (e) {
      throw new Error(`Couldn't prepare ${cfg.base} (${e.message}).`);
    }
  }
  let caps = ['completion', 'tools'];
  try {
    const s = await show(model);
    if (Array.isArray(s.capabilities)) caps = s.capabilities;
  } catch {}
  const rt = { model, base: cfg.base, ctx: cfg.ctx, caps };
  await loadWithinLimit(rt, onStatus);
  return rt;
}

// ---------------------------------------------------------------- for the settings page

/** The graphics card the models use (any vendor, see hardware.js), or null. */
async function gpu() {
  const g = (await hardware.probe()).gpu;
  return g && g.vramMb >= hardware.MIN_CARD_MB ? g : null;
}

/** Is Ollama on this PC at all? (Starting a server that is not installed would wait for nothing.) */
function exeFound() {
  if (FAKE) return Promise.resolve(true);
  if (fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'))) return Promise.resolve(true);
  return new Promise((resolve) => execFile(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { windowsHide: true, timeout: 4000 }, (err) => resolve(!err)));
}

/** For the setup dialog: { found, ok, names } = installed, answering, and the models it has. */
async function installState() {
  if (FAKE) return { found: true, ok: true, names: FAKE_MODELS.map((m) => m.name) };
  const found = await exeFound();
  let ok = await up();
  if (!ok && found) {
    try {
      await ensureServer();
      ok = true;
    } catch {}
  }
  let names = [];
  if (ok) {
    try {
      names = (await tags()).map((m) => m.name).filter((n) => !isDerived(n));
    } catch {}
  }
  return { found, ok, names };
}

/** What a model can do ('tools', 'thinking', 'vision', ...), or null when Ollama cannot say. */
async function capsOf(name) {
  if (FAKE) return FAKE_MODELS.find((m) => m.name.toLowerCase() === String(name).toLowerCase())?.caps || null;
  try {
    const s = await show(name);
    return Array.isArray(s.capabilities) ? s.capabilities : null;
  } catch {
    return null;
  }
}

/** Where a loaded model really sits: { ramMb, vramMb }, or null when it is not loaded. */
async function placement(model) {
  let list;
  if (FAKE) {
    // the test API can report a placement (see test/fake-api.js); by default it reports none
    try {
      list = ((await api('/api/ps', null, 3000)).models || []).map((m) => ({ name: m.name, ramMb: Math.max(0, Math.round(((m.size || 0) - (m.size_vram || 0)) / MB)), vramMb: Math.round((m.size_vram || 0) / MB) }));
    } catch {
      list = [];
    }
    return list[0] || null;
  }
  list = await loaded();
  return list.find((m) => m.name === model || m.name === `${model}:latest`) || null;
}

/** Server state, the installed base models (with size and capabilities), GPU and mode settings. */
async function overview() {
  const modes = Object.fromEntries(MODELS.filter((m) => !m.engine).map((m) => [m.id, modeConfig(m.id)]));
  const s = store.getSettings();
  const mem = { ram: { totalMb: Math.round(os.totalmem() / MB), freeMb: Math.round(os.freemem() / MB) }, ramLimitGb: Number(s.ramLimitGb) || 0, keepAlive: String(s.keepAlive ?? '5m'), minCtx: MIN_CTX };
  if (FAKE) {
    return { ...mem, ok: true, fake: true, gpu: { name: 'Test GPU', vramMb: 8192 }, hw: await hardware.probe(), modes, ctxChoices: CTX_CHOICES, models: FAKE_MODELS, loaded: [] };
  }
  const ok = await up();
  const models = [];
  if (ok) {
    let list = [];
    try {
      list = await tags();
    } catch {}
    for (const m of list) {
      if (isDerived(m.name)) continue;
      let caps = [];
      let maxCtx = 0;
      try {
        const s = await show(m.name);
        caps = s.capabilities || [];
        for (const [k, v] of Object.entries(s.model_info || {})) if (/\.context_length$/.test(k)) maxCtx = Number(v) || 0;
      } catch {}
      models.push({ name: m.name, sizeMb: Math.round((m.size || 0) / 1048576), params: m.details?.parameter_size || '', quant: m.details?.quantization_level || '', caps, maxCtx });
    }
    models.sort((a, b) => a.sizeMb - b.sizeMb);
  }
  return { ...mem, ok, gpu: await gpu(), hw: await hardware.probe(), modes, ctxChoices: CTX_CHOICES, models, loaded: ok ? await loaded() : [] };
}

let pulling = null;
/** Downloads a model (needs internet). onProgress({ status, percent }) while it runs. */
async function pull(name, onProgress) {
  if (pulling) throw new Error('Another download is still running.');
  await ensureServer();
  const ctrl = new AbortController();
  pulling = ctrl;
  try {
    const r = await fetch(`${BASE}/api/pull`, { method: 'POST', body: JSON.stringify({ model: name, stream: true }), signal: ctrl.signal });
    if (!r.ok || !r.body) throw new Error(`Ollama answered ${r.status}`);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        onProgress({ status: j.status || '', percent: j.total ? Math.round((j.completed || 0) / j.total * 100) : null });
      }
    }
    showCache.clear();
    // the test API has no model store: remember the download so it counts as installed
    if (FAKE && !has(FAKE_MODELS.map((m) => m.name), name)) FAKE_MODELS.push({ name, sizeMb: 4000, params: '', caps: /notools/i.test(name) ? ['completion'] : ['completion', 'tools', 'thinking'], maxCtx: 262144 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: ctrl.signal.aborted ? 'Download cancelled.' : /fetch failed|ENOTFOUND|ECONN|EAI_AGAIN/i.test(String(e.cause?.code || e.message)) ? "Couldn't reach the Ollama library. Downloading a model needs internet." : String(e.message || e) };
  } finally {
    pulling = null;
  }
}

function cancelPull() {
  pulling?.abort();
}

function settingsChanged() {
  showCache.clear();
}

module.exports = { unloadLoaded, release, unloadAll, estimateRamMb, BASE, FAKE, ensureServer, prepare, modeConfig, derivedName, overview, pull, cancelPull, settingsChanged, installState, capsOf, placement, gpu, has, DEFAULT_MODES };
