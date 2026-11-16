// MCP servers from config.json's "mcpServers" block (the Claude Desktop format). Local servers
// are started as child processes (stdio); entries with a "url" connect over Streamable HTTP.
// Their tools are offered to Claude as mcp__<server>__<tool>.
const crypto = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const config = require('./config');

const servers = new Map(); // name -> { name, key, state, error, tools, client, transport, stderr }
const toolIndex = new Map(); // api tool name -> { server, tool }
const listeners = new Set();
let version = '1.0.0';

const clean = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
function apiName(server, tool) {
  const name = `mcp__${clean(server)}__${clean(tool)}`;
  if (name.length <= 64) return name;
  const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, 8);
  return `${name.slice(0, 55)}_${hash}`;
}

function emit() {
  const s = status();
  for (const fn of listeners) fn(s);
}

function status() {
  return [...servers.values()].map((s) => ({
    name: s.name,
    state: s.state,
    error: s.error,
    tools: (s.tools || []).map((t) => ({ name: t.name, description: (t.description || '').slice(0, 200) })),
    remote: !!s.cfg.url,
  }));
}

async function connect(entry) {
  const { name, cfg } = entry;
  entry.state = 'connecting';
  entry.error = null;
  entry.stderr = '';
  emit();
  try {
    let transport;
    if (cfg.url) {
      transport = new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers || {} } });
    } else {
      if (!cfg.command) throw new Error('needs a "command" (or a "url")');
      transport = new StdioClientTransport({
        command: cfg.command,
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
        env: { ...process.env, ...(cfg.env || {}) },
        cwd: cfg.cwd || undefined,
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (d) => {
        entry.stderr = (entry.stderr + d.toString()).slice(-4000);
      });
    }
    const client = new Client({ name: 'LocalClaude', version }, { capabilities: {} });
    entry.client = client;
    entry.transport = transport;
    transport.onclose = () => {
      if (entry.client === client && entry.state === 'ready') {
        entry.state = 'error';
        entry.error = 'The server stopped.' + (entry.stderr ? `\n${entry.stderr.trim().split('\n').slice(-5).join('\n')}` : '');
        rebuildIndex();
        emit();
      }
    };
    await withTimeout(client.connect(transport), 90000, 'Timed out starting the server (90 s).');
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    entry.tools = tools;
    entry.state = 'ready';
  } catch (e) {
    entry.state = 'error';
    const tail = entry.stderr ? `\n${entry.stderr.trim().split('\n').slice(-6).join('\n')}` : '';
    entry.error = `${e.message || e}${tail}`;
    try {
      await entry.client?.close();
    } catch {}
    entry.client = null;
  }
  rebuildIndex();
  emit();
}

function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(msg)), ms)))]).finally(() => clearTimeout(t));
}

function rebuildIndex() {
  toolIndex.clear();
  for (const s of servers.values()) {
    if (s.state !== 'ready') continue;
    for (const t of s.tools) toolIndex.set(apiName(s.name, t.name), { server: s.name, tool: t });
  }
}

async function stop(entry) {
  entry.state = 'stopped';
  const c = entry.client;
  entry.client = null;
  try {
    await c?.close();
  } catch {}
}

/** Starts, restarts and stops servers so they match config.json. */
async function sync() {
  const wanted = config.get().mcpServers || {};
  const jobs = [];
  for (const [name, entry] of servers) {
    const cfg = wanted[name];
    if (!cfg || JSON.stringify(cfg) !== entry.key) {
      jobs.push(stop(entry));
      servers.delete(name);
    }
  }
  for (const [name, cfg] of Object.entries(wanted)) {
    if (servers.has(name) || !cfg || typeof cfg !== 'object') continue;
    const entry = { name, cfg, key: JSON.stringify(cfg), state: 'disabled', tools: [], error: null };
    servers.set(name, entry);
    if (!cfg.disabled) jobs.push(connect(entry));
  }
  rebuildIndex();
  emit();
  await Promise.allSettled(jobs);
}

async function restart(name) {
  const entry = servers.get(name);
  if (!entry) return;
  await stop(entry);
  await connect(entry);
}

/** API tool definitions for the servers that are ready and not switched off. */
function definitions(off = {}) {
  const defs = [];
  const names = [...servers.keys()].sort();
  for (const n of names) {
    const s = servers.get(n);
    if (s.state !== 'ready' || off[n]) continue;
    for (const t of s.tools) {
      const schema = t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} };
      defs.push({
        name: apiName(n, t.name),
        description: `[${n}] ${t.description || t.title || t.name}`.slice(0, 4000),
        input_schema: schema,
        eager_input_streaming: true,
      });
    }
  }
  return defs;
}

function lookup(apiToolName) {
  return toolIndex.get(apiToolName) || null;
}

function autoApproved(apiToolName) {
  const hit = lookup(apiToolName);
  if (!hit) return false;
  const list = servers.get(hit.server)?.cfg.autoApprove;
  return Array.isArray(list) && (list.includes(hit.tool.name) || list.includes('*'));
}

/** Runs an MCP tool and converts its result into tool_result content blocks. */
async function call(apiToolName, input, signal) {
  const hit = lookup(apiToolName);
  if (!hit) return { isError: true, text: 'That MCP tool is not available any more (its server stopped or was switched off).' };
  const entry = servers.get(hit.server);
  try {
    const res = await entry.client.callTool({ name: hit.tool.name, arguments: input || {} }, undefined, { signal, timeout: 600000, resetTimeoutOnProgress: true });
    const content = [];
    for (const c of res.content || []) {
      if (c.type === 'text') content.push({ type: 'text', text: c.text || '' });
      else if (c.type === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(c.mimeType)) content.push({ type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } });
      else if (c.type === 'resource') content.push({ type: 'text', text: c.resource?.text ?? `[resource ${c.resource?.uri || ''}]` });
      else if (c.type === 'resource_link') content.push({ type: 'text', text: `[link ${c.uri}${c.name ? ` "${c.name}"` : ''}]` });
      else content.push({ type: 'text', text: `[${c.type} content not shown]` });
    }
    if (!content.length && res.structuredContent) content.push({ type: 'text', text: JSON.stringify(res.structuredContent, null, 2) });
    if (!content.length) content.push({ type: 'text', text: '(no output)' });
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { isError: !!res.isError, content, text };
  } catch (e) {
    return { isError: true, text: `MCP error from ${hit.server}: ${e.message || e}` };
  }
}

function onStatus(fn) {
  listeners.add(fn);
}

async function shutdown() {
  await Promise.allSettled([...servers.values()].map(stop));
}

function setVersion(v) {
  version = v;
}

module.exports = { sync, restart, status, definitions, lookup, autoApproved, call, onStatus, shutdown, setVersion };
