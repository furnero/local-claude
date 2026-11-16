// Renders a conversation: user bubbles, Claude's answers (smoothly revealed while streaming),
// thinking steps, web searches, and tool cards with approval prompts. The same views draw saved
// history and live events, so a chat looks the same after a restart.
import { icon, spark } from './icons.js';
import { renderMarkdown, esc } from './markdown.js';
import { h, copyText, lightbox, fmtCost, fmtTokens } from './ui.js';

// a user message that isn't tool results (those may also carry messages queued mid-turn)
const CHECK_MARK = '[Automatic check]';
export const isAutoCheck = (m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'text' && m.content[0].text.startsWith(CHECK_MARK);
export const isRealUser = (m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')) && !isAutoCheck(m);
const QUEUED_PREFIX = '[The user sent this message while you were working.';
const queuedText = (b) => (b.type === 'text' && b.text.startsWith(QUEUED_PREFIX) ? b.text.slice(b.text.indexOf(']\n') + 2) : null);

const SHELLS = { powershell: 'PowerShell', pwsh: 'PowerShell 7', cmd: 'Command Prompt', bash: 'Bash' };
const raf = (fn) => requestAnimationFrame(fn);
const keepThinkingOpen = () => document.documentElement.dataset.thinkOpen === '1';
const ASK_TOOLS = new Set(['ask_user', 'suggest_smart_mode']);
const PLAN_STATUS = { pending: 'pending', todo: 'pending', doing: 'doing', in_progress: 'doing', active: 'doing', done: 'done', completed: 'done', complete: 'done' };
const planItems = (input) =>
  (Array.isArray(input?.items) ? input.items : [])
    .map((it) => (typeof it === 'string' ? { text: it, status: 'pending' } : { text: String(it?.text ?? it?.content ?? it?.step ?? '').trim(), status: PLAN_STATUS[String(it?.status || '').toLowerCase()] || 'pending' }))
    .filter((it) => it.text);

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
}

function plainSnippet(text) {
  // the latest heading-like line of a thinking summary, shown next to "Thinking"
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(?:#+\s*|\*\*)(.+?)(?:\*\*)?$/.exec(lines[i]);
    if (m) return m[1].replace(/\*\*/g, '').slice(0, 80);
  }
  return '';
}

function partialJsonString(buf, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`).exec(buf);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1].replace(/\\$/, '')}"`);
  } catch {
    return m[1];
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

// ---------------------------------------------------------------- text

class TextView {
  constructor(container, live) {
    this.el = h('div', { class: `md block${live ? ' streaming' : ''}` });
    this.cites = h('div', { class: 'cites' });
    this.cites.hidden = true;
    container.append(this.el, this.cites);
    this.live = live;
    this.target = '';
    this.shown = 0;
    this.final = !live;
    this.citations = [];
    this.lastRender = 0;
    this.running = false;
  }
  append(t) {
    this.target += t;
    this.kick();
  }
  setFinal(text, citations) {
    if (text != null) this.target = text;
    if (citations) this.citations = citations;
    this.final = true;
    if (!this.live) {
      this.shown = this.target.length;
      this.paint();
      this.done();
    } else this.kick();
  }
  addCitation(c) {
    this.citations.push(c);
  }
  stopNow() {
    this.final = true;
    this.shown = this.target.length;
    this.paint();
    this.done();
  }
  kick() {
    // a hidden window gets no animation frames: show everything at once instead of stalling
    if (document.hidden) {
      this.shown = this.target.length;
      this.paint();
      if (this.final) this.done();
      return;
    }
    if (this.running) return;
    this.running = true;
    raf(() => this.frame());
  }
  frame() {
    const backlog = this.target.length - this.shown;
    if (backlog > 0) {
      // reveal faster the further behind we are, so the text glides instead of jumping
      let step = Math.max(2, Math.ceil(backlog / 9));
      let next = Math.min(this.target.length, this.shown + step);
      const code = this.target.charCodeAt(next - 1);
      if (code >= 0xd800 && code <= 0xdbff) next++;
      this.shown = next;
      const now = performance.now();
      const heavy = this.target.length > 6000;
      if (!heavy || now - this.lastRender > 60 || this.shown >= this.target.length) {
        this.paint();
        this.lastRender = now;
      }
    }
    if (this.shown < this.target.length) raf(() => this.frame());
    else {
      this.running = false;
      if (this.final) this.done();
      else this.paint();
    }
  }
  paint() {
    this.el.innerHTML = renderMarkdown(this.target.slice(0, this.shown));
  }
  done() {
    this.el.classList.remove('streaming');
    if (this.shown !== this.target.length) {
      this.shown = this.target.length;
      this.paint();
    }
    this.renderCites();
  }
  renderCites() {
    const seen = new Map();
    for (const c of this.citations) {
      const url = c.url || '';
      if (url && !seen.has(url)) seen.set(url, c.title || domainOf(url));
    }
    this.cites.innerHTML = '';
    for (const [url, title] of seen) {
      this.cites.append(h('a', { class: 'cite', href: url, target: '_blank', title: `${title}\n${url}`, text: domainOf(url) }));
    }
    this.cites.hidden = !seen.size;
  }
  get text() {
    return this.target;
  }
}

// ---------------------------------------------------------------- thinking

class ThinkingView {
  constructor(container, live, redacted = false) {
    this.text = '';
    this.live = live;
    this.started = Date.now();
    this.el = h('div', { class: 'step thinking' });
    this.head = h('button', { class: 'step-head' });
    this.body = h('div', { class: 'thinking-text md' });
    this.el.append(this.head, h('div', { class: 'collapse' }, h('div', { class: 'inner' }, this.body)));
    this.head.onclick = () => {
      this.userToggled = true;
      this.el.classList.toggle('open');
    };
    container.append(this.el);
    this.redacted = redacted;
    this.timer = null;
    this.label(live ? 'Thinking' : redacted ? 'Thought process (hidden)' : 'Thought process', live);
    // the reasoning is shown as it streams; afterwards it stays open if the setting says so
    if (live || keepThinkingOpen()) this.el.classList.add('open');
    if (live) this.timer = setInterval(() => this.tick(), 1000);
  }
  label(text, shimmer) {
    this.head.innerHTML = `${icon('chevronRight', 14, 'chev')}<span class="lbl${shimmer ? ' shimmer' : ''}">${esc(text)}</span>`;
  }
  tick() {
    const s = Math.round((Date.now() - this.started) / 1000);
    const snip = plainSnippet(this.text);
    this.label(snip ? snip : `Thinking${s >= 2 ? ` · ${s}s` : ''}`, true);
  }
  append(t) {
    this.text += t;
    if (!this.painting) {
      this.painting = true;
      setTimeout(() => {
        this.painting = false;
        if (this.finished) return;
        this.paint();
        this.tick();
      }, 120);
    }
  }
  paint() {
    // summaries put headings and sentences on single lines; keep those breaks
    const atEnd = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 40;
    this.body.innerHTML = this.text.trim() ? renderMarkdown(this.text.replace(/([^\n])\n(?!\n)/g, '$1\n\n')) : '<span>No reasoning for this step.</span>';
    this.body.classList.toggle('empty', !this.text.trim());
    // follow the reasoning as it streams, unless the user scrolled up inside it
    if (!this.finished && atEnd) this.body.scrollTop = this.body.scrollHeight;
  }
  finish(text) {
    if (text != null) this.text = text;
    if (this.finished && text == null) return;
    const first = !this.finished;
    this.finished = true;
    clearInterval(this.timer);
    this.paint();
    if (this.live) {
      if (first) this.took = Math.max(1, Math.round((Date.now() - this.started) / 1000));
      const s = this.took;
      this.label(`Thought for ${s} second${s === 1 ? '' : 's'}`, false);
      if (first && !this.userToggled && !keepThinkingOpen()) setTimeout(() => !this.userToggled && this.el.classList.remove('open'), 600);
    } else {
      this.label(this.redacted ? 'Thought process (hidden)' : 'Thought process', false);
    }
  }
}

// ---------------------------------------------------------------- server tools (web search etc.)

class ServerStepView {
  constructor(container, block, live) {
    this.block = block;
    this.name = block.name;
    this.json = '';
    this.input = block.input && Object.keys(block.input).length ? block.input : null;
    this.el = h('div', { class: 'step' });
    this.head = h('button', { class: 'step-head' });
    this.body = h('div', { class: 'inner' });
    this.el.append(this.head, h('div', { class: 'collapse' }, this.body));
    this.head.onclick = () => this.el.classList.toggle('open');
    container.append(this.el);
    this.state = live ? 'running' : 'done';
    this.update();
  }
  appendJson(p) {
    this.json += p;
    if (!this.input) {
      const q = partialJsonString(this.json, 'query') || partialJsonString(this.json, 'url');
      if (q) {
        this.preview = q;
        this.update();
      }
    }
  }
  stopInput() {
    try {
      if (this.json) this.input = JSON.parse(this.json);
    } catch {}
    this.update();
  }
  what() {
    const q = this.input?.query || this.preview;
    const url = this.input?.url || this.preview;
    if (this.name === 'web_search') return { icon: 'globe', running: q ? `Searching the web · ${q}` : 'Searching the web', done: q ? `Searched · ${q}` : 'Searched the web' };
    if (this.name === 'web_fetch') return { icon: 'globe', running: url ? `Reading ${domainOf(url)}` : 'Reading a page', done: url ? `Read ${domainOf(url)}` : 'Read a page' };
    return { icon: 'code', running: 'Running code', done: 'Ran code' };
  }
  update() {
    const w = this.what();
    const text = this.err ? this.err : this.state === 'running' ? w.running : this.count != null ? `${w.done} · ${this.count} result${this.count === 1 ? '' : 's'}` : w.done;
    const lead = this.state === 'running' ? '<span class="spinner"></span>' : icon(w.icon, 15);
    this.head.innerHTML = `${lead}<span class="lbl${this.state === 'running' ? ' shimmer' : ''}">${esc(text)}</span>${icon('chevronRight', 14, 'chev')}`;
  }
  setResult(block) {
    this.state = 'done';
    const c = block.content;
    this.body.innerHTML = '';
    if (block.type === 'web_search_tool_result') {
      if (Array.isArray(c)) {
        this.count = c.length;
        const list = h('div', { class: 'sources' });
        for (const r of c) {
          const d = domainOf(r.url);
          list.append(h('a', { class: 'source', href: r.url, target: '_blank', title: r.url }, h('span', { class: 'fav', text: d.slice(0, 1) }), h('span', { class: 'st', text: r.title || r.url }), h('span', { class: 'sd', text: d })));
        }
        this.body.append(list);
      } else this.err = `Search failed (${c?.error_code || 'error'})`;
    } else if (block.type === 'web_fetch_tool_result') {
      if (c?.type === 'web_fetch_result') {
        const title = c.content?.title || c.url;
        this.body.append(h('div', { class: 'sources' }, h('a', { class: 'source', href: c.url, target: '_blank' }, h('span', { class: 'fav', text: domainOf(c.url).slice(0, 1) }), h('span', { class: 'st', text: title }), h('span', { class: 'sd', text: domainOf(c.url) }))));
      } else this.err = `Couldn't read the page (${c?.error_code || 'error'})`;
    } else {
      const out = c?.stdout ?? c?.content ?? c;
      const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
      if (this.input) this.body.append(h('pre', { class: 'tool-pre', text: typeof this.input === 'object' ? this.input.command || this.input.code || JSON.stringify(this.input, null, 2) : String(this.input) }));
      if (text) this.body.append(h('pre', { class: 'tool-pre term', text: text.slice(0, 20000) }));
    }
    this.update();
  }
  stop() {
    if (this.state === 'running') {
      this.state = 'done';
      this.update();
    }
  }
}

// ---------------------------------------------------------------- client tools (terminal, files, MCP)

class ToolCard {
  constructor(thread, container, block, live) {
    this.thread = thread;
    this.id = block.id;
    this.name = block.name;
    this.input = block.input && Object.keys(block.input).length ? block.input : null;
    this.json = '';
    this.state = live ? 'writing' : 'done';
    this.output = '';
    this.userToggled = false;
    this.el = h('div', { class: 'tool' });
    this.head = h('button', { class: 'tool-head' });
    this.bodyInner = h('div', { class: 'tool-body' });
    this.collapse = h('div', { class: 'collapse' }, h('div', { class: 'inner' }, this.bodyInner));
    this.el.append(this.head, this.collapse);
    this.head.onclick = () => {
      this.userToggled = true;
      this.el.classList.toggle('open');
    };
    container.append(this.el);
    this.renderHead();
    this.renderBody();
  }
  get mcp() {
    if (!this.name.startsWith('mcp__')) return null;
    const [, server, ...rest] = this.name.split('__');
    return { server, tool: rest.join('__') };
  }
  title() {
    const i = this.input || {};
    const st = this.state;
    const ing = st === 'running' || st === 'writing';
    switch (this.name) {
      case 'run_command': {
        const sh = SHELLS[i.shell] || 'PowerShell';
        return ing ? `Running ${sh}` : st === 'awaiting' ? `Run in ${sh}` : `Ran ${sh}`;
      }
      case 'read_file':
        return ing ? 'Reading file' : st === 'awaiting' ? 'Read file' : 'Read file';
      case 'list_directory':
        return ing ? 'Listing folder' : 'Listed folder';
      case 'write_file':
        return ing ? 'Writing file' : st === 'awaiting' ? 'Write file' : 'Wrote file';
      case 'edit_file':
        return ing ? 'Editing file' : st === 'awaiting' ? 'Edit file' : 'Edited file';
      case 'search_files':
        return ing ? 'Searching files' : 'Searched files';
      case 'download_file':
        return ing ? 'Downloading' : st === 'awaiting' ? 'Download file' : 'Downloaded';
      case 'start_process':
        return ing ? 'Starting process' : st === 'awaiting' ? 'Start background process' : 'Started process';
      case 'process_output':
        return ing ? `Watching ${i.id || 'process'}` : `Read output of ${i.id || 'process'}`;
      case 'send_input':
        return st === 'awaiting' ? `Type into ${i.id || 'process'}` : `Typed into ${i.id || 'process'}`;
      case 'stop_process':
        return ing ? `Stopping ${i.id || 'process'}` : st === 'awaiting' ? `Stop ${i.id || 'process'}` : `Stopped ${i.id || 'process'}`;
      case 'list_processes':
        return 'Listed processes';
      case 'update_plan':
        return 'Plan';
      case 'save_note':
        return ing ? 'Saving note' : 'Saved note';
      case 'remove_note':
        return 'Removed note';
      case 'search_memory':
        return ing ? 'Searching memory' : 'Searched memory';
      case 'web_search':
        return ing ? 'Searching the web' : st === 'awaiting' ? 'Search the web' : 'Searched the web';
      case 'web_fetch':
        return ing ? 'Reading page' : st === 'awaiting' ? 'Read web page' : 'Read page';
      case 'ask_user':
        return st === 'asking' ? 'Question for you' : 'Asked you';
      case 'suggest_smart_mode':
        return st === 'asking' ? 'Suggests Smart mode' : 'Suggested Smart mode';
      default: {
        const m = this.mcp;
        return m ? `${m.server} · ${m.tool}` : this.name;
      }
    }
  }
  icon() {
    return (
      {
        run_command: 'terminal',
        read_file: 'file',
        list_directory: 'folder',
        search_files: 'search',
        write_file: 'fileEdit',
        edit_file: 'fileEdit',
        download_file: 'download',
        start_process: 'terminal',
        process_output: 'terminal',
        send_input: 'terminal',
        stop_process: 'terminal',
        list_processes: 'terminal',
        update_plan: 'check',
        save_note: 'pencil',
        remove_note: 'trash',
        search_memory: 'brain',
        web_search: 'globe',
        web_fetch: 'globe',
        ask_user: 'chat',
        suggest_smart_mode: 'brain',
      }[this.name] || 'plug'
    );
  }
  summary() {
    const i = this.input || {};
    if (this.name === 'run_command' || this.name === 'start_process') return (i.command || partialJsonString(this.json, 'command') || '').split('\n')[0];
    if (this.name === 'download_file') return i.url || partialJsonString(this.json, 'url') || '';
    if (this.name === 'search_files') return [i.name, i.text && `"${i.text}"`].filter(Boolean).join(' · ') || i.path || '';
    if (this.name === 'send_input') return i.text || '';
    if (this.name === 'update_plan') { const it = planItems(i); const d = it.filter((x) => x.status === 'done').length; return it.length ? `${d} of ${it.length} done` : ''; }
    if (this.name === 'save_note') return i.text ? `${i.section || ''}: ${i.text}` : '';
    if (this.name === 'remove_note') return i.contains || '';
    if (this.name === 'search_memory' || this.name === 'web_search') return i.query || partialJsonString(this.json, 'query') || '';
    if (this.name === 'web_fetch') return i.url || partialJsonString(this.json, 'url') || '';
    if (this.name === 'process_output') return i.until_text ? `until "${i.until_text}"` : '';
    if (this.name === 'ask_user') return i.question || partialJsonString(this.json, 'question') || '';
    if (this.name === 'suggest_smart_mode') return i.reason || partialJsonString(this.json, 'reason') || '';
    if (['read_file', 'list_directory', 'write_file', 'edit_file'].includes(this.name)) return i.path || partialJsonString(this.json, 'path') || (this.name === 'list_directory' ? 'working folder' : '');
    if (this.input) {
      const first = Object.values(this.input).find((v) => typeof v === 'string');
      return first || '';
    }
    return '';
  }
  badge() {
    switch (this.state) {
      case 'writing':
        return '<span class="badge"><span class="spinner"></span>Preparing</span>';
      case 'awaiting':
        return '<span class="badge wait">Needs approval</span>';
      case 'asking':
        return '<span class="badge wait">Waiting for you</span>';
      case 'running':
        return '<span class="badge"><span class="spinner"></span>Running</span>';
      case 'denied':
        return '<span class="badge err">Declined</span>';
      case 'stopped':
        return '<span class="badge">Stopped</span>';
      case 'error':
        return `<span class="badge err">${this.exitCode != null ? `Exit ${this.exitCode}` : 'Error'}</span>`;
      default:
        if (this.name === 'run_command' && this.exitCode != null) return `<span class="badge ${this.exitCode === 0 ? 'ok' : 'err'}">Exit ${this.exitCode}</span>`;
        return this.hasResult ? `<span class="badge ok">${icon('check', 12)}Done</span>` : '';
    }
  }
  renderHead() {
    const sum = this.summary();
    this.head.innerHTML = `<span class="tic">${icon(this.icon(), 15)}</span><span class="tl"><span class="tname">${esc(this.title())}</span>${sum ? `<span class="tsum">${esc(sum)}</span>` : ''}</span>${this.badge()}${icon('chevronRight', 14, 'chev')}`;
  }
  renderBody() {
    const b = this.bodyInner;
    b.innerHTML = '';
    const i = this.input || {};
    if (this.name === 'run_command') {
      b.append(h('div', { class: 'tool-label', text: `${SHELLS[i.shell] || 'PowerShell'}${i.cwd ? ` · ${i.cwd}` : ''}` }), h('pre', { class: 'tool-pre', text: i.command || partialJsonString(this.json, 'command') || '' }));
    } else if (this.name === 'write_file') {
      const content = i.content ?? partialJsonString(this.json, 'content') ?? '';
      b.append(h('div', { class: 'tool-label', text: i.path || 'File' }), h('pre', { class: 'tool-pre', text: content.length > 12000 ? `${content.slice(0, 12000)}\n…` : content }));
    } else if (this.name === 'edit_file') {
      b.append(h('div', { class: 'tool-label', text: i.path || 'File' }));
      if (i.old_string != null) b.append(h('pre', { class: 'tool-pre', text: `- ${String(i.old_string).split('\n').join('\n- ')}\n+ ${String(i.new_string).split('\n').join('\n+ ')}` }));
    } else if (this.name === 'read_file' || this.name === 'list_directory') {
      b.append(h('div', { class: 'tool-label', text: i.path || (this.name === 'list_directory' ? 'Working folder' : '') }));
    } else if (this.name === 'update_plan') {
      const ul = h('ul', { class: 'todo-list' });
      for (const it of planItems(i)) ul.append(h('li', { class: it.status }, h('span', { class: 'box', text: it.status === 'done' ? '✓' : it.status === 'doing' ? '▸' : '○' }), h('span', { text: it.text })));
      b.append(ul);
      return;
    } else if (this.name === 'start_process') {
      b.append(h('div', { class: 'tool-label', text: `PowerShell · background${i.cwd ? ` · ${i.cwd}` : ''}${i.name ? ` · ${i.name}` : ''}` }), h('pre', { class: 'tool-pre', text: i.command || partialJsonString(this.json, 'command') || '' }));
    } else if (this.name === 'download_file') {
      b.append(h('div', { class: 'tool-label', text: 'From' }), h('pre', { class: 'tool-pre', text: i.url || '' }), h('div', { class: 'tool-label', text: 'To' }), h('pre', { class: 'tool-pre', text: i.path || '' }));
    } else if (ASK_TOOLS.has(this.name)) {
      // while asking, the question sits in the answer box below; afterwards it stays here
      const q = this.name === 'ask_user' ? i.question : `Smart mode recommended: ${i.reason || ''}`;
      if (q && this.state !== 'asking') b.append(h('div', { class: 'ask-q md', html: renderMarkdown(q) }));
      if (this.answer) b.append(h('div', { class: 'tool-label', text: `Your answer: ${this.answer}` }));
      if (this.output && !this.answer && this.hasResult) b.append(h('div', { class: 'tool-label', text: this.output }));
      return;
    } else if (this.input) {
      b.append(h('div', { class: 'tool-label', text: 'Input' }), h('pre', { class: 'tool-pre', text: JSON.stringify(this.input, null, 2) }));
    }
    if (this.output || this.state === 'running') {
      this.outEl = h('pre', { class: 'tool-pre term', text: this.output || '' });
      b.append(h('div', { class: 'tool-label', text: this.state === 'running' ? 'Output (live)' : 'Output' }), this.outEl);
      if (this.images) b.append(h('div', { class: 'tool-label', text: `+ ${this.images} image${this.images > 1 ? 's' : ''} returned to the model` }));
    }
  }
  appendJson(p) {
    this.json += p;
    if (!this.pending) {
      this.pending = true;
      raf(() => {
        this.pending = false;
        this.renderHead();
        if (this.el.classList.contains('open')) this.renderBody();
      });
    }
  }
  stopInput() {
    if (!this.input) {
      try {
        this.input = JSON.parse(this.json || '{}');
      } catch {
        this.input = {};
      }
    }
    if (this.state === 'writing') this.state = 'ready';
    this.renderHead();
    this.renderBody();
  }
  setInput(input) {
    this.input = input;
    this.renderHead();
    this.renderBody();
  }
  awaitApproval(ev) {
    if (this.hasResult) return;
    if (ev.input) this.input = ev.input;
    this.state = 'awaiting';
    this.el.classList.add('awaiting', 'open');
    this.renderHead();
    this.renderBody();
    this.approvalEl?.remove();
    const m = this.mcp;
    const what = {
      run_command: `run this command in <b>${esc(SHELLS[this.input?.shell] || 'PowerShell')}</b>`,
      read_file: 'read this file',
      list_directory: 'list this folder',
      search_files: 'search these files',
      write_file: '<b>write</b> this file',
      edit_file: '<b>change</b> this file',
      download_file: '<b>download</b> this file',
      web_search: `search the web for <b>${esc(this.input?.query || '')}</b> (the search words go to DuckDuckGo)`,
      web_fetch: `open <b>${esc(this.input?.url || '')}</b>`,
      start_process: 'start this program <b>in the background</b> (it keeps running until stopped)',
      send_input: `type <b>${esc(this.input?.text || '')}</b> into ${esc(this.input?.id || 'the process')}`,
      stop_process: `<b>stop</b> ${esc(this.input?.id || 'a process')}`,
    }[this.name];
    const q = what ? `The model wants to ${what} on your PC.` : `The model wants to use <b>${esc(m?.tool || this.name)}</b> from <b>${esc(m?.server || 'an MCP server')}</b>.`;
    const decide = (d) => {
      this.approvalEl?.remove();
      this.approvalEl = null;
      this.el.classList.remove('awaiting');
      this.state = d === 'deny' ? 'denied' : 'running';
      this.renderHead();
      this.thread.app.approve(this.id, d);
    };
    this.approvalEl = h(
      'div',
      { class: 'approval' },
      h('div', { class: 'q', html: q }),
      h(
        'div',
        { class: 'btns' },
        h('button', { class: 'btn dark sm', text: 'Allow once', onclick: () => decide('once') }),
        h('button', { class: 'btn ghost sm', text: 'Always allow', title: 'Never ask again for this tool (reset in Settings → Tools)', onclick: () => decide('always') }),
        h('button', { class: 'btn danger-ghost sm', text: 'Deny', onclick: () => decide('deny') }),
      ),
    );
    this.el.append(this.approvalEl);
    this.thread.stickIfNear(true);
  }
  // a question from the model (ask_user / suggest_smart_mode): option buttons + own answer
  askQuestion(ev) {
    if (this.hasResult) return;
    this.state = 'asking';
    this.el.classList.add('awaiting', 'open', 'asking');
    this.renderHead();
    this.renderBody();
    this.approvalEl?.remove();
    const decide = (text) => {
      text = String(text || '').trim();
      if (!text) return;
      this.answer = text;
      this.approvalEl?.remove();
      this.approvalEl = null;
      this.el.classList.remove('awaiting', 'asking');
      this.state = 'done';
      this.renderHead();
      this.renderBody();
      this.thread.app.answer(this.id, text);
    };
    const btns = h('div', { class: 'btns' });
    (ev.options || []).forEach((o, i) => btns.append(h('button', { class: `btn ${i === 0 ? 'dark' : 'ghost'} sm`, text: o, onclick: () => decide(o) })));
    const input = h('input', { class: 'ask-input', placeholder: ev.options?.length ? 'Or type your own answer…' : 'Type your answer…' });
    const send = h('button', { class: 'btn ghost sm', text: 'Send', onclick: () => decide(input.value) });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        decide(input.value);
      }
    });
    const lead = ev.kind === 'smart' ? `${esc(ev.question)}<br><span class="sub">Smart mode uses the 9B model: slower, but it plans and checks its work.</span>` : renderMarkdown(ev.question);
    this.approvalEl = h('div', { class: 'approval ask' }, h('div', { class: 'q', html: lead }), btns, h('div', { class: 'ask-row' }, input, send));
    this.el.append(this.approvalEl);
    this.thread.stickIfNear(true);
    setTimeout(() => (ev.options?.length ? null : input.focus()), 50);
  }
  setRunning() {
    if (this.hasResult) return;
    this.approvalEl?.remove();
    this.el.classList.remove('awaiting');
    this.state = 'running';
    if (this.name === 'run_command' && !this.userToggled) this.el.classList.add('open');
    this.renderHead();
    this.renderBody();
  }
  progress(text) {
    this.output = (this.output + text).slice(-60000);
    if (this.outEl) {
      this.outEl.textContent = this.output;
      this.outEl.scrollTop = this.outEl.scrollHeight;
    } else this.renderBody();
  }
  setResult({ text, isError, exitCode, denied, images }, animate = true) {
    this.hasResult = true;
    this.approvalEl?.remove();
    this.el.classList.remove('awaiting', 'asking');
    this.output = text || '';
    if (ASK_TOOLS.has(this.name) && !this.answer) {
      const m = /^The user answered: ([\s\S]*)$/.exec(this.output);
      if (m) this.answer = m[1];
      else if (/switched this chat to Smart/.test(this.output)) this.answer = 'Switch to Smart';
      else if (/stay in Quick/.test(this.output)) this.answer = 'Stay in Quick';
    }
    this.images = images || 0;
    if (this.name === 'run_command') {
      const m = /^Exit code: (-?\d+|null)/.exec(this.output);
      this.exitCode = exitCode ?? (m && m[1] !== 'null' ? Number(m[1]) : null);
      this.output = this.output.replace(/^Exit code: [^\n]*\n?/, '');
    }
    this.state = denied || /^The user (declined|stopped)/.test(text || '') ? (/stopped/.test(text) ? 'stopped' : 'denied') : isError ? 'error' : 'done';
    this.renderHead();
    this.renderBody();
    if (this.name === 'update_plan') this.el.classList.add('open');
    else if (animate && !this.userToggled && this.state === 'done') setTimeout(() => !this.userToggled && this.el.classList.remove('open'), 700);
  }
  stop() {
    if (!this.hasResult && this.state !== 'done') {
      this.state = 'stopped';
      this.approvalEl?.remove();
      this.el.classList.remove('awaiting');
      this.renderHead();
    }
  }
}

