// Built-in "computer" tools: a terminal (PowerShell / cmd / bash) and file tools that act on
// this PC. Every call goes through the approval rules in config.json (see config.js) before
// it runs; chat.js does the asking.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const config = require('./config');

const MAX_OUTPUT = 30000;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// ---------------------------------------------------------------- which shells exist

let shells = null;
function findShells() {
  if (shells) return shells;
  shells = {};
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    shells.powershell = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    shells.cmd = process.env.ComSpec || path.join(sysRoot, 'System32', 'cmd.exe');
    try {
      const p = execFileSync('where.exe', ['pwsh'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim();
      if (p) shells.pwsh = p;
    } catch {}
    const gitBash = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    ].find((p) => p && fs.existsSync(p));
    if (gitBash) shells.bash = gitBash;
  } else {
    shells.bash = '/bin/bash';
  }
  return shells;
}

// ---------------------------------------------------------------- definitions

// groups: 'computer' (terminal, files, processes), 'web' (search, fetch), and tools that are
// always there (plan, notes, memory search). opts switches the first two per message.
function definitions(opts = { computer: true, web: true }) {
  const cfg = config.get().tools;
  const defs = [];
  defs.push(
    {
      name: 'update_plan',
      description:
        'Shows the user your plan as a checklist and keeps it up to date. Call it at the start of any task with more than two steps (all steps, the first one "doing"), and again whenever a step is finished or the plan changes. Always send the whole list.',
      input_schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'All steps in order.',
            items: { type: 'object', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'doing', 'done'] } }, required: ['text', 'status'] },
          },
        },
        required: ['items'],
      },
    },
    {
      name: 'save_note',
      description:
        "Writes one entry into your notes file for this project (your memory between chats). Sections: done (finished work), open (not done yet), needs_fixing (bugs and failures, with the error), facts (paths, commands, hosts, gotchas, the user's decisions), status (replaces the one-line project status). The date is added for you. Needs no approval. Use this instead of edit_file for notes.",
      input_schema: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: ['done', 'open', 'needs_fixing', 'facts', 'status'] },
          text: { type: 'string', description: 'One short entry.' },
        },
        required: ['section', 'text'],
      },
    },
    {
      name: 'remove_note',
      description: 'Removes entries from your notes file whose text contains the given words (for example an Open item that is now done, or a fact that is no longer true).',
      input_schema: { type: 'object', properties: { contains: { type: 'string', description: 'Text the entry contains.' } }, required: ['contains'] },
    },
    {
      name: 'search_memory',
      description:
        "Searches your own notes (all projects) and Claude's memory notes for a topic and returns the best matching files with the matching lines. Use it first whenever the user mentions a project, feature, server or problem, to see what is already done, open or broken.",
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'A few keywords, e.g. "pangobot deploy".' } }, required: ['query'] },
    },
  );
  if (opts.web && cfg.web.enabled) {
    defs.push(
      {
        name: 'web_search',
        description: 'Searches the web (DuckDuckGo) and returns the top results with title, URL and a short snippet. Needs an internet connection. Follow up with web_fetch to read a result.',
        input_schema: { type: 'object', properties: { query: { type: 'string', description: 'The search words.' } }, required: ['query'] },
      },
      {
        name: 'web_fetch',
        description: 'Fetches a web page (http/https) and returns its readable text, about 12,000 characters at a time. Use offset to read further. For files to keep, use download_file instead.',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The page URL.' },
            offset: { type: 'integer', description: 'Character position to continue from (default 0).' },
          },
          required: ['url'],
        },
      },
    );
  }
  if (!opts.computer) return defs;
  if (cfg.shell.enabled) {
    const names = Object.keys(findShells());
    defs.push({
      name: 'run_command',
      description:
        "Runs a command in a terminal on the user's Windows PC and returns its exit code and output (stdout + stderr). " +
        `Available shells: ${names.join(', ')}. PowerShell is the default. ` +
        "Each call is a fresh process: use `cwd` to choose the folder, a `cd` doesn't carry over to the next call. " +
        'Commands get no input (stdin is closed), so never start interactive programs or prompts; pass flags such as -y / -Force / --yes instead. ' +
        `Long-running commands are stopped after timeout_seconds (default ${cfg.shell.timeoutSeconds}). ` +
        'The user may be asked to approve each command, so explain briefly what a command does before running it.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run.' },
          shell: { type: 'string', enum: names, description: 'Which shell runs the command. Default: powershell.' },
          cwd: { type: 'string', description: "Working folder (absolute path). Default: the chat's working folder." },
          timeout_seconds: { type: 'integer', description: 'Stop the command after this many seconds (max 1800).' },
        },
        required: ['command'],
      },
    });
  }
  if (cfg.files.enabled) {
    defs.push(
      {
        name: 'read_file',
        description:
          'Reads a file from the PC. Text comes back with line numbers; images (png, jpg, gif, webp) come back as images you can see. ' +
          'For big files, read a window with offset/limit. Relative paths start at the working folder.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path.' },
            offset: { type: 'integer', description: 'First line to read (1-based).' },
            limit: { type: 'integer', description: 'Number of lines to read (default 2000).' },
          },
          required: ['path'],
        },
      },
      {
        name: 'list_directory',
        description: 'Lists the files and folders in a folder on the PC, with sizes.',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Folder path. Default: the working folder.' } },
          required: [],
        },
      },
      {
        name: 'search_files',
        description:
          'Finds files under a folder by file name and/or by text inside them (case-insensitive). Skips node_modules, .git and similar. ' +
          'Use it instead of guessing paths. Returns matching paths, and for a text search the matching lines with line numbers.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Folder to search. Default: the working folder.' },
            name: { type: 'string', description: 'File name pattern with * and ?, e.g. *.py or server*.properties.' },
            text: { type: 'string', description: 'Text to look for inside the files.' },
          },
          required: [],
        },
      },
      {
        name: 'write_file',
        description: 'Creates or overwrites a file on the PC with the given text (missing folders are created). Prefer edit_file for small changes to existing files.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path.' },
            content: { type: 'string', description: 'The full new file content.' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'edit_file',
        description:
          'Replaces text in an existing file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path.' },
            old_string: { type: 'string', description: 'Exact text to replace.' },
            new_string: { type: 'string', description: 'Replacement text.' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
      {
        name: 'download_file',
        description:
          'Downloads a file from an http(s) URL to a path on the PC (missing folders are created) and reports its size and SHA-256. ' +
          'Use it for installers, server jars, archives and the like. Only download from official sources the user would trust.',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The http(s) URL.' },
            path: { type: 'string', description: 'Where to save the file (full path or relative to the working folder).' },
          },
          required: ['url', 'path'],
        },
      },
    );
  }
  if (cfg.shell.enabled) {
    defs.push(
      {
        name: 'start_process',
        description:
          'Starts a long-running program in the background (a Minecraft or other game server, a dev server, a watcher) and keeps it running after this call and across messages. ' +
          'Runs in PowerShell. Returns an id plus the first few seconds of output. Use process_output to read more (it can wait for a line such as "Done" in the log), send_input to type into its console, stop_process to end it. ' +
          'For commands that finish on their own, use run_command instead.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command line, e.g. java -Xmx2G -jar server.jar nogui' },
            cwd: { type: 'string', description: "Working folder (absolute path). Default: the chat's working folder." },
            name: { type: 'string', description: 'A short name, e.g. "MC test server".' },
          },
          required: ['command'],
        },
      },
      {
        name: 'process_output',
        description:
          'Reads new output of a background process since the last read. Can wait up to wait_seconds (max 600) for output, or until a given text appears (e.g. "Done (" when a Minecraft server has started). Also says whether it is still running.',
        input_schema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The process id from start_process (e.g. p1).' },
            wait_seconds: { type: 'integer', description: 'How long to wait for output (default 0).' },
            until_text: { type: 'string', description: 'Stop waiting as soon as this text appears in the output.' },
            tail: { type: 'integer', description: 'Instead of new output, return the last N characters.' },
          },
          required: ['id'],
        },
      },
      {
        name: 'send_input',
        description: 'Types a line into the console (stdin) of a background process, e.g. "stop" or "say hello" for a Minecraft server. Enter is added.',
        input_schema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The process id.' },
            text: { type: 'string', description: 'The line to type.' },
          },
          required: ['id', 'text'],
        },
      },
      {
        name: 'stop_process',
        description: 'Kills a background process and everything it started. Prefer a clean console command first (e.g. send_input "stop" for a Minecraft server), then use this if it does not exit.',
        input_schema: { type: 'object', properties: { id: { type: 'string', description: 'The process id.' } }, required: ['id'] },
      },
      {
        name: 'list_processes',
        description: 'Lists the background processes started in this app, with their ids and whether they are still running.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
    );
  }
  return defs;
}

