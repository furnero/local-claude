// One chat turn: stream the local model's answer from Ollama (Anthropic-style API), run the
// tools it asks for (after the user approves them), answer its questions with the user's
// choice, feed the results back, and repeat until it is done. Before it may finish a turn in
// which it changed or ran things, it gets one automatic "check your work" pass. The
// conversation file keeps the exact history, appended in order; what is sent is trimmed to
// the model's context window (context.js).
const Anthropic = require('@anthropic-ai/sdk');
const store = require('./store');
const config = require('./config');
const tools = require('./tools');
const mcp = require('./mcp');
const project = require('./project');
const ollama = require('./ollama');
const colibri = require('./colibri');
const context = require('./context');
const { modelInfo, modeOf, costOf, MODELS } = require('./models');

let emitter = () => {};
const active = new Map(); // convId -> run controller

const MAX_TOOL_ROUNDS = 200;
const SWITCH_LABEL = 'Switch to Smart';
const STAY_LABEL = 'Stay in Quick';
// prefix of a message the user sent while a turn was running (delivered with tool results)
const QUEUED_MARK = '[The user sent this message while you were working. Read it and take it into account; it may change what you should do next.]\n';
// prefix of the app's own "check your work" message
const CHECK_MARK = '[Automatic check]';

// Requests go through Chromium's network stack (net.fetch). Node's own fetch gives up when a
// response is silent for 5 minutes, and a slow local model can easily take longer than that
// to read a big prompt or to write one long tool call.
const clients = new Map();
/** The API client for an engine's address (Ollama by default, colibri when the mode uses it). */
function clientFor(baseURL = ollama.BASE, apiKey = 'local') {
  if (!clients.has(baseURL)) {
    clients.set(
      baseURL,
      new Anthropic({ apiKey, baseURL, maxRetries: 0, timeout: 60 * 60 * 1000, fetch: (url, init) => require('electron').net.fetch(url, init) }),
    );
  }
  return clients.get(baseURL);
}

/** Gets the mode's model ready on its engine. Only one engine holds a model at a time. */
async function prepareMode(mode, onStatus) {
  if (modelInfo(mode)?.engine === 'colibri') return colibri.prepare(onStatus, () => ollama.unloadLoaded());
  await colibri.stop().catch(() => {});
  return ollama.prepare(mode, onStatus);
}

function setEmitter(fn) {
  emitter = fn;
}

const emit = (convId, ev) => emitter(convId, ev);

// ---------------------------------------------------------------- conversation setup

function createConversation(model) {
  const now = Date.now();
  return {
    id: store.newId(),
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    model: modeOf(model || store.getSettings().model), // 'quick' | 'smart' | 'coder'
    system: '', // rebuilt at the start of every turn (holds the latest notes)
    cwd: config.workingDirectory(),
    messages: [],
    meta: {}, // message index -> { model, base, usage, ms, tps, ctx, stopped }
    attachNames: {},
    starred: false,
  };
}

// A slow engine (colibri) keeps what it has read of a chat and only reads what is new, as long as
// the beginning stays exactly the same. So in those modes the instructions are built once per chat
// (per app run) instead of every turn; notes saved meanwhile are in the chat itself anyway.
const frozenSystem = new Map(); // conversation id -> { key, system }

function refreshSystem(conv, rt) {
  const s = store.getSettings();
  const smart = !!modelInfo(conv.model)?.smart;
  const slow = !!rt.engine;
  const key = `${conv.model}|${rt.model}|${conv.cwd}`;
  const kept = slow ? frozenSystem.get(conv.id) : null;
  if (kept && kept.key === key && conv.messages.length > 1) {
    conv.system = kept.system;
    return;
  }
  conv.system = project.buildPrompt({
    model: rt.base,
    smart,
    coder: !!modelInfo(conv.model)?.coder,
    cwd: conv.cwd,
    name: s.name,
    customInstructions: s.customInstructions,
    web: !!s.webSearch,
    engine: slow ? 'the colibrì engine' : 'Ollama',
    lean: slow,
  });
  if (slow) frozenSystem.set(conv.id, { key, system: conv.system });
  else frozenSystem.delete(conv.id);
  if (!smart) {
    conv.system +=
      '\n\n# Quick mode: check the task first\n' +
      'You are the small, fast model. Before you start a task, judge whether it suits you. Quick mode is right for questions, explanations, short lookups, one small file edit, or one or two commands. ' +
      'If the task needs many steps, debugging, changes across several files, setting up or running servers, or anything where a mistake would be costly, call suggest_smart_mode first with a one-line reason and wait for the answer. ' +
      'If the user stays in Quick mode, do the task as well as you can.';
  }
}

