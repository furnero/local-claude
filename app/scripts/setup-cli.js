#!/usr/bin/env node
// The installer's helper (install\install.ps1 calls it; it also works by hand). It uses the same
// hardware rules as the app (src/main/hardware.js), so the installer and the app's own
// "Set up for this PC" dialog always agree.
//
//   node scripts/setup-cli.js plan [--out plan.json]
//       what this PC has, the model the app would pick per mode, every other choice
//       (the app's list plus whatever is installed in Ollama already) and whether it is installed
//   node scripts/setup-cli.js apply --picks picks.json
//       picks.json: { "quick": { "base": "qwen3.5:4b", "ctx": 49152 }, "smart": ..., "coder": ... }
//       downloads the missing models into Ollama's own model folder and saves the modes
//   node scripts/setup-cli.js coder30 --engine <folder> --models <folder>
//       optional Coder 30B mode: fetches the colibri engine and the abliterated Qwen3-Coder 30B
//       (18.6 GB) into those folders, checks both against known checksums, imports the model
//       and saves the folders in the app's settings
//
// Output is line based so a script can follow it: "STEP text", "PROGRESS <0-100> text",
// "DONE text", "ERROR text". The exit code is 0 only after DONE.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const hardware = require('../src/main/hardware');

const OLLAMA = process.env.LOCALCLAUDE_OLLAMA || 'http://127.0.0.1:11434'; // test hook: another address
const ROOT = path.resolve(__dirname, '..', '..'); // the LocalClaude folder
const DATA = process.env.LOCALCLAUDE_DATA || path.join(ROOT, 'data'); // where the app keeps settings.json
const MODES = { quick: 'Quick', smart: 'Smart', coder: 'Coder' };
const MB = 1048576;

// Pinned downloads for the Coder 30B mode. The checksums are the published ones, checked by hand
// on 2026-11-16; a file that does not match is deleted and nothing of it is run.
const COLIBRI = {
  url: 'https://github.com/JustVugg/colibri/releases/download/v2.1.0/colibri-v2.1.0-windows-x86_64.zip',
  sha256: '195ee0be129d563789f1ade2383e023bde5519230d6fb508516e63767ee85465',
  sizeMb: 17,
};
const CODER30 = {
  url: 'https://huggingface.co/mradermacher/Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated-GGUF/resolve/main/Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated.Q4_K_M.gguf',
  file: 'Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated.Q4_K_M.gguf',
  sha256: '78e46edeaa74d5557bcbb8a5da2d134fb448c4a5dcbee5ce12022484bde0705d',
  sizeMb: 17697,
  folder: 'qwen3-coder-30b-abliterated',
};

const say = (kind, text) => process.stdout.write(`${kind} ${String(text).replace(/\r?\n/g, ' ')}\n`);
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase() || a.toLowerCase() === `${b.toLowerCase()}:latest`;
const isDerived = (name) => /^lc-.*-\d+[kt](:latest)?$/.test(name) || /^local-agent/.test(name);

// ---------------------------------------------------------------- Ollama