const ALWAYS = ['update_plan', 'save_note', 'remove_note', 'search_memory'];
const WEB = ['web_search', 'web_fetch'];
const BUILTIN = new Set([...ALWAYS, ...WEB, 'run_command', 'read_file', 'list_directory', 'search_files', 'write_file', 'edit_file', 'download_file', 'start_process', 'process_output', 'send_input', 'stop_process', 'list_processes']);

/** 'always' | 'web' | 'computer': which switch in the tools menu a built-in tool belongs to. */
function group(name) {
  if (ALWAYS.includes(name)) return 'always';
  if (WEB.includes(name)) return 'web';
  return 'computer';
}

/** 'shell' | 'read' | 'write' | 'web' | 'own' for built-in tools, null for anything else. */
function category(name) {
  if (ALWAYS.includes(name)) return 'own'; // the app's own data: never asks
  if (WEB.includes(name)) return 'web';
  if (['run_command', 'start_process', 'send_input', 'stop_process'].includes(name)) return 'shell';
  if (['read_file', 'list_directory', 'search_files', 'process_output', 'list_processes'].includes(name)) return 'read';
  if (['write_file', 'edit_file', 'download_file'].includes(name)) return 'write';
  return null;
}

/** The file a writing tool would change (absolute), or null. */
function writeTarget(name, input, cwd) {
  if (category(name) !== 'write' || !input?.path) return null;
  return resolvePath(input.path, cwd);
}