// ---------------------------------------------------------------- request

// Tools the app answers itself (no process runs): questions to the user.
function askDefinitions(smart) {
  const defs = [
    {
      name: 'ask_user',
      description:
        'Asks the user a question and waits for the answer. Use it when you need a decision only the user can make (which option, whether to go ahead with something risky, accepting a license such as the Minecraft EULA), or when the request is unclear. ' +
        'Give 2-4 short options; the user can also type their own answer. The answer comes back as the tool result.',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question, one or two sentences.' },
          options: { type: 'array', items: { type: 'string' }, description: '2-4 short answer options.' },
        },
        required: ['question'],
      },
    },
  ];
  if (!smart) {
    defs.push({
      name: 'suggest_smart_mode',
      description:
        'Recommends switching this chat to Smart mode (the bigger model with a careful plan-and-verify method) and waits for the user to decide. Use it before starting a task that is too complex for Quick mode.',
      input_schema: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'One line: why this task needs Smart mode.' } },
        required: ['reason'],
      },
    });
  }
  return defs;
}

const ASK_TOOLS = new Set(['ask_user', 'suggest_smart_mode']);
// tools that are meant to be called again with the same input
const REPEATABLE = new Set(['process_output', 'list_processes', 'update_plan', 'run_command', 'list_directory']);

function toolList(conv, opts) {
  const s = store.getSettings();
  return [...tools.definitions({ computer: !!opts.computer, web: !!opts.webSearch }), ...mcp.definitions(s.mcpOff), ...askDefinitions(!!modelInfo(conv.model)?.smart)];
}

function buildParams(conv, opts, rt) {
  // a slow engine writes about a token a second: a smaller answer limit leaves more of its context for the chat
  const maxTokens = Math.max(1024, Math.min(rt.engine ? 3072 : 16384, Math.floor(rt.ctx / 3)));
  const params = { model: rt.model, max_tokens: maxTokens, system: conv.system };
  if (rt.caps.includes('tools')) {
    const t = toolList(conv, opts);
    if (t.length) params.tools = t;
  }
  if (rt.caps.includes('thinking')) params.thinking = opts.effort === 'off' ? { type: 'disabled' } : { type: 'enabled', budget_tokens: Math.min(8192, Math.floor(maxTokens / 2)) };
  const fitted = context.fit(conv.messages, { ctx: rt.ctx, system: conv.system, tools: params.tools, maxTokens });
  params.messages = fitted.messages;
  return { params, fitted };
}

// response blocks -> plain JSON we can send back as is
function plain(content) {
  return JSON.parse(JSON.stringify(content)).map((b) => {
    delete b.parsed_output;
    return b;
  });
}

// A conversation must never end in tool_use blocks without results (a crash or a stop in the
// middle of a tool round): answer them before the next request.
function repair(conv) {
  const last = conv.messages[conv.messages.length - 1];
  if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) return;
  const pending = last.content.filter((b) => b.type === 'tool_use');
  if (!pending.length) return;
  conv.messages.push({
    role: 'user',
    content: pending.map((b) => ({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: 'The tool call was interrupted before it ran.' })),
  });
}

// ---------------------------------------------------------------- the turn

