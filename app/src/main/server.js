// The "Server" mode: a model that runs on another machine of the user's (a home server, a VM)
// instead of on this PC. The other machine runs a normal Ollama. The app reaches it either
// directly (an address on the home network) or through an SSH tunnel that it opens itself when a
// chat needs it and closes when the app quits. The tools still act on this PC; only the model's
// thinking happens over there.
//
// Nothing here is set by default: the mode stays out of the mode menu until an address or an SSH
// target and a model are entered in Settings -> Local models.
const { spawn } = require('node:child_process');
const net = require('node:net');
const store = require('./store');
const ollama = require('./ollama');

const FAKE_BASE = process.env.ASTER_BASE_URL || null; // test hook, see ollama.js
const DEFAULTS = {
  url: '', // direct address of the other machine's Ollama, e.g. http://192.168.1.20:11434 (leave empty when SSH is used)
  ssh: '', // SSH target for a tunnel: user@host or a Host name from ~/.ssh/config
  key: '', // optional private key file for that SSH connection
  port: 11435, // local end of the tunnel (11434 is this PC's own Ollama)
  remotePort: 11434, // Ollama's port on the other machine
  base: '', // the model over there, e.g. qwen3-coder:30b
  ctx: 32768,
};
const CTX_CHOICES = [8192, 16384, 32768, 49152, 65536, 98304];

let tunnel = null; // the ssh child process
let tunnelErr = '';
let opening = null;

function config() {
  const c = { ...DEFAULTS, ...(store.getSettings().server || {}) };
  c.url = String(c.url || '').trim().replace(/\/+$/, '');
  c.ssh = String(c.ssh || '').trim();
  c.key = String(c.key || '').trim();
  c.base = String(c.base || '').trim();
  c.port = Math.min(Math.max(parseInt(c.port, 10) || DEFAULTS.port, 1024), 65535);
  c.remotePort = Math.min(Math.max(parseInt(c.remotePort, 10) || DEFAULTS.remotePort, 1), 65535);
  c.ctx = Math.round(Math.min(Math.max(Number(c.ctx) || DEFAULTS.ctx, 2048), 1048576));
  return c;
}

/** Is the mode set up at all? (Whether the machine answers is a different question, see status().) */
const configured = (c = config()) => !!((c.url || c.ssh) && c.base);
const baseUrl = (c) => (c.ssh ? `http://127.0.0.1:${c.port}` : c.url);
const label = (c = config()) => (c.base ? `${c.base} (server)` : 'not set up');

function problem(message) {
  const e = new Error(message);
  e.kind = 'settings';
  return e;
}