function needsApproval(name) {
  const cfg = config.get().tools;
  const c = category(name);
  if (c === 'shell') return cfg.shell.approval !== 'auto';
  if (c === 'read') return cfg.files.readApproval !== 'auto';
  if (c === 'write') return cfg.files.writeApproval !== 'auto';
  if (c === 'web') return cfg.web.approval !== 'auto';
  if (c === 'own') return false;
  return true;
}

// The model's input arrives through eager streaming, so it is checked here before anything runs.
function validate(name, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'The tool input was not a JSON object.';
  const def = definitions().find((d) => d.name === name);
  if (!def) return `Unknown tool ${name}.`;
  for (const req of def.input_schema.required) if (!(req in input)) return `Missing required field "${req}".`;
  for (const [k, raw] of Object.entries(input)) {
    const spec = def.input_schema.properties[k];
    if (!spec) continue;
    // small models often send "30" or 30.0 for an integer and "true" for a boolean: accept those
    let v = raw;
    if (spec.type === 'integer' && typeof v === 'string' && /^-?\d+(\.0+)?$/.test(v.trim())) v = input[k] = parseInt(v, 10);
    if (spec.type === 'integer' && typeof v === 'number' && !Number.isInteger(v) && Number.isFinite(v)) v = input[k] = Math.round(v);
    if (spec.type === 'boolean' && typeof v === 'string' && /^(true|false)$/i.test(v.trim())) v = input[k] = /^true$/i.test(v.trim());
    if (spec.type === 'string' && typeof v === 'number') v = input[k] = String(v);
    if (spec.type === 'array' && !Array.isArray(v)) return `"${k}" must be a list.`;
    if (spec.type === 'string' && typeof v !== 'string') return `"${k}" must be a string.`;
    if (spec.type === 'integer' && !Number.isInteger(v)) return `"${k}" must be an integer.`;
    if (spec.type === 'boolean' && typeof v !== 'boolean') return `"${k}" must be true or false.`;
    if (spec.enum && !spec.enum.includes(v)) return `"${k}" must be one of ${spec.enum.join(', ')}.`;
  }
  return null;
}

// ---------------------------------------------------------------- helpers

function resolvePath(p, cwd) {
  if (!p) return cwd;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd, p);
}

