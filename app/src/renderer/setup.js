// "Set up for this PC": shows the hardware the app found, the model it would run in each mode
// on that hardware, and downloads what is missing. Opens by itself on a PC where the app cannot
// work yet (no Ollama, or a mode without its model), and from Settings -> Local models.
// Nothing is changed until Apply is pressed.
import { h, openModal, toast } from './ui.js';

const gb = (mb) => {
  const v = mb / 1024;
  return `${v >= 10 || Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : v.toFixed(1)} GB`;
};
const ctxLabel = (n) => `${Math.round(n / 1024)}k context`;

function whereText(c, hw) {
  if (c.tooBig) return 'too big for this PC';
  if (c.where === 'gpu') return 'fits on the graphics card';
  if (c.where === 'split') return `partly in RAM (about ${gb(c.spillMb)}), slower`;
  return hw.gpu ? 'runs on the CPU, slow' : 'runs on the CPU';
}

let open = false;

/** `override` replaces the detected hardware; only the test API honours it. */
export async function openSetup(app, override) {
  if (open) return;
  open = true;
  const box = h('div', { class: 'modal small setup' });
  const close = openModal(box, { onClose: () => (open = false) });
  box.append(h('h3', { text: 'Set up for this PC' }), h('p', { text: 'Checking the hardware…' }));
  let plan;
  try {
    plan = await window.aster.setupPlan(override);
  } catch (e) {
    box.replaceChildren(h('h3', { text: 'Set up for this PC' }), h('p', { text: `The hardware check failed: ${e.message}` }), h('div', { class: 'row' }, h('button', { class: 'btn ghost', text: 'Close', onclick: close })));
    return;
  }
  draw(app, box, close, plan, override);
}