async function api(route, body, ms = 8000) {
  const r = await fetch(`${OLLAMA}${route}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`Ollama answered ${r.status}`);
  return r.json();
}
const up = () => api('/api/version', null, 2000).then(() => true, () => false);

function ollamaExe() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');
  if (fs.existsSync(local)) return local;
  const where = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { encoding: 'utf8', windowsHide: true });
  return where.status === 0 ? where.stdout.split(/\r?\n/)[0].trim() : null;
}

/** Makes sure the Ollama server answers; starts it when it is installed but not running. */
async function ensureOllama() {
  if (await up()) return true;
  const exe = ollamaExe();
  if (!exe) return false;
  try {
    const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
  for (let i = 0; i < 80; i++) {
    if (await up()) return true;
    await sleep(500);
  }
  return false;
}

async function installedModels() {
  const list = (await api('/api/tags')).models || [];
  return list.filter((m) => !isDerived(m.name)).map((m) => ({ name: m.name, sizeMb: Math.round((m.size || 0) / MB) }));
}

async function pull(name, onProgress) {
  const r = await fetch(`${OLLAMA}/api/pull`, { method: 'POST', body: JSON.stringify({ model: name, stream: true }) });
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
      onProgress(j.status || '', j.total ? Math.floor(((j.completed || 0) / j.total) * 100) : null);
    }
  }
}

// ---------------------------------------------------------------- settings

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8').replace(/^﻿/, ''));
  } catch {
    return {};
  }
}
function writeSettings(patch) {
  fs.mkdirSync(DATA, { recursive: true });
  const next = { ...readSettings(), ...patch };
  const file = path.join(DATA, 'settings.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(`${file}.tmp`, file);
  return next;
}

// ---------------------------------------------------------------- plan

async function plan() {
  const hw = await hardware.probe();
  const rec = hardware.recommend(hw);
  const ok = await ensureOllama();
  const have = ok ? await installedModels().catch(() => []) : [];
  const isIn = (base) => have.some((m) => sameName(m.name, base));
  const saved = readSettings().modes || {};
  const modes = {};
  for (const id of Object.keys(MODES)) {
    const pick = rec.modes[id];
    const ladder = hardware.LADDERS[id].map((m) => ({ base: m.base, sizeMb: m.sizeMb, installed: isIn(m.base), ...hardware.fitModel(m, hw) }));
    // whatever else is in Ollama already can be picked too
    const others = have.filter((m) => !hardware.LADDERS[id].some((l) => sameName(m.name, l.base))).map((m) => ({ base: m.name, sizeMb: m.sizeMb, installed: true, other: true, ...hardware.fitModel(m, hw) }));
    modes[id] = {
      name: MODES[id],
      pick: { base: pick.base, ctx: pick.ctx },
      current: saved[id]?.base || null,
      choices: [...ladder, ...others],
    };
  }
  const colibriDir = readSettings().colibri || {};
  return {
    hw: { gpu: hw.gpu, ramMb: hw.ramMb, cpu: hw.cpu, disk: hw.disk },
    card: rec.card,
    notes: rec.notes,
    modes,
    ollama: { found: !!ollamaExe(), ok },
    coder30: { sizeMb: CODER30.sizeMb + COLIBRI.sizeMb, engine: colibriDir.dir || null, modelDir: colibriDir.modelDir || null },
  };
}

// ---------------------------------------------------------------- apply

async function apply(picksFile) {
  const picks = JSON.parse(fs.readFileSync(picksFile, 'utf8').replace(/^﻿/, ''));
  say('STEP', 'Starting Ollama');
  if (!(await ensureOllama())) throw new Error('Ollama is not installed or did not start.');
  let have = await installedModels();
  const wanted = [...new Set(Object.values(picks).map((p) => p.base))];
  const missing = wanted.filter((b) => !have.some((m) => sameName(m.name, b)));
  let n = 0;
  const failed = [];
  for (const name of missing) {
    n++;
    say('STEP', `Downloading ${name} (${n} of ${missing.length})`);
    let last = -1;
    try {
      await pull(name, (status, pct) => {
        if (pct != null && pct !== last) {
          last = pct;
          say('PROGRESS', `${pct} ${name}: ${status}`);
        }
      });
    } catch (e) {
      failed.push(`${name}: ${e.message}`);
      say('STEP', `Could not download ${name}: ${e.message}`);
    }
  }
  have = await installedModels();
  const modes = { ...(readSettings().modes || {}) };
  const saved = [];
  for (const [id, p] of Object.entries(picks)) {
    if (!MODES[id] || !have.some((m) => sameName(m.name, p.base))) continue; // a mode never points at a model that is not there
    modes[id] = { base: p.base, ctx: Math.round(Math.min(Math.max(Number(p.ctx) || 49152, 2048), 1048576)) };
    saved.push(MODES[id]);
  }
  const all = saved.length === Object.keys(picks).length;
  writeSettings({ modes, setup: { ...(readSettings().setup || {}), done: all, at: Date.now() } });
  if (failed.length) throw new Error(`${failed.join('; ')}. Saved: ${saved.join(', ') || 'nothing'}. The app offers the setup again on its first start.`);
  say('DONE', `Models set: ${Object.entries(modes).filter(([id]) => MODES[id]).map(([id, m]) => `${MODES[id]} = ${m.base}`).join(', ')}`);
}

// ---------------------------------------------------------------- Coder 30B (optional)

async function sha256(file, label) {
  const total = fs.statSync(file).size;
  const h = crypto.createHash('sha256');
  let done = 0;
  let last = -1;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 8 * MB })) {
    h.update(chunk);
    done += chunk.length;
    const pct = Math.floor((done / total) * 100);
    if (pct !== last && pct % 5 === 0) {
      last = pct;
      say('PROGRESS', `${pct} checking ${label}`);
    }
  }
  return h.digest('hex');
}

/** Downloads to `file` (continues a half-finished ".part"), then checks the checksum. */
async function download(url, file, want, label) {
  if (fs.existsSync(file)) {
    if ((await sha256(file, label)) === want) return;
    fs.rmSync(file, { force: true });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const r = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {} });
  if (r.status === 416) have = fs.statSync(part).size; // already complete
  else {
    if (!r.ok || !r.body) throw new Error(`${label}: the server answered ${r.status}`);
    if (r.status !== 206) have = 0; // no resume: start again
    const total = have + Number(r.headers.get('content-length') || 0);
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    let done = have;
    let last = -1;
    for await (const chunk of r.body) {
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
      done += chunk.length;
      const pct = total ? Math.floor((done / total) * 100) : 0;
      if (pct !== last) {
        last = pct;
        say('PROGRESS', `${pct} ${label}: ${(done / 1073741824).toFixed(1)} of ${(total / 1073741824).toFixed(1)} GB`);
      }
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  }
  const got = await sha256(part, label);
  if (got !== want) {
    fs.rmSync(part, { force: true });
    throw new Error(`${label}: the download does not match its checksum and was deleted. Nothing of it was run.`);
  }
  fs.renameSync(part, file);
}

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let text = '';
    p.stdout.on('data', (d) => (text += d));
    p.stderr.on('data', (d) => (text += d));
    p.on('error', (e) => resolve({ code: -1, text: String(e.message) }));
    p.on('exit', (code) => resolve({ code, text }));
  });
}

async function coder30(engine, models) {
  if (!engine || !models) throw new Error('coder30 needs --engine <folder> and --models <folder>');
  engine = path.resolve(engine);
  models = path.resolve(models);
  const py = (await run('py', ['-3', '--version'])).code === 0 || (await run('python', ['--version'])).code === 0;
  if (!py) throw new Error('Python 3 is missing. It runs the colibri launcher: install it, then run this again.');

  if (!fs.existsSync(path.join(engine, 'coli.cmd'))) {
    say('STEP', 'Downloading the colibri engine');
    const zip = path.join(engine, 'colibri.zip');
    await download(COLIBRI.url, zip, COLIBRI.sha256, 'colibri engine');
    say('STEP', 'Unpacking the colibri engine');
    const un = await run('tar', ['-xf', zip, '-C', engine]); // Windows 10 and later ship tar, which reads zip files
    if (un.code !== 0 || !fs.existsSync(path.join(engine, 'coli.cmd'))) throw new Error(`Could not unpack the colibri engine. ${un.text.trim().slice(0, 300)}`);
    fs.rmSync(zip, { force: true });
  }

  const gguf = path.join(models, 'gguf', CODER30.file);
  say('STEP', 'Downloading Qwen3-Coder 30B (18.6 GB, this takes a while and can be continued later)');
  await download(CODER30.url, gguf, CODER30.sha256, 'Qwen3-Coder 30B');

  const out = path.join(models, CODER30.folder);
  if (!['config.json', 'tokenizer.json', 'tokenizer_config.json', 'gguf.json'].every((f) => fs.existsSync(path.join(out, f)))) {
    say('STEP', 'Preparing the model for colibri');
    const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
    const imp = await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${path.join(engine, 'coli.cmd')}" import ${q(gguf)} --out ${q(out)}"`], { cwd: engine, windowsVerbatimArguments: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    if (imp.code !== 0 || !fs.existsSync(path.join(out, 'gguf.json'))) throw new Error(`colibri could not import the model. ${imp.text.trim().slice(-400)}`);
  }
  writeSettings({ colibri: { ...(readSettings().colibri || {}), dir: engine, modelDir: out } });
  say('DONE', `Coder 30B is set up: engine in ${engine}, model in ${out}`);
}

// ---------------------------------------------------------------- main

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'plan') {
    const p = await plan();
    const out = arg('--out');
    if (out) fs.writeFileSync(out, JSON.stringify(p), 'utf8');
    else process.stdout.write(`${JSON.stringify(p, null, 1)}\n`);
    return;
  }
  if (cmd === 'apply') return apply(arg('--picks'));
  if (cmd === 'coder30') return coder30(arg('--engine'), arg('--models'));
  process.stdout.write('usage: setup-cli.js plan [--out file] | apply --picks file | coder30 --engine <folder> --models <folder>\n');
  process.exitCode = 2;
})().catch((e) => {
  say('ERROR', e.message || String(e));
  process.exitCode = 1;
});