function clip(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n[... ${text.length - max} characters cut ...]\n\n${text.slice(-tail)}`;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {}
  } else {
    child.kill('SIGKILL');
  }
}

// ---------------------------------------------------------------- run

function runCommand(input, ctx) {
  const cfg = config.get().tools.shell;
  const all = findShells();
  const shellName = input.shell && all[input.shell] ? input.shell : all.powershell ? 'powershell' : Object.keys(all)[0];
  const exe = all[shellName];
  const cwd = resolvePath(input.cwd, ctx.cwd);
  if (!fs.existsSync(cwd)) return Promise.resolve({ isError: true, text: `The folder ${cwd} doesn't exist.` });
  const timeout = Math.min(Math.max(Number(input.timeout_seconds) || cfg.timeoutSeconds, 1), 1800);

  let args;
  let opts = { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env };
  if (shellName === 'powershell' || shellName === 'pwsh') {
    const script = `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding\n${input.command}`;
    args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  } else if (shellName === 'cmd') {
    args = ['/d', '/s', '/c', `"chcp 65001 >nul & ${input.command}"`];
    opts.windowsVerbatimArguments = true;
  } else {
    args = ['-c', input.command];
  }

  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(exe, args, opts);
    } catch (e) {
      resolve({ isError: true, text: `Couldn't start ${shellName}: ${e.message}` });
      return;
    }
    ctx.track(child);
    const push = (chunk, isErr) => {
      const s = chunk.toString('utf8');
      if (isErr) err += s;
      else out += s;
      if (out.length + err.length > 2_000_000) {
        // runaway output: keep the process from filling memory
        out = clip(out, 200000);
        err = clip(err, 100000);
      }
      ctx.progress(s);
    };
    child.stdout.on('data', (c) => push(c, false));
    child.stderr.on('data', (c) => push(c, true));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ isError: true, text: `Couldn't run the command: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      ctx.untrack(child);
      if (ctx.signal.aborted) {
        resolve({ isError: true, text: 'The user stopped this command.', exitCode: code });
        return;
      }
      let text = `Exit code: ${code}${timedOut ? ` (stopped after ${timeout} s timeout)` : ''}\n`;
      text += out.trim() ? clip(out.replace(/\s+$/, ''), MAX_OUTPUT) : '(no output)';
      if (err.trim()) text += `\n--- stderr ---\n${clip(err.replace(/\s+$/, ''), 12000)}`;
      resolve({ isError: false, text, exitCode: code, shell: shellName, cwd });
    });
  });
}

async function readFile(input, ctx) {
  const p = resolvePath(input.path, ctx.cwd);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return { isError: true, text: `File not found: ${p}` };
  }
  if (st.isDirectory()) return { isError: true, text: `${p} is a folder. Use list_directory.` };
  const ext = path.extname(p).toLowerCase();
  if (IMAGE_TYPES[ext]) {
    if (st.size > 20 * 1024 * 1024) return { isError: true, text: `The image is ${(st.size / 1048576).toFixed(1)} MB; the limit is 20 MB.` };
    // The model gets a copy of at most 896 px: enough to see what it shows, cheap in context.
    let note = `Image file ${p} (${fmtSize(st.size)}`;
    let data = null;
    let mediaType = IMAGE_TYPES[ext];
    try {
      const { nativeImage } = require('electron');
      let img = nativeImage.createFromPath(p);
      const { width, height } = img.getSize();
      if (width && height) {
        note += `, ${width} x ${height} px`;
        const scale = Math.min(1, 896 / Math.max(width, height));
        if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' });
        data = img.toPNG().toString('base64');
        mediaType = 'image/png';
      }
    } catch {}
    if (!data && st.size <= 1024 * 1024) data = fs.readFileSync(p).toString('base64');
    note += '). This is a picture, not text: to use it somewhere, copy the file with a command; do not retype or redraw it.';
    if (!ctx.vision || !data) return { isError: false, text: `${note}${ctx.vision ? '' : ' (This model cannot look at pictures.)'}` };
    return { isError: false, content: [{ type: 'text', text: `${note} A small copy follows so you can see it.` }, { type: 'image', source: { type: 'base64', media_type: mediaType, data } }], text: note };
  }
  if (st.size > 50 * 1024 * 1024) return { isError: true, text: `The file is ${(st.size / 1048576).toFixed(0)} MB, too big to read. Use run_command to look at parts of it.` };
  const buf = fs.readFileSync(p);
  if (buf.subarray(0, 8000).includes(0)) return { isError: true, text: `${p} is a binary file (${st.size} bytes).` };
  const lines = buf.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const start = Math.max(1, Number(input.offset) || 1);
  const count = Math.max(1, Number(input.limit) || 2000);
  const slice = lines.slice(start - 1, start - 1 + count);
  const width = String(start + slice.length).length;
  let text = slice.map((l, i) => `${String(start + i).padStart(width)}\t${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`).join('\n');
  if (start - 1 + count < lines.length) text += `\n\n(${lines.length} lines in total; read more with offset ${start + count})`;
  return { isError: false, text: clip(text, 100000) };
}

async function listDirectory(input, ctx) {
  const p = resolvePath(input.path, ctx.cwd);
  let entries;
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch (e) {
    return { isError: true, text: `Can't list ${p}: ${e.code || e.message}` };
  }
  entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  const lines = [];
  for (const e of entries.slice(0, 500)) {
    if (e.isDirectory()) lines.push(`[dir]  ${e.name}`);
    else {
      let size = '';
      try {
        size = fmtSize(fs.statSync(path.join(p, e.name)).size);
      } catch {}
      lines.push(`[file] ${e.name}${size ? `  (${size})` : ''}`);
    }
  }
  if (entries.length > 500) lines.push(`... and ${entries.length - 500} more`);
  return { isError: false, text: `${p}\n${lines.join('\n') || '(empty)'}` };
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

async function writeFile(input, ctx) {
  const p = resolvePath(input.path, ctx.cwd);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const existed = fs.existsSync(p);
    fs.writeFileSync(p, input.content, 'utf8');
    return { isError: false, text: `${existed ? 'Overwrote' : 'Created'} ${p} (${Buffer.byteLength(input.content)} bytes).` };
  } catch (e) {
    return { isError: true, text: `Couldn't write ${p}: ${e.message}` };
  }
}