function friendlyError(e) {
  if (/^terminated$|network error|ERR_(CONNECTION|EMPTY|INCOMPLETE)/i.test(String(e?.message || '')) || /terminated/i.test(String(e?.cause?.message || ''))) {
    return { message: 'The connection to Ollama was cut off in the middle of the answer (it may have run out of memory or been restarted). Press Retry; what was done so far is kept.', kind: 'network' };
  }
  if (e instanceof Anthropic.APIConnectionError) return { message: "Couldn't reach the local model server on this PC (Ollama, or colibrì for Coder 30B). Is it installed and running?", kind: 'network' };
  if (e instanceof Anthropic.NotFoundError) return { message: `Ollama doesn't know this model: ${e.error?.error?.message || e.message}. Check Settings → Local models.`, kind: 'api' };
  if (e instanceof Anthropic.APIError) return { message: `Ollama answered with an error ${e.status ?? ''}: ${e.error?.error?.message || e.message}`, kind: 'api' };
  return { message: String(e?.message || e), kind: e?.kind || 'other' };
}

function selfCheckOn(conv) {
  const mode = store.getSettings().selfCheck || 'smart';
  return mode === 'always' || (mode === 'smart' && !!modelInfo(conv.model)?.smart);
}

function checkPrompt(smart) {
  return (
    `${CHECK_MARK} Before you finish, check your work. Read again what the user asked for. ` +
    'For each thing you changed or started in this turn, make one cheap tool call that proves the real result: read the changed lines back, run the test that covers it, or read the process output. Skip what a tool result in this turn already proved. ' +
    'Do not rely on what you intended to do. If something is wrong or missing, fix it now and check again. ' +
    (smart ? 'Then save what matters with save_note (done, open, needs_fixing, facts). ' : '') +
    'Then answer in at most three plain lines: what changed, how it was checked, what is open. No headings, no lists, no emoji.'
  );
}

