// Small UI building blocks: element helper, popover menus, modals, dialogs, toasts, lightbox.
import { icon } from './icons.js';
import { esc } from './markdown.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ---------------------------------------------------------------- menus

let openMenuEl = null;
let closeOpenMenu = null;

export function closeMenu() {
  if (closeOpenMenu) closeOpenMenu();
}

/**
 * items: { label, desc, icon, check, danger, onClick, toggle: bool, dot, keepOpen } | { sep: true } |
 *        { title } | { note } | { el: Node }
 */
export function openMenu(anchor, items, opts = {}) {
  const wasSame = openMenuEl && openMenuEl._anchor === anchor;
  closeMenu();
  if (wasSame && !opts.force) return null;
  const menu = h('div', { class: 'menu', role: 'menu' });
  menu._anchor = anchor;
  const buttons = [];
  for (const it of items) {
    if (!it) continue;
    if (it.sep) menu.append(h('div', { class: 'menu-sep' }));
    else if (it.title) menu.append(h('div', { class: 'menu-title', text: it.title }));
    else if (it.note) menu.append(h('div', { class: 'menu-note', text: it.note }));
    else if (it.el) menu.append(it.el);
    else {
      const b = h('button', { class: `menu-item${it.danger ? ' danger' : ''}`, role: 'menuitem' });
      let html = '';
      if (it.dot) html += `<span class="dot ${it.dot}"></span>`;
      else if (it.icon) html += icon(it.icon, 17);
      html += `<span class="grow">${esc(it.label)}${it.desc ? `<span class="d">${esc(it.desc)}</span>` : ''}</span>`;
      if (it.toggle != null) html += `<span class="toggle${it.toggle ? ' on' : ''}"></span>`;
      if (it.check) html += `<span class="chk">${icon('check', 16)}</span>`;
      if (it.right) html += `<span class="d">${esc(it.right)}</span>`;
      b.innerHTML = html;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (it.toggle != null) {
          b.querySelector('.toggle')?.classList.toggle('on');
        }
        if (!it.keepOpen && it.toggle == null) closeMenu();
        it.onClick?.(e, b);
      });
      buttons.push(b);
      menu.append(b);
    }
  }
  document.body.append(menu);
  position(menu, anchor, opts);
  openMenuEl = menu;
  anchor.classList.add('open');

  let focus = -1;
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenu();
      anchor.focus?.();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focus = (focus + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons.forEach((b, i) => b.classList.toggle('focus', i === focus));
      buttons[focus]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && focus >= 0) {
      e.preventDefault();
      buttons[focus].click();
    }
  };
  const onDown = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu();
  };
  const onResize = () => closeMenu();
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onResize);
  });
  closeOpenMenu = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onResize);
    anchor.classList.remove('open');
    menu.remove();
    openMenuEl = null;
    closeOpenMenu = null;
    opts.onClose?.();
  };
  return menu;
}

function position(menu, anchor, opts) {
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 6;
  let top;
  const spaceBelow = vh - r.bottom;
  const above = opts.placement === 'above' || (opts.placement !== 'below' && spaceBelow < m.height + 20 && r.top > spaceBelow);
  if (above) top = Math.max(8, r.top - m.height - gap);
  else {
    top = Math.min(vh - m.height - 8, r.bottom + gap);
    menu.classList.add('down');
  }
  let left = opts.align === 'right' ? r.right - m.width : r.left;
  left = Math.max(8, Math.min(vw - m.width - 8, left));
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

// ---------------------------------------------------------------- modals

export function openModal(content, opts = {}) {
  const overlay = h('div', { class: 'overlay' });
  overlay.append(content);
  document.body.append(overlay);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 170);
    opts.onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.menu')) {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  return close;
}

export function confirmDialog({ title, body, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const ok = h('button', { class: `btn ${danger ? 'danger' : 'dark'}`, text: confirm });
    const cancel = h('button', { class: 'btn ghost', text: 'Cancel' });
    const box = h('div', { class: 'modal small' }, h('h3', { text: title }), body ? h('p', { text: body }) : null, h('div', { class: 'row' }, cancel, ok));
    const close = openModal(box, { onClose: () => resolve(result) });
    ok.onclick = () => {
      result = true;
      close();
    };
    cancel.onclick = close;
    setTimeout(() => ok.focus(), 50);
  });
}

export function promptDialog({ title, value = '', confirm = 'Save', placeholder = '' }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', { class: 'input', value, placeholder });
    const ok = h('button', { class: 'btn dark', text: confirm });
    const cancel = h('button', { class: 'btn ghost', text: 'Cancel' });
    const box = h('div', { class: 'modal small' }, h('h3', { text: title }), input, h('div', { class: 'row' }, cancel, ok));
    const close = openModal(box, { onClose: () => resolve(result) });
    const submit = () => {
      result = input.value;
      close();
    };
    ok.onclick = submit;
    cancel.onclick = close;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
  });
}

// ---------------------------------------------------------------- toast + lightbox

export function toast(message, opts = {}) {
  const wrap = document.getElementById('toasts');
  const t = h('div', { class: `toast${opts.error ? ' err' : ''}`, text: message });
  wrap.append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 260);
  }, opts.ms || (opts.error ? 5000 : 2400));
}

export function lightbox(src) {
  const lb = h('div', { class: 'lightbox' }, h('img', { src }));
  const close = () => {
    lb.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  lb.onclick = close;
  document.addEventListener('keydown', onKey, true);
  document.body.append(lb);
}

export async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const old = btn.innerHTML;
      btn.classList.add('copied');
      btn.innerHTML = icon('check', btn.querySelector('svg')?.getAttribute('width') || 16) + (btn.querySelector('span') ? '<span>Copied</span>' : '');
      setTimeout(() => {
        btn.innerHTML = old;
        btn.classList.remove('copied');
      }, 1400);
    } else toast('Copied');
  } catch {
    toast("Couldn't copy", { error: true });
  }
}

export function fmtCost(n) {
  if (!n) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}