async function editFile(input, ctx) {
  const p = resolvePath(input.path, ctx.cwd);
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return { isError: true, text: `File not found: ${p}` };
  }
  if (!input.old_string) return { isError: true, text: 'old_string is empty.' };
  // files with Windows line ends: match the model's \n text against \r\n too
  let oldS = input.old_string;
  let newS = input.new_string;
  if (!text.includes(oldS) && text.includes('\r\n') && oldS.includes('\n')) {
    oldS = oldS.replace(/\r?\n/g, '\r\n');
    newS = newS.replace(/\r?\n/g, '\r\n');
  }
  const count = text.split(oldS).length - 1;
  if (count === 0) return { isError: true, text: 'old_string was not found in the file. Read the file again and copy the text exactly.' };
  if (count > 1 && !input.replace_all) return { isError: true, text: `old_string occurs ${count} times. Add more context to make it unique, or set replace_all.` };
  const next = input.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
  try {
    fs.writeFileSync(p, next, 'utf8');
  } catch (e) {
    return { isError: true, text: `Couldn't write ${p}: ${e.message}` };
  }
  return { isError: false, text: `Edited ${p} (${input.replace_all ? count : 1} replacement${count > 1 && input.replace_all ? 's' : ''}).` };
}

// ---------------------------------------------------------------- search

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.gradle', '.idea', 'dist', 'build', 'out', '.next', '.cache']);
const TEXT_LIMIT = 2 * 1024 * 1024;

function globToRegex(g) {
  return new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

async function searchFiles(input, ctx) {
  const root = resolvePath(input.path, ctx.cwd);
  if (!fs.existsSync(root)) return { isError: true, text: `The folder ${root} doesn't exist.` };
  if (!input.name && !input.text) return { isError: true, text: 'Give a name pattern, a text to look for, or both.' };
  const nameRe = input.name ? globToRegex(input.name) : null;
  const needle = input.text ? String(input.text).toLowerCase() : null;
  const hits = [];
  let scanned = 0;
  let lines = 0;
  const stack = [root];
  const started = Date.now();
  while (stack.length && hits.length < 200 && scanned < 30000 && Date.now() - started < 20000) {
    if (ctx.signal.aborted) break;
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('$')) stack.push(full);
        continue;
      }
      scanned++;
      if (nameRe && !nameRe.test(e.name)) continue;
      if (!needle) {
        hits.push(full);
        continue;
      }
      let buf;
      try {
        if (fs.statSync(full).size > TEXT_LIMIT) continue;
        buf = fs.readFileSync(full);
      } catch {
        continue;
      }
      if (buf.subarray(0, 4000).includes(0)) continue;
      const found = [];
      buf.toString('utf8').split(/\r?\n/).forEach((l, i) => {
        if (found.length < 5 && l.toLowerCase().includes(needle)) found.push(`  ${i + 1}: ${l.trim().slice(0, 200)}`);
      });
      if (found.length) {
        hits.push(`${full}\n${found.join('\n')}`);
        lines += found.length;
      }
      if (hits.length >= 200) break;
    }
  }
  if (!hits.length) return { isError: false, text: `No matches under ${root} (${scanned} files looked at).` };
  return { isError: false, text: clip(`${hits.length} match${hits.length === 1 ? '' : 'es'} under ${root}${hits.length >= 200 ? ' (stopped at 200)' : ''}:\n${hits.join('\n')}`) };
}

// ---------------------------------------------------------------- download

