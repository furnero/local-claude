// The message box: text, attachments (picker, paste, drag and drop), the tools menu, the model
// and effort picker, and the send / stop button. One instance moves between the welcome screen
// and the bottom of a chat.
import { icon } from './icons.js';
import { esc } from './markdown.js';
import { h, openMenu, toast } from './ui.js';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|c|h|cpp|hpp|cc|cs|php|swift|sh|bash|zsh|ps1|psm1|bat|cmd|yml|yaml|toml|ini|cfg|conf|env|log|sql|lua|r|m|pl|vue|svelte|gradle|properties|tex|rst|srt|vtt|gitignore|dockerfile|makefile)$/i;
const MAX_IMAGE_BYTES = 3.7 * 1024 * 1024; // base64 grows by a third; the API limit is 5 MB
const MAX_FILE_BYTES = 30 * 1024 * 1024;

function readAs(file, how) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    if (how === 'text') r.readAsText(file);
    else r.readAsDataURL(file);
  });
}

async function shrinkImage(dataUrl, type) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });
  let { width: w, height: hgt } = img;
  const max = 2048;
  if (w > max || hgt > max) {
    const s = max / Math.max(w, hgt);
    w = Math.round(w * s);
    hgt = Math.round(hgt * s);
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt;
  c.getContext('2d').drawImage(img, 0, 0, w, hgt);
  const outType = type === 'image/png' && w * hgt < 1500 * 1500 ? 'image/png' : 'image/jpeg';
  let q = 0.9;
  let url = c.toDataURL(outType, q);
  while (url.length * 0.75 > MAX_IMAGE_BYTES && q > 0.4) {
    q -= 0.15;
    url = c.toDataURL('image/jpeg', q);
  }
  return url;
}