async function runTurn(conv, opts) {
  if (active.has(conv.id)) throw new Error('This chat is still answering.');
  const ctrl = { abort: new AbortController(), procs: new Set(), approvals: new Map(), stream: null, inbox: [], worked: false, rt: null, seen: new Map() };
  active.set(conv.id, ctrl);
  const signal = ctrl.abort.signal;
  emit(conv.id, { type: 'turn_start' });

  let rounds = 0;
  let badJson = 0;
  let stopped = false;
  let error = null;
  let checked = false;
  let toldTrimmed = false;
  conv.model = modeOf(conv.model);
  repair(conv);
  try {
    ctrl.rt = await prepareMode(conv.model, (text) => emit(conv.id, { type: 'status', text }));
    const known = frozenSystem.has(conv.id);
    refreshSystem(conv, ctrl.rt);
    if (ctrl.rt.engine && !known) emit(conv.id, { type: 'status', text: 'This mode reads the whole chat before its first word: the first answer takes about 10 minutes, later ones start within seconds.' });
    for (;;) {
      if (signal.aborted) {
        stopped = true;
        break;
      }
      const rt = ctrl.rt;
      const { params, fitted } = buildParams(conv, opts, rt);
      if (fitted.trimmed && !toldTrimmed) {
        toldTrimmed = true;
        emit(conv.id, { type: 'context_trimmed' });
      }
      const msgIndex = conv.messages.length;
      const started = Date.now();
      let firstToken = 0;
      emit(conv.id, { type: 'msg_start', msgIndex, model: conv.model });
      let final;
      try {
        const stream = clientFor(rt.baseURL, rt.apiKey).messages.stream(params, { signal });
        ctrl.stream = stream;
        for await (const ev of stream) {
          if (ev.type === 'content_block_start') emit(conv.id, { type: 'block_start', msgIndex, index: ev.index, block: ev.content_block });
          else if (ev.type === 'content_block_delta') {
            if (!firstToken) firstToken = Date.now();
            emit(conv.id, { type: 'block_delta', msgIndex, index: ev.index, delta: ev.delta });
          } else if (ev.type === 'content_block_stop') emit(conv.id, { type: 'block_stop', msgIndex, index: ev.index });
        }
        final = await stream.finalMessage();
      } catch (e) {
        if (signal.aborted || e instanceof Anthropic.APIUserAbortError) {
          stopped = true;
          const partial = ctrl.stream?.currentMessage;
          const keep = (partial?.content || []).filter((b) => b.type === 'text' && b.text);
          if (keep.length) {
            conv.messages.push({ role: 'assistant', content: plain(keep).map((b) => ({ type: 'text', text: b.text })) });
            conv.meta[msgIndex] = { model: conv.model, base: rt.base, stopped: true, ms: Date.now() - started };
          }
          emit(conv.id, { type: 'msg_aborted', msgIndex, kept: keep.length > 0 });
          break;
        }
        // the model wrote tool input that isn't JSON: ask again (a couple of times)
        if (!(e instanceof Anthropic.APIError) && /JSON/i.test(e.message || '') && badJson < 2) {
          badJson++;
          emit(conv.id, { type: 'msg_retry', msgIndex });
          continue;
        }
        // a model that turns out not to support thinking or tools: drop the feature and retry
        const msg = String(e.error?.error?.message || e.message || '');
        const lacks = /does not support (thinking|tools)/i.exec(msg)?.[1]?.toLowerCase();
        if (e instanceof Anthropic.APIError && lacks && rt.caps.includes(lacks)) {
          rt.caps = rt.caps.filter((c) => c !== lacks);
          emit(conv.id, { type: 'msg_retry', msgIndex });
          continue;
        }
        throw e;
      }

      const content = plain(final.content);
      // an empty answer would make the next request invalid
      if (!content.length) content.push({ type: 'text', text: '(no answer)' });
      conv.messages.push({ role: 'assistant', content });
      const done = Date.now();
      const out = final.usage?.output_tokens || 0;
      const genMs = firstToken ? done - firstToken : 0;
      conv.meta[msgIndex] = {
        model: conv.model,
        base: rt.base,
        usage: final.usage,
        cost: 0,
        ms: done - started,
        firstMs: firstToken ? firstToken - started : null,
        tps: genMs > 300 && out ? Math.round((out / genMs) * 10000) / 10 : null,
        ctx: rt.ctx,
        stop: final.stop_reason,
      };
      conv.updatedAt = Date.now();
      store.addUsage(conv.model, final.usage || {}, costOf());
      store.saveConversation(conv);
      emit(conv.id, { type: 'msg_done', msgIndex, content, meta: conv.meta[msgIndex], stopReason: final.stop_reason, stopDetails: null });

      const uses = content.filter((b) => b.type === 'tool_use');
      if (uses.length) {
        if (++rounds > MAX_TOOL_ROUNDS) {
          repair(conv);
          store.saveConversation(conv);
          error = { message: `Stopped after ${MAX_TOOL_ROUNDS} tool rounds in one turn.`, kind: 'other' };
          break;
        }
        const results = await runTools(conv, uses, final.stop_reason === 'max_tokens', ctrl, opts);
        const resultIndex = conv.messages.length;
        // messages the user sent meanwhile ride along with the tool results
        const delivered = ctrl.inbox.splice(0);
        for (const c of delivered) results.push(...queuedBlocks(c));
        if (delivered.length) checked = false; // new instructions: the work gets checked again
        conv.messages.push({ role: 'user', content: results });
        store.saveConversation(conv);
        emit(conv.id, { type: 'tool_results_saved', msgIndex: resultIndex });
        if (delivered.length) emit(conv.id, { type: 'inbox_delivered', msgIndex: resultIndex, count: delivered.length });
        if (signal.aborted) {
          stopped = true;
          break;
        }
        continue;
      }
      // The model wants to finish. If it changed or ran things, it checks its work first (once).
      if (ctrl.worked && !checked && !ctrl.inbox.length && final.stop_reason !== 'max_tokens' && selfCheckOn(conv)) {
        checked = true;
        const checkIndex = conv.messages.length;
        conv.messages.push({ role: 'user', content: [{ type: 'text', text: checkPrompt(!!modelInfo(conv.model)?.smart) }] });
        store.saveConversation(conv);
        emit(conv.id, { type: 'self_check', msgIndex: checkIndex });
        continue;
      }
      break;
    }
  } catch (e) {
    error = friendlyError(e);
  } finally {
    for (const p of ctrl.procs) tools.killTree(p);
    for (const resolve of ctrl.approvals.values()) resolve('deny');
    active.delete(conv.id);
    conv.updatedAt = Date.now();
    // how long the model stays in memory now is the user's setting (0 = free the memory at once)
    if (!ctrl.inbox.length && !ctrl.rt?.engine) ollama.release(ctrl.rt?.model);
    // messages queued after the last tool round become the next turn
    const left = ctrl.inbox.splice(0);
    let nextIndex = -1;
    if (left.length) {
      repair(conv);
      nextIndex = conv.messages.length;
      conv.messages.push({ role: 'user', content: left.flat() });
    }
    store.saveConversation(conv);
    emit(conv.id, { type: 'turn_end', stopped, error });
    if (left.length) {
      emit(conv.id, { type: 'queued_started', msgIndex: nextIndex, content: conv.messages[nextIndex].content });
      setImmediate(() => runTurn(conv, opts).catch((e) => emit(conv.id, { type: 'turn_end', error: { message: String(e.message || e), kind: 'other' } })));
    }
  }
  if (!error && conv.title === 'New chat') makeTitle(conv);
}