async function downloadFile(input, ctx) {
  let url;
  try {
    url = new URL(input.url);
  } catch {
    return { isError: true, text: 'That is not a valid URL.' };
  }
  if (!/^https?:$/.test(url.protocol)) return { isError: true, text: 'Only http and https URLs can be downloaded.' };
  const p = resolvePath(input.path, ctx.cwd);
  const crypto = require('node:crypto');
  const { Readable } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  let res;
  try {
    res = await fetch(url, { signal: ctx.signal, redirect: 'follow' });
  } catch (e) {
    return { isError: true, text: `Download failed: ${e.message}` };
  }
  if (!res.ok || !res.body) return { isError: true, text: `Download failed: HTTP ${res.status} ${res.statusText}` };
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.part`;
  const hash = crypto.createHash('sha256');
  let got = 0;
  let lastShown = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    got += chunk.length;
    hash.update(chunk);
    if (got - lastShown > 5 * 1048576) {
      lastShown = got;
      ctx.progress(`${fmtSize(got)}${total ? ` of ${fmtSize(total)}` : ''}\n`);
    }
  });
  try {
    await pipeline(body, fs.createWriteStream(tmp));
    fs.renameSync(tmp, p);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    return { isError: true, text: ctx.signal.aborted ? 'The user stopped the download.' : `Download failed: ${e.message}` };
  }
  return { isError: false, text: `Downloaded ${res.url || url.href}\nto ${p}\n${fmtSize(got)}, SHA-256 ${hash.digest('hex')}` };
}

// ---------------------------------------------------------------- background processes

const procs = require('./processes');

function procText(p, extra = '') {
  const s = procs.summary(p);
  return `${s.id} "${s.name}" ${s.running ? `running (pid ${s.pid})` : `exited with code ${s.exitCode}`}${extra}`;
}

async function startProcess(input, ctx) {
  const all = findShells();
  const cwd = resolvePath(input.cwd, ctx.cwd);
  if (!fs.existsSync(cwd)) return { isError: true, text: `The folder ${cwd} doesn't exist.` };
  const script = `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding\n${input.command}`;
  const p = procs.start({
    command: input.command,
    cwd,
    name: input.name,
    shellExe: all.powershell,
    shellArgs: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  });
  await procs.waitFor(p, { seconds: 5, signal: ctx.signal });
  const { text } = procs.read(p);
  ctx.progress(text);
  return { isError: false, text: `${procText(p)}\nLog file: ${p.logFile}\n--- first output ---\n${clip(text.trim() || '(nothing yet)', 8000)}` };
}

async function processOutput(input, ctx) {
  const p = procs.get(input.id);
  if (!p) return { isError: true, text: `No process with id ${input.id}. Use list_processes.` };
  let found = null;
  if (!input.tail && (input.wait_seconds || input.until_text)) found = await procs.waitFor(p, { seconds: input.wait_seconds || 60, untilText: input.until_text, signal: ctx.signal });
  const { text, skipped } = procs.read(p, { tail: input.tail });
  ctx.progress(text);
  let note = '';
  if (input.until_text) note = found ? `\n"${input.until_text}" appeared.` : `\n"${input.until_text}" did not appear (yet).`;
  return { isError: false, text: `${procText(p, note)}${skipped ? `\n(${skipped} older characters skipped, full log: ${p.logFile})` : ''}\n--- output ---\n${clip(text.trim() || '(no new output)', 20000)}` };
}

async function sendInput(input) {
  const p = procs.get(input.id);
  if (!p) return { isError: true, text: `No process with id ${input.id}. Use list_processes.` };
  if (!procs.send(p, input.text)) return { isError: true, text: `${procText(p)}; it can't take input any more.` };
  return { isError: false, text: `Typed "${input.text}" into ${p.id}. Use process_output to see the reaction.` };
}

async function stopProcess(input, ctx) {
  const p = procs.get(input.id);
  if (!p) return { isError: true, text: `No process with id ${input.id}. Use list_processes.` };
  procs.stop(p);
  await procs.waitFor(p, { seconds: 10, signal: ctx.signal });
  return { isError: false, text: procText(p) };
}

async function listProcesses() {
  const l = procs.list();
  if (!l.length) return { isError: false, text: 'No background processes started yet.' };
  return { isError: false, text: l.map((s) => `${s.id} "${s.name}" ${s.running ? `running (pid ${s.pid})` : `exited (${s.exitCode})`} - ${s.command} [${s.cwd}]`).join('\n') };
}

// ---------------------------------------------------------------- plan, notes, memory

const project = require('./project');

const STATUS = { pending: 'pending', todo: 'pending', doing: 'doing', in_progress: 'doing', active: 'doing', done: 'done', completed: 'done', complete: 'done' };

/** Normalizes update_plan input to [{ text, status }] (models send strings or odd status words). */
function planItems(input) {
  return (Array.isArray(input.items) ? input.items : [])
    .map((it) => (typeof it === 'string' ? { text: it, status: 'pending' } : { text: String(it?.text ?? it?.content ?? it?.step ?? '').trim(), status: STATUS[String(it?.status || '').toLowerCase()] || 'pending' }))
    .filter((it) => it.text)
    .slice(0, 20);
}

