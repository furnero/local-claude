// A second engine next to Ollama: colibri (github.com/JustVugg/colibri). It runs big
// mixture-of-experts models by keeping the shared part in RAM and reading the expert blocks from
// disk as the model asks for them, so a 30B coding model works on a PC whose graphics card could
// never hold it. The app starts `coli serve` when a chat in a colibri mode needs it, talks to its
// Anthropic-style /v1/messages (same as Ollama's), and stops it when the app closes or an Ollama
// mode needs the memory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const store = require('./store');

const FAKE_BASE = process.env.ASTER_BASE_URL || null; // test hook, see ollama.js
const DEFAULTS = {
  dir: 'D:\\colibri', // the unpacked colibri release (holds coli.cmd)
  modelDir: 'D:\\colibri-models\\qwen3-coder-30b-abliterated', // made by `coli import` from the GGUF in D:\colibri-models\gguf; the plain model is in ...\qwen3-coder-30b
  cap: 0, // expert blocks kept in RAM per layer (each layer slot is about 2.5 MB, so 32 = about 4 GB): more is faster. 0 = colibri sizes it from the free RAM at start
  ctx: 16384, // a full context costs about 1.4 GB of RAM per 16k tokens
  port: 8000,
  gpu: 'auto', // 'auto' = use the graphics card | 'none' = CPU only
};
const CAP_CHOICES = [0, 8, 16, 32, 48, 64, 96, 128];
const LABEL = 'Qwen3-Coder 30B (colibrì)';
/** What the mode calls its model. The folder decides, so a build with the refusals removed says so. */
function labelOf(c) {
  const name = path.basename(c.modelDir || '');
  if (/qwen3-coder-30b/i.test(name)) return /abliterat/i.test(name) ? 'Qwen3-Coder 30B abliterated (colibrì)' : LABEL;
  return (name || 'model') + ' (colibrì)';
}

let child = null;
let starting = null;

function config() {
  const c = { ...DEFAULTS, ...(store.getSettings().colibri || {}) };
  c.cap = Math.min(Math.max(parseInt(c.cap, 10) || 0, 0), 128);
  if (c.cap && c.cap < 4) c.cap = 4;
  c.ctx = Math.round(Math.min(Math.max(Number(c.ctx) || DEFAULTS.ctx, 2048), 262144));
  c.port = Math.min(Math.max(parseInt(c.port, 10) || DEFAULTS.port, 1024), 65535);
  c.gpu = c.gpu === 'none' ? 'none' : 'auto';
  return c;
}

const baseOf = (c) => `http://127.0.0.1:${c.port}`;
const launcher = (c) => path.join(c.dir, 'coli.cmd');
const installed = (c) => fs.existsSync(launcher(c));
// a model folder counts as there when its config and its tokenizer files exist (the tokenizer is the
// last thing a download writes, so a half-finished download does not count)
const modelReady = (c) => ['config.json', 'tokenizer.json', 'tokenizer_config.json'].every((f) => fs.existsSync(path.join(c.modelDir, f)));
const logFile = () => path.join(store.dir(), 'colibri.log');

// Without a key, any program on the PC (or a web page posting blindly to 127.0.0.1) could make the
// server generate. The app gives it a private key, kept in its data folder and never shown.
let keyCache = null;
function apiKey() {
  if (keyCache) return keyCache;
  const file = path.join(store.dir(), 'colibri.key');
  try {
    keyCache = fs.readFileSync(file, 'utf8').trim();
  } catch {}
  if (!keyCache || keyCache.length < 32) {
    keyCache = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, keyCache, { encoding: 'utf8', mode: 0o600 });
  }
  return keyCache;
}
// Settings that would open the server up or redirect it are never passed on from the user's environment.
const UNSET = ['CLUSTER_COORDINATOR', 'CLUSTER_WORKERS', 'COLI_ENGINE', 'COLI_IMAGE_ROOT', 'COLI_ALLOWED_HOSTS', 'COLI_ALLOW_INSECURE_BIND', 'COLI_MODEL_ID'];
function cleanEnv(c) {
  const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', COLI_API_KEY: apiKey() };
  for (const k of UNSET) delete env[k];
  // The graphics card: the Windows download has no CUDA part, its GPU path is Vulkan and only runs
  // when this is set (tested on a GTX 1070). A folder that does hold the CUDA library picks CUDA by itself.
  delete env.COLI_VULKAN;
  if (c && c.gpu !== 'none' && !fs.existsSync(path.join(c.dir, 'coli_cuda.dll'))) env.COLI_VULKAN = '1';
  return env;
}

/** The model id the running server reports, null when it is not up, 'foreign' when it does not take our key. */
async function serving(c) {
  try {
    const r = await fetch(`${baseOf(c)}/v1/models`, { headers: { 'x-api-key': apiKey() }, signal: AbortSignal.timeout(2500) });
    if (r.status === 401 || r.status === 403) return 'foreign';
    if (!r.ok) return null;
    const j = await r.json();
    return j.data?.[0]?.id || 'colibri';
  } catch {
    return null;
  }
}

