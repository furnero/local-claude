// config.json - the hand-edited config, laid out like Claude Desktop's
// claude_desktop_config.json so its "mcpServers" block can be pasted in as is:
//
// {
//   "mcpServers": {
//     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\me"] },
//     "remote":     { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } }
//   },
//   "tools": { ...built-in terminal/file tool rules, see DEFAULT_TOOLS... }
// }
//
// Per server, Aster also understands "disabled": true and "autoApprove": ["tool", ...].
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('./store');

const DEFAULT_TOOLS = {
  shell: {
    enabled: true,
    approval: 'ask', // ask | auto
    timeoutSeconds: 120,
  },
  files: {
    enabled: true,
    readApproval: 'auto', // read_file / list_directory
    writeApproval: 'ask', // write_file / edit_file / download_file
  },
  web: {
    enabled: true, // web_search / web_fetch (only work while the PC is online)
    approval: 'ask', // ask | auto
  },
  workingDirectory: '', // empty = the folder above LocalClaude (D:\VSCode Projects)
};

const TEMPLATE = {
  mcpServers: {},
  tools: DEFAULT_TOOLS,
};

const configPath = () => store.file('config.json');

let current = null;
let error = null;
const listeners = new Set();

function ensureFile() {
  if (!fs.existsSync(configPath())) store.writeJson(configPath(), TEMPLATE);
}

function load() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, ''));
    if (typeof raw !== 'object' || !raw || Array.isArray(raw)) throw new Error('config.json must hold a JSON object');
    const tools = raw.tools || {};
    current = {
      mcpServers: raw.mcpServers && typeof raw.mcpServers === 'object' ? raw.mcpServers : {},
      tools: {
        shell: { ...DEFAULT_TOOLS.shell, ...(tools.shell || {}) },
        files: { ...DEFAULT_TOOLS.files, ...(tools.files || {}) },
        web: { ...DEFAULT_TOOLS.web, ...(tools.web || {}) },
        workingDirectory: tools.workingDirectory || '',
      },
    };
    error = null;
  } catch (e) {
    error = `config.json: ${e.message}`;
    if (!current) current = { mcpServers: {}, tools: structuredClone(DEFAULT_TOOLS) };
  }
  return current;
}

function get() {
  return current || load();
}

function status() {
  return { path: configPath(), error };
}

function workingDirectory() {
  const wd = get().tools.workingDirectory;
  return wd && fs.existsSync(wd) ? wd : require('./project').defaultFolder();
}

let watchTimer = null;
function watch() {
  ensureFile();
  try {
    fs.watch(path.dirname(configPath()), (_ev, name) => {
      if (name !== 'config.json') return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        load();
        for (const fn of listeners) fn(current);
      }, 300);
    });
  } catch {}
}

function onChange(fn) {
  listeners.add(fn);
}

/** Copies the mcpServers block from Claude Desktop's config into ours (existing names win). */
function importClaudeDesktop() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [path.join(appData, 'Claude', 'claude_desktop_config.json')];
  // the Microsoft Store build keeps its AppData inside the package folder
  try {
    for (const pkg of fs.readdirSync(path.join(local, 'Packages'))) {
      if (/^Claude_/i.test(pkg)) candidates.push(path.join(local, 'Packages', pkg, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
    }
  } catch {}
  const found = candidates.filter((p) => fs.existsSync(p));
  if (!found.length) return { ok: false, error: "Couldn't find Claude Desktop's claude_desktop_config.json." };
  let servers = {};
  for (const p of found) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      servers = { ...(raw.mcpServers || {}), ...servers };
    } catch {}
  }
  const names = Object.keys(servers);
  if (!names.length) return { ok: false, error: "Claude Desktop's config has no MCP servers." };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { ok: false, error: 'Fix the errors in config.json first.' };
  }
  raw.mcpServers ||= {};
  const added = [];
  for (const n of names) {
    if (!raw.mcpServers[n]) {
      raw.mcpServers[n] = servers[n];
      added.push(n);
    }
  }
  store.writeJson(configPath(), raw);
  load();
  for (const fn of listeners) fn(current);
  return { ok: true, added, skipped: names.filter((n) => !added.includes(n)) };
}

module.exports = { load, get, status, watch, onChange, configPath, workingDirectory, importClaudeDesktop, DEFAULT_TOOLS };