// A queued message as blocks for a tool-result message: its text gets the "sent while you
// were working" mark (images and documents go along unchanged).
function queuedBlocks(content) {
  const blocks = (Array.isArray(content) ? content : [{ type: 'text', text: String(content) }]).map((b) => ({ ...b }));
  const t = blocks.find((b) => b.type === 'text');
  if (t) t.text = QUEUED_MARK + t.text;
  else blocks.push({ type: 'text', text: QUEUED_MARK.trim() });
  return blocks;
}

/** Queues a message for a chat that is still answering. False when nothing is running. */
function enqueue(convId, content) {
  const ctrl = active.get(convId);
  if (!ctrl) return false;
  ctrl.inbox.push(content);
  return true;
}

// Waits for the user's click on an approval or question card.
function waitFor(ctrl, id, ev, convId) {
  return new Promise((resolve) => {
    ctrl.approvals.set(id, resolve);
    emit(convId, ev);
  }).finally(() => ctrl.approvals.delete(id));
}

async function askTool(conv, use, ctrl) {
  const id = use.id;
  if (use.name === 'suggest_smart_mode') {
    const answer = await waitFor(ctrl, id, { type: 'question', toolUseId: id, kind: 'smart', question: `This looks like a job for Smart mode: ${use.input.reason || 'the task is complex.'}`, options: [SWITCH_LABEL, STAY_LABEL] }, conv.id);
    if (answer === 'deny') return { isError: true, denied: true, text: 'The user stopped the turn before answering.' };
    if (answer === SWITCH_LABEL) {
      try {
        const rt = await prepareMode('smart', (text) => emit(conv.id, { type: 'status', text }));
        conv.model = 'smart';
        ctrl.rt = rt;
        refreshSystem(conv, rt);
        store.saveConversation(conv);
        emit(conv.id, { type: 'model_switched', model: conv.model });
        return { text: 'The user switched this chat to Smart mode. You are now the bigger model: follow the careful working method from your instructions and do the task.' };
      } catch (e) {
        return { isError: true, text: `Switching to Smart mode failed: ${e.message} Staying in Quick mode; do the task as well as you can.` };
      }
    }
    return { text: `The user chose to stay in Quick mode${answer && answer !== STAY_LABEL ? ` and said: ${answer}` : ''}. Do the task as well as you can.` };
  }
  const options = Array.isArray(use.input.options) ? use.input.options.map(String).filter(Boolean).slice(0, 4) : [];
  const answer = await waitFor(ctrl, id, { type: 'question', toolUseId: id, kind: 'ask', question: String(use.input.question || ''), options }, conv.id);
  if (answer === 'deny') return { isError: true, denied: true, text: 'The user stopped the turn before answering.' };
  return { text: `The user answered: ${answer}` };
}