async function api(c, route, body, ms = 8000) {
  const r = await fetch(`${baseUrl(c)}${route}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms) });
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      msg = (await r.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return r.json();
}
const up = (c) => api(c, '/api/version', null, 2500).then((j) => !!j.version, () => false);

/** Is something listening on the local tunnel port? */
function portTaken(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(800, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

/**
 * Opens the SSH tunnel when the mode uses one. The key must work without a password prompt and
 * the server must already be a known host: the app never answers ssh's questions.
 */
async function ensureTunnel(c, onStatus) {
  if (!c.ssh || FAKE_BASE) return;
  if (await up(c)) return; // a tunnel is there already (this app's, or one opened by hand)
  if (/^-|\s/.test(c.ssh)) throw problem('The SSH target for the Server mode must be user@host or a host name from your SSH config, without spaces or options.');
  if (await portTaken(c.port)) throw problem(`Port ${c.port} on this PC is in use by something that is not the server's Ollama. Pick another local port for the Server mode in Settings → Local models.`);
  if (!opening) {
    opening = (async () => {
      onStatus(`Connecting to ${c.ssh}…`);
      tunnelErr = '';
      const args = ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ConnectTimeout=10', '-N', '-L', `127.0.0.1:${c.port}:127.0.0.1:${c.remotePort}`];
      if (c.key) args.push('-i', c.key);
      args.push('--', c.ssh);
      const child = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      tunnel = child;
      let exited = false;
      child.stderr.on('data', (d) => (tunnelErr = (tunnelErr + d).slice(-600)));
      child.on('error', (e) => {
        tunnelErr = `ssh could not be started: ${e.message}`;
        exited = true;
      });
      child.on('exit', () => {
        exited = true;
        if (tunnel === child) tunnel = null;
      });
      for (let i = 0; i < 40; i++) {
        if (await up(c)) return;
        if (exited) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      stop();
      const why = tunnelErr.trim().split(/\r?\n/).pop() || 'no answer';
      throw problem(`Could not reach the server through SSH (${why}). Check that "ssh ${c.ssh}" works in a terminal without asking anything, and that Ollama runs on the server.`);
    })().finally(() => (opening = null));
  }
  return opening;
}

/** Makes the server's model ready. Same shape as ollama.prepare, plus where to send the request. */
async function prepare(onStatus = () => {}) {
  const c = config();
  if (!configured(c)) throw problem('The Server mode is not set up yet. Enter the server and its model in Settings → Local models.');
  const model = ollama.derivedName(c.base, c.ctx);
  // The server reads slowly and re-reads everything after a change in the instructions (measured:
  // 1.8 s for a follow-up, 200 s after one changed line). So the instructions are short and stay
  // the same for a whole chat, like in the colibri mode.
  const shape = { engine: 'server', base: label(c), ctx: c.ctx, lean: true, frozen: true, where: 'on a server of the user through Ollama (your tools still act on the user\'s Windows PC)', startNote: 'The model runs on your server: the first answer of a chat can take a few minutes while it reads the instructions, later ones start quickly.' };
  if (FAKE_BASE) return { ...shape, model, caps: ['completion', 'tools'], baseURL: FAKE_BASE };
  await ensureTunnel(c, onStatus);
  let names;
  try {
    names = ((await api(c, '/api/tags')).models || []).map((m) => m.name);
  } catch (e) {
    throw problem(`The server's Ollama at ${baseUrl(c)} does not answer (${e.message}).`);
  }
  if (!ollama.has(names, c.base)) throw problem(`The model "${c.base}" is not installed on the server. Run "ollama pull ${c.base}" there, or pick another model in Settings → Local models.`);
  if (!ollama.has(names, model)) {
    onStatus(`Preparing ${c.base} on the server with a ${Math.round(c.ctx / 1024)}k context window…`);
    try {
      await api(c, '/api/create', { model, from: c.base, parameters: { num_ctx: c.ctx }, stream: false }, 120000);
    } catch (e) {
      throw problem(`Couldn't prepare ${c.base} on the server (${e.message}).`);
    }
  }
  let caps = ['completion', 'tools'];
  try {
    const s = await api(c, '/api/show', { model });
    if (Array.isArray(s.capabilities)) caps = s.capabilities;
  } catch {}
  return { ...shape, model, caps, baseURL: baseUrl(c) };
}

/** For the settings page: the configuration, whether the server answers, and its models. */
async function status(connect = false) {
  const c = config();
  const out = { ...c, configured: configured(c), label: label(c), ctxChoices: CTX_CHOICES, tunnel: !!tunnel, reachable: false, models: [], error: null };
  if (FAKE_BASE) return { ...out, reachable: out.configured, models: out.configured ? [c.base] : [], fake: true };
  if (!(c.url || c.ssh)) return out;
  try {
    if (connect) await ensureTunnel(c, () => {});
    out.reachable = await up(c);
    out.tunnel = !!tunnel;
    if (out.reachable) out.models = ((await api(c, '/api/tags')).models || []).map((m) => m.name).filter((n) => !/^lc-.*-\d+[kt](:latest)?$/.test(n));
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/** Closes the tunnel this app opened (never one opened by hand). */
function stop() {
  const t = tunnel;
  tunnel = null;
  if (t && t.exitCode === null) {
    try {
      t.kill();
    } catch {}
  }
}

module.exports = { prepare, status, stop, config, configured, label, DEFAULTS };