function draw(app, box, close, plan, override) {
  const hw = plan.hw;
  const modes = Object.keys(plan.modes);
  // what the user picked per mode: starts at the recommendation
  const picked = Object.fromEntries(modes.map((id) => [id, plan.modes[id].pick.base]));
  const choice = (id) => plan.modes[id].choices.find((c) => c.base === picked[id]);

  const card = hw.gpu
    ? `${hw.gpu.name} · ${gb(hw.gpu.vramMb)}${plan.card ? '' : ' (too little for the models)'}`
    : 'none found with its own memory';
  const disk = hw.disk?.freeMb != null ? `${gb(hw.disk.freeMb)} free where Ollama keeps its models` : 'unknown';
  const facts = h(
    'div',
    { class: 'setup-facts' },
    h('div', {}, h('span', { text: 'Graphics card' }), h('b', { text: card })),
    h('div', {}, h('span', { text: 'RAM' }), h('b', { text: gb(hw.ramMb) })),
    h('div', {}, h('span', { text: 'Processor' }), h('b', { text: `${hw.cpu.name} · ${hw.cpu.cores} threads` })),
    h('div', {}, h('span', { text: 'Disk' }), h('b', { text: disk })),
  );

  const status = h('div', { class: 'hint setup-status' });
  const bar = h('div', { class: 'pull-bar', hidden: true }, h('i'));
  const applyBtn = h('button', { class: 'btn dark' });
  const laterBtn = h('button', { class: 'btn ghost', text: plan.needed ? 'Not now' : 'Close' });
  const rows = h('div', { class: 'setup-modes' });

  const missing = () => [...new Set(modes.map((id) => choice(id)).filter((c) => !c.installed).map((c) => c.base))];
  const downloadMb = () => missing().reduce((s, base) => s + (modes.map((id) => choice(id)).find((c) => c.base === base)?.sizeMb || 0), 0);
  const unchanged = () => modes.every((id) => plan.modes[id].current.base.toLowerCase() === picked[id].toLowerCase() && plan.modes[id].current.ctx === choice(id).ctx);

  const refresh = () => {
    const need = missing();
    const mb = downloadMb();
    const noRoom = hw.disk?.freeMb != null && mb > hw.disk.freeMb - 2048;
    applyBtn.disabled = !plan.ollama.ok || noRoom || (unchanged() && !need.length);
    applyBtn.textContent = need.length ? `Download ${gb(mb)} and apply` : 'Apply';
    if (!plan.ollama.ok) status.textContent = '';
    else if (noRoom) status.textContent = `Not enough free disk space for ${gb(mb)} of downloads.`;
    else if (need.length) status.textContent = `To download: ${need.join(', ')}. Needs internet once.`;
    else if (unchanged()) status.textContent = 'This is the setup you already use.';
    else status.textContent = 'Everything needed is installed already.';
    status.classList.toggle('over', !!noRoom);
  };

  for (const id of modes) {
    const m = plan.modes[id];
    const sel = h('select', { class: 'select' });
    for (const c of m.choices) {
      sel.append(h('option', { value: c.base, text: `${c.base} · ${gb(c.sizeMb)}${c.base === m.pick.base ? ' · recommended' : ''}`, selected: c.base === picked[id], disabled: c.tooBig }));
    }
    const info = h('div', { class: 'hint' });
    const drawInfo = () => {
      const c = choice(id);
      const now = m.current.base.toLowerCase() === c.base.toLowerCase() ? '' : ` · now: ${m.current.base}${m.current.installed ? '' : ' (not installed)'}`;
      info.textContent = `${whereText(c, hw)} · ${ctxLabel(c.ctx)} · ${c.installed ? 'installed' : 'needs a download'}${now}`;
    };
    sel.onchange = () => {
      picked[id] = sel.value;
      drawInfo();
      refresh();
    };
    drawInfo();
    rows.append(h('div', { class: 'setup-mode', 'data-mode': id }, h('b', { text: m.name }), sel, info));
  }

  const ollamaNote = plan.ollama.ok
    ? null
    : h(
        'div',
        { class: 'notice error' },
        h('span', {
          class: 'grow',
          text: plan.ollama.found
            ? 'Ollama is installed but did not start. Start it, then check again.'
            : 'Ollama is not installed. It is the program that runs the models: install it, then check again.',
        }),
        plan.ollama.found ? null : h('button', { class: 'btn ghost sm', text: 'Get Ollama', onclick: () => window.aster.openExternal('https://ollama.com/download') }),
        h('button', {
          class: 'btn ghost sm',
          text: 'Check again',
          onclick: async () => {
            box.replaceChildren(h('h3', { text: 'Set up for this PC' }), h('p', { text: 'Checking…' }));
            draw(app, box, close, await window.aster.setupPlan(override), override);
          },
        }),
      );

  const notes = plan.notes.map((n) => h('div', { class: 'hint', text: n }));
  if (hw.gpu && plan.card && hw.gpu.vendor && hw.gpu.vendor !== 'nvidia') {
    notes.push(h('div', { class: 'hint', text: 'This was only tested with NVIDIA cards. Whether Ollama uses this card is up to Ollama; if answers turn out slow, the app tells you after the first ones.' }));
  }
  if (!plan.colibri.available) notes.push(h('div', { class: 'hint', text: 'The Coder 30B mode is hidden until the colibrì engine and a model for it are on this PC (Settings, Local models).' }));

  let busy = false;
  applyBtn.onclick = async () => {
    if (busy) {
      window.aster.cancelPull();
      return;
    }
    busy = true;
    laterBtn.disabled = true;
    rows.querySelectorAll('select').forEach((s) => (s.disabled = true));
    const todo = missing();
    let failed = null;
    if (todo.length) {
      applyBtn.textContent = 'Cancel download';
      bar.hidden = false;
      let name = '';
      let n = 0;
      const off = window.aster.on('ollama:pull', (p) => {
        status.textContent = `${name} (${n} of ${todo.length}): ${p.status}${p.percent != null ? ` · ${p.percent}%` : ''}`;
        if (p.percent != null) bar.firstChild.style.width = `${p.percent}%`;
      });
      for (name of todo) {
        n++;
        bar.firstChild.style.width = '0';
        status.textContent = `${name} (${n} of ${todo.length}): starting…`;
        const r = await window.aster.pullModel(name);
        if (!r.ok) {
          failed = `${name}: ${r.error}`;
          break;
        }
      }
      off();
      bar.hidden = true;
    }
    // modes whose model is there are saved even when a later download failed
    const res = await window.aster.setupApply(Object.fromEntries(modes.map((id) => [id, { base: picked[id], ctx: choice(id).ctx }])));
    await app.reloadState();
    app.refreshSettingsPage?.();
    busy = false;
    if (failed || res.skipped.length) {
      // show what happened and let the user try again with the new state
      const next = await window.aster.setupPlan(override);
      box.replaceChildren();
      draw(app, box, close, next, override);
      const s = box.querySelector('.setup-status');
      s.textContent = `${failed || 'Some models are still missing.'}${res.saved.length ? ` Saved so far: ${res.saved.map((id) => plan.modes[id].name).join(', ')}.` : ''}`;
      s.classList.add('over');
      return;
    }
    close();
    toast(res.warnings.length ? res.warnings.join(' ') : 'Models set for this PC', { ms: res.warnings.length ? 9000 : 3500 });
  };
  laterBtn.onclick = async () => {
    if (plan.needed) await window.aster.setupDismiss();
    close();
  };

  box.replaceChildren(
    ...[
      h('h3', { text: 'Set up for this PC' }),
      h('p', { text: 'The app picks a model for each mode from what this PC can run. Change any of them if you like; you can also do that later in Settings.' }),
      facts,
      ollamaNote,
      rows,
      ...notes,
      bar,
      status,
      h('div', { class: 'row' }, laterBtn, applyBtn),
    ].filter(Boolean),
  );
  refresh();
}