export class Composer {
  constructor(app) {
    this.app = app;
    this.files = [];
    this.busy = false;
    this.el = h('div', { class: 'composer' });
    this.attachEl = h('div', { class: 'attachments' });
    this.ta = h('textarea', { rows: 1, placeholder: 'How can I help you today?', spellcheck: 'true' });
    this.fileInput = h('input', { type: 'file', multiple: true, hidden: true });
    this.attachBtn = h('button', { class: 'c-btn', title: 'Add files or images', html: icon('plus', 18) });
    this.toolsBtn = h('button', { class: 'c-btn', title: 'Tools', html: icon('sliders', 18) });
    this.modelBtn = h('button', { class: 'c-btn model-btn', title: 'Mode and thinking' });
    this.sendBtn = h('button', { class: 'send-btn', title: 'Send (Enter)', html: icon('arrowUp', 18) });
    this.el.append(this.attachEl, this.ta, h('div', { class: 'c-row' }, this.attachBtn, this.toolsBtn, h('div', { class: 'grow' }), this.modelBtn, this.sendBtn), this.fileInput);

    this.ta.addEventListener('input', () => this.fit());
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    this.ta.addEventListener('paste', (e) => this.onPaste(e));
    this.attachBtn.onclick = () => this.fileInput.click();
    this.fileInput.onchange = () => {
      this.addFiles([...this.fileInput.files]);
      this.fileInput.value = '';
    };
    this.toolsBtn.onclick = () => this.toolsMenu();
    this.modelBtn.onclick = () => this.modelMenu();
    // while it works: an empty box makes the button Stop; typed text makes it Send (queued)
    this.sendBtn.onclick = () => (this.busy && !this.hasInput() ? this.app.stop() : this.submit());
    for (const ev of ['dragenter', 'dragover']) {
      document.addEventListener(ev, (e) => {
        if ([...(e.dataTransfer?.types || [])].includes('Files')) {
          e.preventDefault();
          this.el.classList.add('drag');
        }
      });
    }
    document.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) this.el.classList.remove('drag');
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      this.el.classList.remove('drag');
      if (e.dataTransfer?.files?.length) this.addFiles([...e.dataTransfer.files]);
    });
  }

  mount(slot) {
    if (this.el.parentElement !== slot) slot.append(this.el);
  }

  focus() {
    this.ta.focus();
  }

  fit() {
    this.ta.style.height = 'auto';
    this.ta.style.height = `${Math.min(this.ta.scrollHeight, window.innerHeight * 0.4)}px`;
    this.updateSend();
  }

  setText(t) {
    this.ta.value = t;
    this.fit();
    this.focus();
    this.ta.setSelectionRange(t.length, t.length);
  }

  onKey(e) {
    const sendKey = this.app.settings().sendWithEnter ? e.key === 'Enter' && !e.shiftKey && !e.ctrlKey : e.key === 'Enter' && e.ctrlKey;
    if (sendKey && !e.isComposing) {
      e.preventDefault();
      this.submit(); // while busy this queues the message for the model's next step
    } else if (e.key === 'Escape' && this.busy) {
      e.preventDefault();
      this.app.stop();
    }
  }

  onPaste(e) {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      this.addFiles(files);
    }
  }

  async addFiles(list) {
    for (const f of list) {
      try {
        if (f.size > MAX_FILE_BYTES) {
          toast(`${f.name} is too big (max 30 MB).`, { error: true });
          continue;
        }
        if (IMAGE_TYPES.includes(f.type)) {
          let url = await readAs(f, 'url');
          if (f.size > MAX_IMAGE_BYTES) url = await shrinkImage(url, f.type);
          else {
            // very large dimensions are rejected by the API (8000 px); shrink those too
            const dims = await new Promise((r) => {
              const i = new Image();
              i.onload = () => r([i.width, i.height]);
              i.onerror = () => r([0, 0]);
              i.src = url;
            });
            if (Math.max(...dims) > 4000) url = await shrinkImage(url, f.type);
          }
          const [, mediaType, data] = /^data:([^;]+);base64,(.*)$/.exec(url);
          this.files.push({ kind: 'image', name: f.name || 'pasted image', mediaType, data, url });
        } else if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
          const url = await readAs(f, 'url');
          this.files.push({ kind: 'pdf', name: f.name, mediaType: 'application/pdf', data: url.split(',')[1] });
        } else if (f.type.startsWith('text/') || TEXT_EXT.test(f.name) || /json|xml|javascript/.test(f.type)) {
          const text = await readAs(f, 'text');
          if (text.includes('\u0000')) throw new Error('binary');
          this.files.push({ kind: 'text', name: f.name, text });
        } else {
          toast(`${f.name}: only images, PDFs and text/code files can be attached.`, { error: true });
        }
      } catch {
        toast(`Couldn't read ${f.name}.`, { error: true });
      }
    }
    this.renderFiles();
  }

  renderFiles() {
    this.attachEl.innerHTML = '';
    this.files.forEach((f, i) => {
      const rm = h('button', { class: 'rm', title: 'Remove', html: icon('x', 12) });
      rm.onclick = () => {
        this.files.splice(i, 1);
        this.renderFiles();
      };
      const inner = f.kind === 'image' ? h('img', { src: f.url, title: f.name }) : h('div', { class: 'doc' }, h('div', { class: 'n', text: f.name, title: f.name }), h('div', { class: 'k', text: f.kind === 'pdf' ? 'PDF' : f.name.split('.').pop() }));
      this.attachEl.append(h('div', { class: 'att' }, inner, rm));
    });
    this.updateSend();
  }

  content() {
    const blocks = [];
    const names = [];
    for (const f of this.files) {
      if (f.kind === 'image') {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.data } });
        names.push(f.name);
      } else if (f.kind === 'pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data }, title: f.name });
      else blocks.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: f.text || ' ' }, title: f.name });
    }
    const text = this.ta.value.trim();
    if (text) blocks.push({ type: 'text', text });
    return { blocks, names, text };
  }

  submit() {
    const { blocks, names } = this.content();
    if (!blocks.length) return;
    if (!blocks.some((b) => b.type === 'text')) blocks.push({ type: 'text', text: 'Please look at the attached file(s).' });
    this.app.send(blocks, names).then((ok) => {
      if (ok) {
        this.ta.value = '';
        this.files = [];
        this.renderFiles();
        this.fit();
      }
    });
  }

  setBusy(b) {
    this.busy = b;
    this.updateSend();
  }

  hasInput() {
    return !!this.ta.value.trim() || this.files.length > 0;
  }

  updateSend() {
    const stop = this.busy && !this.hasInput();
    const mode = stop ? 'stop' : this.busy ? 'queue' : 'send';
    if (this.sendMode !== mode) {
      this.sendMode = mode;
      this.sendBtn.classList.toggle('stop', stop);
      this.sendBtn.innerHTML = icon(stop ? 'stop' : 'arrowUp', 18);
      this.sendBtn.title = stop ? 'Stop (Esc)' : this.busy ? 'Send now - it reaches the model at its next step (Enter)' : 'Send (Enter)';
    }
    this.sendBtn.disabled = !this.busy && !this.hasInput();
  }

  setPlaceholder(t) {
    this.ta.placeholder = t;
  }

  refresh() {
    const s = this.app.settings();
    const model = this.app.currentModel();
    const eff = s.effort === 'off' ? 'no thinking' : '';
    const use = this.app.contextUse();
    const pct = use ? Math.min(100, Math.round((use.used / use.ctx) * 100)) : 0;
    const meter = use ? `<span class="ctx-meter${pct >= 85 ? ' full' : pct >= 60 ? ' mid' : ''}" title="Context window: about ${use.used.toLocaleString()} of ${use.ctx.toLocaleString()} tokens used. When it fills up, older tool output is left out automatically."><i style="width:${Math.max(4, pct)}%"></i></span>` : '';
    this.modelBtn.innerHTML = `${meter}<span>${esc(this.app.modelName(model))}</span>${eff ? `<span class="eff">· ${esc(eff)}</span>` : ''}${icon('chevronDown', 14)}`;
    const anyTool = s.webSearch || s.computer || this.app.mcpServers().some((m) => m.state === 'ready' && !s.mcpOff?.[m.name]);
    this.toolsBtn.classList.toggle('on', !!anyTool);
  }

  modelMenu() {
    const s = this.app.settings();
    const current = this.app.currentModel();
    const items = [{ title: 'Mode' }];
    for (const m of this.app.models()) {
      // a mode whose engine is not on this PC is only listed for a chat that already uses it
      if (m.unavailable && m.id !== current) continue;
      items.push({
        label: m.name,
        desc: m.desc,
        check: m.id === current,
        onClick: () => this.app.setModel(m.id),
      });
    }
    items.push({ label: 'Choose models…', desc: 'Which Ollama model each mode runs, and its context window', icon: 'settings', onClick: () => this.app.openSettings('key') });
    items.push({ sep: true }, { title: 'Thinking' });
    const pills = h('div', { class: 'pills' });
    for (const e of this.app.efforts()) {
      const p = h('button', { class: `pill${(s.effort || 'default') === e.id ? ' on' : ''}`, text: e.name, title: e.desc });
      p.onclick = () => {
        this.app.saveSettings({ effort: e.id });
        pills.querySelectorAll('.pill').forEach((x) => x.classList.toggle('on', x === p));
        this.refresh();
      };
      pills.append(p);
    }
    items.push({ el: pills });
    openMenu(this.modelBtn, items, { placement: 'auto', align: 'right' });
  }

  toolsMenu() {
    const s = this.app.settings();
    const tcfg = this.app.toolsConfig();
    const computerAvailable = tcfg.shell.enabled || tcfg.files.enabled;
    const running = this.app.processes().filter((p) => p.running).length;
    const items = [
      { title: 'Tools' },
      tcfg.web?.enabled !== false
        ? {
            label: 'Web access',
            desc: 'Search and read web pages · only while online' + (tcfg.web?.approval === 'auto' ? '' : ' · asks first'),
            icon: 'globe',
            toggle: !!s.webSearch,
            onClick: () => {
              this.app.saveSettings({ webSearch: !this.app.settings().webSearch });
              this.refresh();
            },
          }
        : { note: 'Web tools are switched off in config.json.' },
      computerAvailable
        ? {
            label: 'Computer access',
            desc: [tcfg.shell.enabled && 'terminal + servers', tcfg.files.enabled && 'files + downloads'].filter(Boolean).join(' + ') + (tcfg.shell.approval === 'auto' ? ' · runs without asking' : ' · asks before running'),
            icon: 'terminal',
            toggle: !!s.computer,
            onClick: () => {
              this.app.saveSettings({ computer: !this.app.settings().computer });
              this.refresh();
            },
          }
        : { note: 'Terminal and file tools are switched off in config.json.' },
    ];
    const servers = this.app.mcpServers();
    items.push({ sep: true }, { title: 'MCP servers' });
    if (!servers.length) items.push({ note: 'None yet. Add servers to config.json (same format as Claude Desktop).' });
    for (const m of servers) {
      const off = !!s.mcpOff?.[m.name];
      items.push({
        label: m.name,
        dot: m.state,
        desc: m.state === 'ready' ? `${m.tools.length} tool${m.tools.length === 1 ? '' : 's'}` : m.state === 'error' ? 'failed to start - see Settings → Tools' : m.state === 'connecting' ? 'starting…' : m.state,
        toggle: m.state === 'ready' ? !off : undefined,
        onClick: () => {
          if (m.state !== 'ready') return this.app.openSettings('tools');
          const mcpOff = { ...(this.app.settings().mcpOff || {}) };
          if (mcpOff[m.name]) delete mcpOff[m.name];
          else mcpOff[m.name] = true;
          this.app.saveSettings({ mcpOff });
          this.refresh();
        },
      });
    }
    items.push(
      { sep: true },
      { title: 'Project' },
      { label: 'Working folder', desc: `${this.app.currentCwd()} · picks the project notes`, icon: 'folder', onClick: () => this.app.pickFolder() },
      { label: 'Project notes', desc: 'What the model wrote down: done / open / needs fixing', icon: 'fileEdit', onClick: () => this.app.openNotes() },
      { label: 'Claude memory', desc: 'Read-only for the local model', icon: 'brain', onClick: () => this.app.openMemory() },
      { label: 'Background processes', desc: running ? `${running} running` : 'none running', icon: 'terminal', onClick: () => this.app.processesMenu(this.toolsBtn) },
      { sep: true },
      { label: 'Edit config.json', icon: 'wrench', onClick: () => window.aster.openConfig() },
      { label: 'Tool settings', icon: 'settings', onClick: () => this.app.openSettings('tools') },
    );
    openMenu(this.toolsBtn, items, { placement: 'auto' });
  }
}