async function runTools(conv, uses, truncated, ctrl, opts) {
  const results = [];
  const s = store.getSettings();
  for (const use of uses) {
    const id = use.id;
    const done = (r) => {
      const block = { type: 'tool_result', tool_use_id: id, content: r.content || r.text || '(no output)' };
      if (r.isError) block.is_error = true;
      results.push(block);
      emit(conv.id, { type: 'tool_result', toolUseId: id, isError: !!r.isError, text: r.text || '', exitCode: r.exitCode, denied: !!r.denied, images: (r.content || []).filter((c) => c.type === 'image').length });
    };
    if (ctrl.abort.signal.aborted) {
      done({ isError: true, text: 'The user stopped the turn before this tool ran.', denied: true });
      continue;
    }
    if (truncated) {
      done({ isError: true, text: 'Your response hit the output limit while writing this tool call, so its input was cut off. Try again with smaller steps (for example, write a big file in parts).' });
      continue;
    }
    if (ASK_TOOLS.has(use.name)) {
      if (!use.input || typeof use.input !== 'object') {
        done({ isError: true, text: 'Invalid input.' });
        continue;
      }
      done(await askTool(conv, use, ctrl));
      continue;
    }
    const builtin = tools.BUILTIN.has(use.name);
    const mcpHit = builtin ? null : mcp.lookup(use.name);
    // a small model that loses the thread repeats itself: stop the third identical call
    if (!REPEATABLE.has(use.name)) {
      const key = `${use.name} ${JSON.stringify(use.input)}`;
      const n = (ctrl.seen.get(key) || 0) + 1;
      ctrl.seen.set(key, n);
      if (n >= 3) {
        done({ isError: true, text: `You already made exactly this ${use.name} call ${n - 1} times in this turn and got the result each time. Repeating it will not help. Use what you already know and take the next step, or ask the user with ask_user if you are stuck.` });
        continue;
      }
    }
    if (builtin && tools.group(use.name) === 'computer' && !opts.computer) {
      done({ isError: true, text: 'Computer access is switched off for this message.' });
      continue;
    }
    if (builtin && tools.group(use.name) === 'web' && !opts.webSearch) {
      done({ isError: true, text: 'Web access is switched off for this message.' });
      continue;
    }
    if (!builtin && !mcpHit) {
      done({ isError: true, text: `The tool ${use.name} is not available.` });
      continue;
    }
    let ownNotes = false;
    if (builtin) {
      const problem = tools.validate(use.name, use.input);
      if (problem) {
        done({ isError: true, text: `Invalid input: ${problem}` });
        continue;
      }
      // Claude's memory is read-only; the model's own notes need no approval.
      const target = tools.writeTarget(use.name, use.input, conv.cwd);
      if (target && project.isInside(target, project.CLAUDE_HOME)) {
        done({ isError: true, text: `Writing under ${project.CLAUDE_HOME} is blocked: Claude's memory is read-only. Put notes in your own notes file (save_note).` });
        continue;
      }
      ownNotes = !!target && (use.name === 'write_file' || use.name === 'edit_file') && project.isInside(target, project.notesRoot());
    }
    const allowed = ownNotes || s.toolPermissions[use.name] === 'allow' || (builtin ? !tools.needsApproval(use.name) : mcp.autoApproved(use.name));
    if (!allowed) {
      const decision = await waitFor(ctrl, id, { type: 'approval', toolUseId: id, name: use.name, input: use.input, server: mcpHit?.server || null, cwd: conv.cwd }, conv.id);
      if (decision === 'always') store.saveSettings({ toolPermissions: { ...store.getSettings().toolPermissions, [use.name]: 'allow' } });
      if (decision !== 'once' && decision !== 'always') {
        done({ isError: true, denied: true, text: ctrl.abort.signal.aborted ? 'The user stopped the turn before this tool ran.' : 'The user declined this tool call. Ask them how they want to proceed, or try another way.' });
        continue;
      }
    }
    emit(conv.id, { type: 'tool_running', toolUseId: id });
    let pending = '';
    let flushTimer = null;
    const ctx = {
      vision: !!ctrl.rt?.caps.includes('vision'),
      cwd: conv.cwd,
      signal: ctrl.abort.signal,
      track: (p) => ctrl.procs.add(p),
      untrack: (p) => ctrl.procs.delete(p),
      progress: (text) => {
        pending += text;
        if (!flushTimer)
          flushTimer = setTimeout(() => {
            emit(conv.id, { type: 'tool_progress', toolUseId: id, text: pending });
            pending = '';
            flushTimer = null;
          }, 60);
      },
    };
    let r;
    try {
      r = builtin ? await tools.run(use.name, use.input, ctx) : await mcp.call(use.name, use.input, ctrl.abort.signal);
    } catch (e) {
      r = { isError: true, text: `The tool failed: ${e.message || e}` };
    }
    clearTimeout(flushTimer);
    if (pending) emit(conv.id, { type: 'tool_progress', toolUseId: id, text: pending });
    // work that changes the PC must be checked before the turn may end
    if (!ownNotes && (!builtin || ['shell', 'write'].includes(tools.category(use.name)))) ctrl.worked = true;
    done(r);
  }
  return results;
}