async function updatePlan(input) {
  const items = planItems(input);
  if (!items.length) return { isError: true, text: 'The plan is empty. Send items: [{ "text": "...", "status": "pending" | "doing" | "done" }].' };
  const left = items.filter((i) => i.status !== 'done').length;
  return { isError: false, text: `Plan shown to the user (${items.length} steps, ${left} left). ${left ? 'Carry on with the step marked doing.' : 'All steps are done.'}` };
}

const SECTIONS = { status: '## Status', done: '## Done', open: '## Open', needs_fixing: '## Needs fixing', facts: '## Facts' };

function notesFor(ctx) {
  const info = project.resolve(ctx.cwd);
  project.ensureNotes(info, ctx.cwd);
  return info.notesFile;
}

async function saveNote(input, ctx) {
  const file = notesFor(ctx);
  const text = String(input.text).replace(/\s*\r?\n\s*/g, ' ').trim();
  if (!text) return { isError: true, text: 'The note is empty.' };
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  const head = SECTIONS[input.section];
  let at = lines.findIndex((l) => l.trim().toLowerCase().startsWith(head.toLowerCase()));
  if (at < 0) {
    lines.push('', head === '## Open' ? '## Open (not done yet)' : head === '## Facts' ? '## Facts and decisions' : head);
    at = lines.length - 1;
  }
  let end = lines.findIndex((l, i) => i > at && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  // the body without the template's "(...)" hint and empty lines
  const body = lines.slice(at + 1, end).filter((l) => l.trim() && !/^\(.*\)$/.test(l.trim()));
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const next = input.section === 'status' ? [`${text} (${date})`] : [...body, `- ${date}: ${text}`];
  lines.splice(at + 1, end - at - 1, ...next, '');
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  return { isError: false, text: `Saved under ${lines[at].replace(/^##\s*/, '')} in ${file}` };
}

async function removeNote(input, ctx) {
  const file = notesFor(ctx);
  const needle = String(input.contains).trim().toLowerCase();
  if (needle.length < 3) return { isError: true, text: 'Give at least 3 characters of the entry to remove.' };
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  const gone = lines.filter((l) => /^\s*-\s/.test(l) && l.toLowerCase().includes(needle));
  if (!gone.length) return { isError: false, text: `No entry contains "${input.contains}". Nothing removed.` };
  fs.writeFileSync(file, lines.filter((l) => !gone.includes(l)).join('\r\n'), 'utf8');
  return { isError: false, text: `Removed ${gone.length} entr${gone.length === 1 ? 'y' : 'ies'}:\n${gone.join('\n')}` };
}

async function searchMemory(input) {
  const words = [...new Set(String(input.query).toLowerCase().split(/[^a-z0-9äöüß.]+/i).filter((w) => w.length >= 3))];
  if (!words.length) return { isError: true, text: 'Give at least one keyword of 3 or more letters.' };
  const files = [];
  const add = (dir, kind) => {
    try {
      for (const n of fs.readdirSync(dir)) if (n.endsWith('.md') && n !== 'MEMORY.md') files.push({ p: path.join(dir, n), kind });
    } catch {}
  };
  add(project.notesRoot(), 'your notes');
  try {
    const root = path.join(project.CLAUDE_HOME, 'projects');
    for (const d of fs.readdirSync(root)) add(path.join(root, d, 'memory'), 'Claude memory');
  } catch {}
  const hits = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f.p, 'utf8');
    } catch {
      continue;
    }
    const low = text.toLowerCase();
    const name = path.basename(f.p).toLowerCase();
    const found = words.filter((w) => low.includes(w) || name.includes(w));
    if (!found.length) continue;
    const lines = text
      .split(/\r?\n/)
      .map((l) => ({ l: l.trim(), n: words.filter((w) => l.toLowerCase().includes(w)).length }))
      .filter((x) => x.n && x.l.length > 3)
      .sort((a, b) => b.n - a.n)
      .slice(0, 4)
      .map((x) => `    ${x.l.slice(0, 260)}`);
    // file-name matches and matching more of the words rank higher; own notes break ties
    hits.push({ score: found.length * 10 + words.filter((w) => name.includes(w)).length * 5 + (f.kind === 'your notes' ? 1 : 0), text: `${f.p}  [${f.kind}]\n${lines.join('\n')}` });
  }
  if (!hits.length) return { isError: false, text: `Nothing in your notes or Claude's memory matches "${input.query}".` };
  hits.sort((a, b) => b.score - a.score);
  return { isError: false, text: clip(`${hits.length} matching note file${hits.length === 1 ? '' : 's'} (best first; read a file with read_file for the full note):\n\n${hits.slice(0, 8).map((h) => h.text).join('\n\n')}`, 9000) };
}