// ---------------------------------------------------------------- one API message

class MessageView {
  constructor(thread, turn, msgIndex, live) {
    this.thread = thread;
    this.turn = turn;
    this.msgIndex = msgIndex;
    this.live = live;
    this.el = h('div', { class: 'msg' });
    turn.body.append(this.el);
    this.blocks = new Map();
  }
  start(index, block, live = this.live) {
    let v = null;
    switch (block.type) {
      case 'text':
        v = new TextView(this.el, live);
        if (block.text) live ? v.append(block.text) : v.setFinal(block.text, block.citations || []);
        if (!live && !block.text) v.setFinal('', block.citations || []);
        break;
      case 'thinking':
        v = new ThinkingView(this.el, live);
        if (!live) v.finish(block.thinking || '');
        else if (block.thinking) v.append(block.thinking);
        break;
      case 'redacted_thinking':
        v = new ThinkingView(this.el, false, true);
        v.finish('');
        break;
      case 'server_tool_use':
        v = new ServerStepView(this.el, block, live);
        this.thread.steps.set(block.id, v);
        break;
      case 'tool_use':
        v = new ToolCard(this.thread, this.el, block, live);
        this.thread.cards.set(block.id, v);
        break;
      case 'fallback':
        v = { el: h('div', { class: 'notice info' }, h('span', { html: icon('info', 16) }), h('span', { class: 'grow', text: `${this.thread.app.modelName(block.from?.model)} declined this request, so ${this.thread.app.modelName(block.to?.model)} continued.` })) };
        this.el.append(v.el);
        break;
      default:
        if (block.type.endsWith('_tool_result') && block.tool_use_id) {
          const step = this.thread.steps.get(block.tool_use_id);
          if (step) step.setResult(block);
        }
    }
    if (v) this.blocks.set(index, v);
    return v;
  }
  delta(index, d) {
    const v = this.blocks.get(index);
    if (!v) return;
    if (d.type === 'text_delta') v.append?.(d.text);
    else if (d.type === 'citations_delta') v.addCitation?.(d.citation);
    else if (d.type === 'thinking_delta') v.append?.(d.thinking);
    else if (d.type === 'input_json_delta') v.appendJson?.(d.partial_json);
  }
  stopBlock(index) {
    const v = this.blocks.get(index);
    if (v instanceof ThinkingView) v.finish();
    else if (v instanceof ServerStepView || v instanceof ToolCard) v.stopInput();
    else if (v instanceof TextView) {
      v.final = true;
      v.kick();
    }
  }
  finish(content) {
    content.forEach((b, i) => {
      const v = this.blocks.get(i);
      if (!v) {
        // a block whose start we missed (e.g. opened mid-turn): draw it complete
        this.start(i, b, false);
        return;
      }
      if (v instanceof TextView) v.setFinal(b.text, b.citations || []);
      else if (v instanceof ThinkingView) v.finish(b.thinking ?? '');
      else if (v instanceof ToolCard && b.input) v.setInput(b.input);
    });
  }
  abort() {
    for (const v of this.blocks.values()) {
      if (v instanceof TextView) v.stopNow();
      else if (v instanceof ThinkingView) v.finish();
      else v.stop?.();
    }
  }
  renderStatic(content) {
    (content || []).forEach((b, i) => this.start(i, b));
  }
  text() {
    return [...this.blocks.values()].filter((v) => v instanceof TextView).map((v) => v.text).join('\n\n');
  }
}

