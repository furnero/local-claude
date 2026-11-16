// Background processes the model starts (game servers, dev servers, watchers). Unlike
// run_command they keep running after the tool call and across turns; their output is kept
// in a ring buffer and a log file, and stdin stays open so the model can type into a server
// console (for example "stop" for a Minecraft server). All are killed when the app quits.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_BUFFER = 400000;
const procs = new Map(); // id -> entry
let nextId = 1;
let logDir = null;
let killTree = () => {};
let onChange = () => {};

function init({ dir, kill, changed }) {
  logDir = dir;
  killTree = kill;
  onChange = changed || onChange;
  fs.mkdirSync(logDir, { recursive: true });
}

function summary(p) {
  return {
    id: p.id,
    name: p.name,
    command: p.command,
    cwd: p.cwd,
    pid: p.child.pid,
    running: p.exitCode === null,
    exitCode: p.exitCode,
    startedAt: p.startedAt,
    logFile: p.logFile,
  };
}

function start({ command, cwd, name, shellExe, shellArgs }) {
  const id = `p${nextId++}`;
  const logFile = path.join(logDir, `${id}-${Date.now()}.log`);
  const log = fs.createWriteStream(logFile);
  const child = spawn(shellExe, shellArgs, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  const p = { id, name: name || command.split(/\s+/).slice(0, 3).join(' '), command, cwd, child, logFile, buffer: '', total: 0, readPos: 0, exitCode: null, startedAt: Date.now(), waiters: new Set() };
  const push = (chunk) => {
    const s = chunk.toString('utf8');
    log.write(s);
    p.buffer += s;
    p.total += s.length;
    if (p.buffer.length > MAX_BUFFER) p.buffer = p.buffer.slice(-MAX_BUFFER);
    for (const w of p.waiters) w();
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (e) => push(Buffer.from(`\n[could not start: ${e.message}]\n`)));
  child.on('close', (code) => {
    p.exitCode = code ?? -1;
    log.end(`\n[process exited with code ${p.exitCode}]\n`);
    for (const w of p.waiters) w();
    onChange();
  });
  procs.set(id, p);
  onChange();
  return p;
}

const get = (id) => procs.get(String(id));

/** Text written since the last read (or the tail when `tail` is set). */
function read(p, { tail } = {}) {
  const startOfBuffer = p.total - p.buffer.length;
  let from = tail ? Math.max(startOfBuffer, p.total - tail) : Math.max(p.readPos, startOfBuffer);
  const skipped = !tail && p.readPos < startOfBuffer ? startOfBuffer - p.readPos : 0;
  const text = p.buffer.slice(from - startOfBuffer);
  p.readPos = p.total;
  return { text, skipped };
}

/**
 * Waits until `untilText` shows up in the output, the process exits, or the time runs out.
 * The text counts even if it was printed (and read) before this call: "has the server
 * started?" must not hang because start_process already showed the "Done" line.
 * Without `untilText` it collects output for the whole time (or until the process exits).
 */
function waitFor(p, { seconds, untilText, signal }) {
  const deadline = Date.now() + Math.min(Math.max(seconds || 0, 0), 600) * 1000;
  return new Promise((resolve) => {
    const check = () => {
      const hit = !!untilText && p.buffer.includes(untilText);
      if (hit || p.exitCode !== null || Date.now() >= deadline || signal?.aborted) {
        p.waiters.delete(check);
        clearTimeout(timer);
        resolve(untilText ? hit : null);
        return true;
      }
      return false;
    };
    const timer = setTimeout(check, Math.max(0, deadline - Date.now()) + 10);
    if (!check()) p.waiters.add(check);
  });
}

function send(p, text) {
  if (p.exitCode !== null) return false;
  p.child.stdin.write(`${text}\r\n`);
  return true;
}

function stop(p) {
  if (p.exitCode === null) killTree(p.child);
}

function list() {
  return [...procs.values()].map(summary);
}

function stopAll() {
  for (const p of procs.values()) stop(p);
}

module.exports = { init, start, get, read, waitFor, send, stop, list, stopAll, summary };
