// Everything the app keeps on disk lives in Electron's userData folder (%APPDATA%\Local Claude):
//   settings.json      preferences the UI changes
//   config.json        hand-edited config: MCP servers + built-in tool rules (see config.js)
//   usage.json         tokens per month and model
//   process-logs/      output of background processes the model started
//   conversations/     one JSON file per chat, holding the exact API message history
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');

const dir = () => app.getPath('userData');
const file = (name) => path.join(dir(), name);
const convDir = () => path.join(dir(), 'conversations');

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

// write to a temp file first, so a crash mid-write never leaves half a file behind
function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// ---------------------------------------------------------------- API key

function hasKey() {
  return fs.existsSync(file('key.enc'));
}

function getKey() {
  try {
    const buf = Buffer.from(fs.readFileSync(file('key.enc'), 'utf8'), 'base64');
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

function setKey(key) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows encryption (DPAPI) is not available, so the key cannot be stored safely.');
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file('key.enc'), safeStorage.encryptString(key).toString('base64'), 'utf8');
}

function removeKey() {
  try {
    fs.rmSync(file('key.enc'), { force: true });
  } catch {}
}

// ---------------------------------------------------------------- settings

const DEFAULT_SETTINGS = {
  name: '',
  theme: 'system', // system | light | dark
  chatFont: 'serif', // serif | sans | system
  model: 'quick', // quick | smart
  modes: {}, // mode -> { base: Ollama model, ctx: context window }; empty = defaults in ollama.js
  ramLimitGb: 0, // most system RAM a loaded model may take (the part that does not fit on the GPU); 0 = no limit
  keepAlive: '5m', // how long a model stays loaded after an answer: '0' | '5m' | '30m' | '-1' (until the app closes)
  setup: {}, // { done, dismissed, at }: the "set up for this PC" dialog was applied or closed (see hardware.js)
  hintsOff: {}, // "mode:model" -> true after "Don't show again" on a "this model is slow here" hint
  server: {}, // the Server mode: a model on another machine { url | ssh, key, port, base, ctx }; empty = not set up (see server.js)
  colibri: {}, // the colibri engine for the Coder 30B mode: { dir, modelDir, cap, ctx, port, gpu }; empty = defaults in colibri.js
  selfCheck: 'smart', // off | smart | always: make the model check its work before it finishes
  effort: 'default', // default (thinking on) | off
  webSearch: true, // web_search / web_fetch tools (need internet; everything else works offline)
  thinkingOpen: true, // keep the thought process expanded after it finishes
  computer: true, // terminal + file tools
  mcpOff: {}, // server name -> true when switched off in the tools menu
  customInstructions: '',
  sendWithEnter: true,
  sidebarCollapsed: false,
  showCost: true,
  toolPermissions: {}, // tool name -> 'allow' after "Always allow"
};

let settings = null;
function getSettings() {
  if (!settings) settings = { ...DEFAULT_SETTINGS, ...readJson(file('settings.json'), {}) };
  return settings;
}
function saveSettings(patch) {
  settings = { ...getSettings(), ...patch };
  writeJson(file('settings.json'), settings);
  return settings;
}

// ---------------------------------------------------------------- conversations

const newId = () => crypto.randomBytes(8).toString('hex');
const convPath = (id) => {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('bad conversation id');
  return path.join(convDir(), `${id}.json`);
};

function listConversations() {
  let names = [];
  try {
    names = fs.readdirSync(convDir()).filter((n) => n.endsWith('.json'));
  } catch {}
  const out = [];
  for (const n of names) {
    const c = readJson(path.join(convDir(), n), null);
    if (c && c.id) out.push({ id: c.id, title: c.title, starred: !!c.starred, updatedAt: c.updatedAt, createdAt: c.createdAt });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function getConversation(id) {
  return readJson(convPath(id), null);
}

function saveConversation(conv) {
  writeJson(convPath(conv.id), conv);
}

function deleteConversation(id) {
  fs.rmSync(convPath(id), { force: true });
}

// ---------------------------------------------------------------- usage

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getUsage() {
  return readJson(file('usage.json'), { months: {}, total: 0 });
}

function addUsage(model, usage, cost) {
  const u = getUsage();
  const m = (u.months[monthKey()] ||= { cost: 0, input: 0, output: 0, requests: 0, byModel: {} });
  m.cost += cost;
  m.requests += 1;
  m.input += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  m.output += usage.output_tokens || 0;
  m.byModel[model] = (m.byModel[model] || 0) + (usage.input_tokens || 0) + (usage.output_tokens || 0); // tokens (local models are free)
  u.total = (u.total || 0) + cost;
  writeJson(file('usage.json'), u);
}

module.exports = {
  dir,
  file,
  readJson,
  writeJson,
  hasKey,
  getKey,
  setKey,
  removeKey,
  getSettings,
  saveSettings,
  newId,
  listConversations,
  getConversation,
  saveConversation,
  deleteConversation,
  getUsage,
  addUsage,
  monthKey,
};