function lastLogLines(n = 6) {
  try {
    return fs.readFileSync(logFile(), 'utf8').trim().split(/\r?\n/).slice(-n).join('\n');
  } catch {
    return '';
  }
}

function problem(message) {
  const e = new Error(message);
  e.kind = 'settings';
  return e;
}

async function start(c, onStatus) {
  if (!installed(c)) throw problem(`colibri isn't in ${c.dir} (coli.cmd is missing). Set its folder in Settings → Local models.`);
  if (!modelReady(c)) throw problem(`The model folder ${c.modelDir} is missing or incomplete. Set it in Settings → Local models.`);
  onStatus(`Starting colibrì with ${path.basename(c.modelDir)} (this takes a minute)…`);
  const out = fs.openSync(logFile(), 'w');
  const args = ['serve', '--model', c.modelDir, '--ctx', String(c.ctx), '--host', '127.0.0.1', '--port', String(c.port)];
  if (c.cap) args.push('--cap', String(c.cap));
  if (c.gpu === 'none') args.push('--gpu', 'none');
  // coli.cmd is a batch file: it has to go through cmd. stdin is closed so its "press a key" hold never waits.
  child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${launcher(c)}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}"`], {
    cwd: c.dir,
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: ['ignore', out, out],
    env: cleanEnv(c),
  });
  fs.closeSync(out);
  let exited = null;
  child.on('exit', (code) => {
    exited = code ?? -1;
    child = null;
  });
  child.on('error', () => {
    exited = -1;
    child = null;
  });
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const id = await serving(c);
    if (id && id !== 'foreign') return id;
    if (exited !== null) throw problem(`colibrì stopped while starting (exit ${exited}).\n${lastLogLines()}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw problem(`colibrì did not answer within 15 minutes.\n${lastLogLines()}`);
}

/**
 * Makes the colibri server ready. Returns the same shape as ollama.prepare, plus baseURL.
 * `freeOllama` is called before a start, so both engines never hold a model at the same time.
 */
async function prepare(onStatus = () => {}, freeOllama = async () => {}) {
  const c = config();
  if (FAKE_BASE) return { engine: 'colibri', model: 'qwen3-coder-30b', base: labelOf(c), ctx: c.ctx, caps: ['completion', 'tools'], baseURL: FAKE_BASE };
  let id = await serving(c);
  if (id === 'foreign') {
    // something else answers on that port, or a server from before the key existed: replace it
    await stop(true);
    id = await serving(c);
    if (id === 'foreign') throw problem(`Another program is answering on 127.0.0.1:${c.port} and does not accept this app's key. Stop it, or change the port in Settings → Local models.`);
  }
  if (!id) {
    if (!starting) {
      starting = (async () => {
        await freeOllama();
        return start(c, onStatus);
      })().finally(() => (starting = null));
    }
    id = await starting;
  }
  return { engine: 'colibri', model: id, base: labelOf(c), ctx: c.ctx, caps: ['completion', 'tools'], baseURL: baseOf(c), apiKey: apiKey() };
}

function killTree(p) {
  if (!p || p.exitCode !== null) return;
  try {
    spawn('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
  } catch {}
}

/**
 * Stops this app's server. A server on the port that does not take this app's key belongs to
 * someone else (a second copy of the app, a hand-started one) and is left alone, unless
 * `force` says this app needs the port now.
 */
async function stop(force = false) {
  if (FAKE_BASE) return;
  const c = config();
  const id = await serving(c);
  const running = !!id && (id !== 'foreign' || force);
  if (running && installed(c)) {
    await new Promise((resolve) => {
      const p = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${launcher(c)}" stop --port ${c.port}"`], { cwd: c.dir, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore', env: cleanEnv(c) });
      const t = setTimeout(resolve, 15000);
      p.on('exit', () => (clearTimeout(t), resolve()));
      p.on('error', () => (clearTimeout(t), resolve()));
    });
  }
  if (child) killTree(child);
  child = null;
}

async function status() {
  const c = config();
  if (FAKE_BASE) return { ...c, installed: true, modelReady: true, running: false, label: labelOf(c), capChoices: CAP_CHOICES, fake: true };
  return { ...c, installed: installed(c), modelReady: modelReady(c), running: ['string'].includes(typeof (await serving(c))), label: labelOf(c), capChoices: CAP_CHOICES, log: logFile() };
}

/** Is the engine and a model for it on this PC? The Coder 30B mode is only offered when it is. */
function available() {
  if (FAKE_BASE) return true;
  const c = config();
  return installed(c) && modelReady(c);
}

module.exports = { prepare, stop, status, config, available, labelOf, LABEL, DEFAULTS };