// ---------------------------------------------------------------- web

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/', mdash: '-', ndash: '-', hellip: '...' };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => ENT[e] ?? (/^#x/i.test(e) ? String.fromCodePoint(parseInt(e.slice(2), 16)) : /^#\d/.test(e) ? String.fromCodePoint(Number(e.slice(1))) : m));

function htmlToText(html) {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim());
  let t = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|head|nav|footer|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => `${inner} (${href})`)
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/pre|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n# ')
    .replace(/<[^>]+>/g, '');
  t = decode(t).replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text: t };
}

async function httpGet(url, ctx, accept) {
  const timer = AbortSignal.timeout(30000);
  return fetch(url, { signal: AbortSignal.any([ctx.signal, timer]), redirect: 'follow', headers: { 'user-agent': UA, accept: accept || 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5', 'accept-language': 'en,de;q=0.8' } });
}

async function webFetch(input, ctx) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input.url) ? input.url : `https://${input.url}`);
  } catch {
    return { isError: true, text: 'That is not a valid URL.' };
  }
  let res;
  try {
    res = await httpGet(url, ctx);
  } catch (e) {
    return { isError: true, text: `Couldn't fetch ${url.href}: ${e.cause?.code || e.message}. (Is the PC online?)` };
  }
  if (!res.ok) return { isError: true, text: `${url.href} answered HTTP ${res.status} ${res.statusText}.` };
  const type = res.headers.get('content-type') || '';
  if (!/text|json|xml|javascript/.test(type)) return { isError: true, text: `${url.href} is ${type || 'not text'}; use download_file to save it.` };
  const raw = (await res.text()).slice(0, 4_000_000);
  const { title, text } = /html/.test(type) ? htmlToText(raw) : { title: '', text: raw };
  const offset = Math.max(0, Number(input.offset) || 0);
  const SIZE = 12000;
  const part = text.slice(offset, offset + SIZE);
  const more = offset + SIZE < text.length ? `\n\n(${text.length} characters in total; continue with offset ${offset + SIZE})` : '';
  return { isError: false, text: `${title ? `${title}\n` : ''}${res.url}\n\n${part || '(no readable text)'}${more}` };
}

async function webSearch(input, ctx) {
  const q = String(input.query).trim();
  if (!q) return { isError: true, text: 'The search is empty.' };
  let res;
  try {
    res = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, ctx, 'text/html');
  } catch (e) {
    return { isError: true, text: `Couldn't reach the search engine: ${e.cause?.code || e.message}. (Is the PC online?)` };
  }
  if (!res.ok) return { isError: true, text: `The search engine answered HTTP ${res.status}.` };
  const html = await res.text();
  const out = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|$)/g;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    let href = decode(m[1]);
    const u = /[?&]uddg=([^&]+)/.exec(href);
    if (u) href = decodeURIComponent(u[1]);
    if (href.startsWith('//')) href = `https:${href}`;
    if (/duckduckgo\.com\/y\.js/.test(href)) continue; // ads
    const strip = (s) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const snip = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(m[3]);
    out.push(`${out.length + 1}. ${strip(m[2])}\n   ${href}${snip ? `\n   ${strip(snip[1])}` : ''}`);
  }
  if (!out.length) return { isError: false, text: /anomaly|captcha|challenge/i.test(html) ? 'The search engine asked for a bot check, so there are no results right now. Try web_fetch on a site you know instead.' : `No results for "${q}".` };
  return { isError: false, text: `Results for "${q}":\n\n${out.join('\n\n')}` };
}

const RUNNERS = {
  update_plan: updatePlan,
  save_note: saveNote,
  remove_note: removeNote,
  search_memory: searchMemory,
  web_search: webSearch,
  web_fetch: webFetch,
  run_command: runCommand,
  read_file: readFile,
  list_directory: listDirectory,
  search_files: searchFiles,
  write_file: writeFile,
  edit_file: editFile,
  download_file: downloadFile,
  start_process: startProcess,
  process_output: processOutput,
  send_input: sendInput,
  stop_process: stopProcess,
  list_processes: listProcesses,
};

function run(name, input, ctx) {
  return RUNNERS[name](input, ctx);
}

module.exports = { definitions, BUILTIN, group, category, needsApproval, validate, run, killTree, findShells, writeTarget, resolvePath, planItems };