// ---------------------------------------------------------------- the thread

export class Thread {
  constructor(root, scroller, toBottom, app) {
    this.root = root;
    this.scroller = scroller;
    this.toBottom = toBottom;
    this.app = app;
    this.conv = null;
    this.stick = true;
    scroller.addEventListener('scroll', () => {
      const d = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      this.stick = d < 80;
      toBottom.classList.toggle('show', d > 300);
    });
    toBottom.innerHTML = icon('chevronDown', 18);
    toBottom.onclick = () => this.scrollToBottom(true);
    new ResizeObserver(() => {
      if (this.stick) scroller.scrollTop = scroller.scrollHeight;
    }).observe(root);
    root.addEventListener('click', (e) => this.onClick(e));
  }

  onClick(e) {
    const copy = e.target.closest('.code-copy');
    if (copy) {
      const code = copy.closest('.code-block').querySelector('pre code').textContent;
      copyText(code, copy);
      return;
    }
    const prev = e.target.closest('.code-preview');
    if (prev) {
      const blk = prev.closest('.code-block');
      this.app.preview(blk.querySelector('pre code').textContent, blk.dataset.lang);
      return;
    }
    const img = e.target.closest('.attach-thumb');
    if (img) lightbox(img.src);
  }

  scrollToBottom(smooth) {
    this.stick = true;
    this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  stickIfNear(force) {
    if (force || this.stick) this.scrollToBottom(true);
  }

  // ------------------------------------------------ full render

  render(conv) {
    this.conv = conv;
    this.root.innerHTML = '';
    this.cards = new Map();
    this.steps = new Map();
    this.turns = [];
    this.views = new Map(); // msgIndex -> MessageView
    this.errorEl = null;
    let turn = null;
    conv.messages.forEach((m, i) => {
      if (isAutoCheck(m)) {
        turn ||= this.newTurn(false);
        this.addCheckNote(turn);
      } else if (isRealUser(m)) {
        this.addUser(m, i, false);
        turn = null;
      } else if (m.role === 'assistant') {
        turn ||= this.newTurn(false);
        const mv = new MessageView(this, turn, i, false);
        mv.renderStatic(Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }]);
        turn.msgs.push(i);
        this.views.set(i, mv);
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type !== 'tool_result') continue;
          const imgs = Array.isArray(b.content) ? b.content.filter((c) => c.type === 'image').length : 0;
          this.cards.get(b.tool_use_id)?.setResult({ text: resultText(b.content), isError: !!b.is_error, images: imgs }, false);
        }
        // messages the user sent while the model was working
        const queued = m.content.map(queuedText).filter((t) => t != null);
        if (queued.length) {
          this.addUser({ role: 'user', content: [{ type: 'text', text: queued.join('\n\n') }] }, i, false, 'delivered');
          turn = null;
        }
      }
    });
    this.turns.forEach((t) => this.updateFoot(t));
    this.markLast();
    this.scrollToBottom(false);
  }

  // queued: 'queued' (waiting for the model's next step) | 'delivered' | undefined
  addUser(m, index, animate, queued) {
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    const names = this.conv.attachNames?.[index] || [];
    let imgN = 0;
    const atts = h('div', { class: 'attach-row' });
    let text = '';
    for (const b of content) {
      if (b.type === 'image' && b.source?.type === 'base64') {
        atts.append(h('img', { class: 'attach-thumb', src: `data:${b.source.media_type};base64,${b.source.data}`, title: names[imgN++] || 'Image', alt: '' }));
      } else if (b.type === 'document') {
        const kind = b.source?.media_type === 'application/pdf' ? 'PDF' : 'Text';
        atts.append(h('div', { class: 'attach-doc' }, h('span', { html: icon('file', 18) }), h('div', {}, h('div', { class: 'n', text: b.title || 'Document' }), h('div', { class: 'k', text: kind }))));
      } else if (b.type === 'text') text += (text ? '\n\n' : '') + b.text;
    }
    const wrap = h('div', { class: 'user-wrap' });
    if (atts.children.length) wrap.append(atts);
    const bubble = h('div', { class: 'bubble', text });
    if (text) wrap.append(bubble);
    const actions = h(
      'div',
      { class: 'user-actions' },
      h('button', { class: 'icon-btn sm', title: 'Copy', html: icon('copy', 15), onclick: (e) => copyText(text, e.currentTarget) }),
      queued ? null : h('button', { class: 'icon-btn sm', title: 'Edit', html: icon('pencil', 15), onclick: () => this.startEdit(wrap, bubble, index, text, content) }),
    );
    if (queued) {
      wrap.append(h('div', { class: 'queued-tag', text: queued === 'queued' ? 'Queued · reaches the model at its next step' : 'Sent while it was working' }));
      wrap.classList.add(queued === 'queued' ? 'is-queued' : 'was-queued');
    }
    wrap.append(actions);
    const row = h('div', { class: 'turn-user' }, wrap);
    if (!animate) row.style.animation = 'none';
    this.root.append(row);
    return row;
  }

  startEdit(wrap, bubble, index, text, content) {
    if (this.app.isBusy()) return;
    const ta = h('textarea', { rows: 3 });
    ta.value = text;
    const box = h(
      'div',
      { class: 'edit-box' },
      ta,
      h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', text: 'Cancel', onclick: () => box.replaceWith(bubble) }), h('button', { class: 'btn dark sm', text: 'Send', onclick: () => send() })),
    );
    const send = () => {
      const t = ta.value.trim();
      if (!t) return;
      const blocks = content.filter((b) => b.type !== 'text');
      blocks.push({ type: 'text', text: t });
      this.app.editMessage(index, blocks);
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      } else if (e.key === 'Escape') box.replaceWith(bubble);
    });
    bubble.replaceWith(box);
    const fit = () => {
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight}px`;
    };
    ta.addEventListener('input', fit);
    setTimeout(() => {
      fit();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  newTurn(live) {
    const el = h('div', { class: 'turn-assistant' });
    const body = h('div', { class: 'a-body' });
    const foot = h('div', { class: 'a-foot' });
    el.append(body, foot);
    this.root.append(el);
    const turn = { el, body, foot, msgs: [], working: live };
    const prev = this.turns[this.turns.length - 1];
    this.turns.push(turn);
    if (prev) this.updateFoot(prev);
    this.updateFoot(turn);
    return turn;
  }

  lastTurn() {
    const last = this.root.lastElementChild;
    return last && last.classList.contains('turn-assistant') ? this.turns[this.turns.length - 1] : null;
  }

  markLast() {
    this.turns.forEach((t, i) => t.el.classList.toggle('last', i === this.turns.length - 1 && this.root.lastElementChild === t.el));
  }

  updateFoot(turn) {
    const isLast = turn === this.turns[this.turns.length - 1];
    const meta = turn.msgs.map((i) => this.conv.meta?.[i]).filter(Boolean);
    const out =meta.reduce((s, m) => s + (m.usage?.output_tokens || 0), 0);
    const inTok = meta.length ? (meta[meta.length - 1].usage?.input_tokens || 0) + (meta[meta.length - 1].usage?.cache_read_input_tokens || 0) + (meta[meta.length - 1].usage?.cache_creation_input_tokens || 0) : 0;
    const model = meta.length ? this.app.modelName(meta[meta.length - 1].model) : '';
    turn.foot.innerHTML = '';
    if (isLast || turn.working) turn.foot.append(h('span', { html: spark(22, turn.working ? 'working' : '') }));
    if (turn.working) return;
    const textOf = () =>
      turn.msgs
        .map((i) => this.views.get(i)?.text() || '')
        .filter(Boolean)
        .join('\n\n');
    const actions = h('div', { class: 'a-actions' }, h('button', { class: 'icon-btn sm', title: 'Copy', html: icon('copy', 15), onclick: (e) => copyText(textOf(), e.currentTarget) }));
    if (isLast) actions.append(h('button', { class: 'icon-btn sm', title: 'Retry', html: icon('retry', 15), onclick: (e) => this.app.retryMenu(e.currentTarget) }));
    turn.foot.append(actions);
    if (model) {
      const parts = [`<b>${esc(model)}</b>`];
      if (this.app.showCost()) {
        const last = meta[meta.length - 1] || {};
        const tps = meta.map((m) => m.tps).filter(Boolean);
        const secs = Math.round(meta.reduce((s, m) => s + (m.ms || 0), 0) / 1000);
        if (out) parts.push(`${fmtTokens(out)} tokens`);
        if (tps.length) parts.push(`${(tps.reduce((a, b) => a + b, 0) / tps.length).toFixed(1)} tok/s`);
        if (secs) parts.push(secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`);
        if (last.ctx && inTok) parts.push(`<span class="${inTok > last.ctx * 0.85 ? 'warn' : ''}">context ${Math.round((inTok / last.ctx) * 100)}%</span>`);
      }
      if (meta.some((m) => m.stopped)) parts.push('stopped');
      turn.foot.append(h('span', { class: 'a-meta', html: parts.join(' · '), title: 'Tokens, generation speed, time, and how full the model\'s context window is' }));
    }
  }

  // ------------------------------------------------ live events

  apply(ev) {
    switch (ev.type) {
      case 'turn_start': {
        this.clearError();
        const t = this.lastTurn() || this.newTurn(true);
        t.working = true;
        this.updateFoot(t);
        this.markLast();
        break;
      }
      case 'msg_start': {
        if (ev.msgIndex < this.conv.messages.length && this.views.has(ev.msgIndex)) break; // already drawn from history
        this.views.get(ev.msgIndex)?.el.remove();
        const t = this.lastTurn() || this.newTurn(true);
        t.working = true;
        const mv = new MessageView(this, t, ev.msgIndex, true);
        this.views.set(ev.msgIndex, mv);
        if (!t.msgs.includes(ev.msgIndex)) t.msgs.push(ev.msgIndex);
        this.updateFoot(t);
        break;
      }
      case 'msg_retry':
        this.views.get(ev.msgIndex)?.el.remove();
        this.views.delete(ev.msgIndex);
        break;
      case 'block_start':
        this.liveView(ev.msgIndex)?.start(ev.index, ev.block);
        break;
      case 'block_delta':
        this.liveView(ev.msgIndex)?.delta(ev.index, ev.delta);
        break;
      case 'block_stop':
        this.liveView(ev.msgIndex)?.stopBlock(ev.index);
        break;
      case 'msg_done': {
        const mv = this.views.get(ev.msgIndex);
        if (this.conv.messages.length <= ev.msgIndex) {
          this.conv.messages[ev.msgIndex] = { role: 'assistant', content: ev.content };
          this.conv.meta[ev.msgIndex] = ev.meta;
        }
        if (mv?.live) mv.finish(ev.content);
        if (ev.stopReason === 'max_tokens' && !ev.content.some((b) => b.type === 'tool_use')) this.showNotice('The answer hit the output limit and was cut off.', 'info');
        break;
      }
      case 'msg_aborted':
        this.views.get(ev.msgIndex)?.abort?.();
        break;
      case 'approval':
        this.cards.get(ev.toolUseId)?.awaitApproval(ev);
        break;
      case 'question':
        this.cards.get(ev.toolUseId)?.askQuestion(ev);
        break;
      case 'self_check': {
        this.conv.messages[ev.msgIndex] = { role: 'user', content: [{ type: 'text', text: CHECK_MARK }] };
        const t = this.lastTurn() || this.newTurn(true);
        this.addCheckNote(t, true);
        this.stickIfNear();
        break;
      }
      case 'context_trimmed':
        this.showNotice("This chat is longer than the model's context window, so older tool output and messages are left out of what the model sees. Its notes are kept.", 'info');
        break;
      case 'hint':
        this.showHint(ev);
        break;
      case 'inbox_delivered':
        this.markQueuedDelivered();
        break;
      case 'queued_started':
        // the queued message became the next turn's prompt
        this.conv.messages[ev.msgIndex] = { role: 'user', content: ev.content };
        for (const w of this.root.querySelectorAll('.user-wrap.is-queued')) {
          w.classList.remove('is-queued');
          w.querySelector('.queued-tag')?.remove();
        }
        break;
      case 'tool_running':
        this.cards.get(ev.toolUseId)?.setRunning();
        break;
      case 'tool_progress':
        this.cards.get(ev.toolUseId)?.progress(ev.text);
        break;
      case 'tool_result':
        this.cards.get(ev.toolUseId)?.setResult(ev);
        break;
      case 'tool_results_saved':
        // the matching user message is on disk; keep the local copy's indices in step
        if (this.conv.messages.length <= ev.msgIndex) this.conv.messages[ev.msgIndex] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: '_' }] };
        break;
      case 'turn_end': {
        let t = this.lastTurn();
        if (t && !t.msgs.length) {
          // the request failed before Claude wrote anything: drop the empty turn
          t.el.remove();
          this.turns.pop();
          t = null;
          if (this.turns.length) this.updateFoot(this.turns[this.turns.length - 1]);
        }
        // finish every turn still marked working (a queued bubble may sit below the live turn)
        for (const w of this.turns.filter((x) => x.working || x === t)) {
          w.working = false;
          for (const i of w.msgs) this.views.get(i)?.live && this.views.get(i).blocks.forEach((v) => v.stop?.());
          this.updateFoot(w);
        }
        for (const c of this.cards.values()) if (!c.hasResult && c.state !== 'done') c.stop();
        for (const n of this.root.querySelectorAll('.auto-check.live')) {
          n.classList.remove('live');
          n.querySelector('span').textContent = 'Checked its work';
        }
        if (ev.error) this.showError(ev.error);
        this.markLast();
        break;
      }
    }
  }

  liveView(i) {
    const v = this.views.get(i);
    return v && v.live ? v : null;
  }

  showNotice(text, kind = 'info', detail) {
    const n = h('div', { class: `notice ${kind}` }, h('span', { html: icon(kind === 'error' ? 'alert' : 'info', 16) }), h('span', { class: 'grow', text: detail ? `${text} ${detail}` : text }));
    (this.lastTurn()?.body || this.root).append(n);
  }

  /** "This model is slow on this PC": said once, with a way to the setup dialog and a way to silence it. */
  showHint(ev) {
    const n = h('div', { class: 'notice info hint-slow' }, h('span', { html: icon('info', 16) }), h('span', { class: 'grow', text: ev.text }));
    n.append(
      h('button', { class: 'btn ghost sm', text: 'Check this PC', onclick: () => this.app.openSetup() }),
      h('button', {
        class: 'btn ghost sm',
        text: "Don't show again",
        onclick: async () => {
          await this.app.saveSettings({ hintsOff: { ...(this.app.settings().hintsOff || {}), [ev.key]: true } });
          n.remove();
        },
      }),
    );
    (this.lastTurn()?.body || this.root).append(n);
    this.stickIfNear();
  }

  showError(err) {
    this.clearError();
    const retry = h('button', { class: 'btn ghost sm', text: 'Retry', onclick: () => this.app.retry() });
    const extra = err.kind === 'settings' ? h('button', { class: 'btn ghost sm', text: 'Open settings', onclick: () => this.app.openSettings('key') }) : null;
    this.errorEl = h('div', { class: 'notice error' }, h('span', { html: icon('alert', 16) }), h('span', { class: 'grow', text: err.message }), extra, retry);
    this.root.append(this.errorEl);
    this.stickIfNear(true);
  }

  clearError() {
    this.errorEl?.remove();
    this.errorEl = null;
  }

  addCheckNote(turn, live) {
    turn.body.append(h('div', { class: `auto-check${live ? ' live' : ''}`, html: `${icon('check', 14)}<span>${live ? 'Checking its work before finishing' : 'Checked its work'}</span>` }));
  }

  appendUser(m, index) {
    this.conv.messages[index] = m;
    this.addUser(m, index, true);
    this.markLast();
    this.scrollToBottom(true);
  }

  // a message sent while the model works: shown at once, delivered at its next step
  appendQueued(blocks) {
    const row = this.addUser({ role: 'user', content: blocks }, -1, true, 'queued');
    this.markLast();
    this.scrollToBottom(true);
    return row;
  }

  markQueuedDelivered() {
    for (const w of this.root.querySelectorAll('.user-wrap.is-queued')) {
      w.classList.replace('is-queued', 'was-queued');
      const tag = w.querySelector('.queued-tag');
      if (tag) tag.textContent = 'Sent while it was working';
    }
  }
}