// ---------------------------------------------------------------- titles

// From the first message, not from the model: a second model call would push the bigger
// model out of the GPU's memory and make the next answer slow.
/** A chat title from the user's first message: its first sentence without filler, 7 words at most. */
function titleFor(content) {
  const text = (Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  let title = text.split(/(?<=[.?!:])\s/)[0];
  // drop openers that say nothing about the topic
  for (let i = 0; i < 3; i++) title = title.replace(/^(hey|hi|hello|ok|okay|so|please|pls|also|and|now|can you|could you|would you|will you|i want you to|i need you to|i want to|i need to|i'd like you to|help me( to)?|kannst du|bitte|hallo)\b[\s,]*/i, '');
  if (title.trim().split(' ').length < 2) title = text.split(/(?<=[.?!:])\s/)[0]; // "hello there" stays as it is
  const words = title.split(' ');
  if (words.length > 7) title = `${words.slice(0, 7).join(' ')}…`;
  title = title.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[.?!:,;]+$/, '').slice(0, 64);
  return title ? title[0].toUpperCase() + title.slice(1) : '';
}

// For chats that are still called "New chat" when a turn ends (older chats).
function makeTitle(conv) {
  const firstUser = conv.messages.find((m) => m.role === 'user');
  const title = titleFor(firstUser?.content);
  if (!title) return;
  const latest = store.getConversation(conv.id);
  if (!latest || latest.title !== 'New chat') return;
  latest.title = title;
  conv.title = title;
  store.saveConversation(latest);
  emit(conv.id, { type: 'title', title });
}

// ---------------------------------------------------------------- controls

function stop(convId) {
  const ctrl = active.get(convId);
  if (!ctrl) return false;
  ctrl.abort.abort();
  try {
    ctrl.stream?.abort();
  } catch {}
  for (const p of ctrl.procs) tools.killTree(p);
  for (const resolve of ctrl.approvals.values()) resolve('deny');
  return true;
}

/** Approval decision ('once' | 'always' | 'deny') or the answer to a question. */
function approve(convId, toolUseId, decision) {
  const resolve = active.get(convId)?.approvals.get(toolUseId);
  if (resolve) resolve(decision);
  return !!resolve;
}

const isActive = (convId) => active.has(convId);
const activeIds = () => [...active.keys()];

module.exports = { titleFor, setEmitter, createConversation, runTurn, stop, approve, enqueue, isActive, activeIds, MODELS, QUEUED_MARK, CHECK_MARK };
