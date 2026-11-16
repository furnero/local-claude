// Line icons (24-unit grid, drawn with currentColor) and Aster's spark mark.
const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrowUp: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.2A1.7 1.7 0 0 0 13.8 4.5H6.2A1.7 1.7 0 0 0 4.5 6.2v7.6a1.7 1.7 0 0 0 1.7 1.7h2.3"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  retry: '<path d="M4.5 12a7.5 7.5 0 0 1 12.9-5.2L19.5 9M19.5 4.5V9H15"/><path d="M19.5 12a7.5 7.5 0 0 1-12.9 5.2L4.5 15M4.5 19.5V15H9"/>',
  pencil: '<path d="M14.5 5.5 18.5 9.5M4.5 19.5l1-4.5L15.8 4.7a1.8 1.8 0 0 1 2.5 0l1 1a1.8 1.8 0 0 1 0 2.5L9 18.5z"/>',
  trash: '<path d="M4.5 7h15M9.5 7V5.2c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V7M6.5 7l.8 11.4c.1 1.1 1 1.9 2 1.9h5.4c1 0 1.9-.8 2-1.9L17.5 7"/>',
  star: '<path d="m12 4.5 2.3 4.7 5.2.8-3.8 3.7.9 5.2L12 16.4l-4.6 2.5.9-5.2-3.8-3.7 5.2-.8z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l1.6-1.3-1.6-2.8-2 .7a7.5 7.5 0 0 0-2.6-1.5L14.5 3.5h-3.2l-.4 2.1a7.5 7.5 0 0 0-2.6 1.5l-2-.7-1.6 2.8 1.6 1.3a7.6 7.6 0 0 0 0 3l-1.6 1.3 1.6 2.8 2-.7a7.5 7.5 0 0 0 2.6 1.5l.4 2.1h3.2l.4-2.1a7.5 7.5 0 0 0 2.6-1.5l2 .7 1.6-2.8z"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="m10.5 12.5 8-8M16 7l2.5 2.5M14 9l1.5 1.5"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5"/>',
  file: '<path d="M13.5 3.5H7.2c-.9 0-1.7.8-1.7 1.7v13.6c0 .9.8 1.7 1.7 1.7h9.6c.9 0 1.7-.8 1.7-1.7V8.5z"/><path d="M13.5 3.5v5h5"/>',
  fileEdit: '<path d="M13.5 3.5H7.2c-.9 0-1.7.8-1.7 1.7v13.6c0 .9.8 1.7 1.7 1.7h3.3"/><path d="M13.5 3.5v5h5v2"/><path d="m14 20.5.5-2.5 4.6-4.6a1.2 1.2 0 0 1 1.7 1.7l-4.6 4.6z"/>',
  folder: '<path d="M3.5 7.2c0-.9.8-1.7 1.7-1.7h4l2 2.2h7.6c.9 0 1.7.8 1.7 1.7v8.4c0 .9-.8 1.7-1.7 1.7H5.2c-.9 0-1.7-.8-1.7-1.7z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M17.5 14v4.3c0 .7-.5 1.2-1.2 1.2H5.7c-.7 0-1.2-.5-1.2-1.2V7.7c0-.7.5-1.2 1.2-1.2H10"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  code: '<path d="m8.5 7.5-5 4.5 5 4.5M15.5 7.5l5 4.5-5 4.5"/>',
  dots: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>',
  unlink: '<path d="M9.5 14.5 14.5 9.5M8 11 5.6 13.4a3.5 3.5 0 0 0 5 5L13 16M16 13l2.4-2.4a3.5 3.5 0 0 0-5-5L11 8M4 4l2.5 2.5M20 20l-2.5-2.5"/>',
  alert: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4.5M12 17.2v.1"/>',
  paperclip: '<path d="m19 11.5-7.4 7.4a4.6 4.6 0 0 1-6.5-6.5l7.7-7.7a3.1 3.1 0 0 1 4.4 4.4l-7.6 7.6a1.5 1.5 0 0 1-2.2-2.2l7-7"/>',
  sliders: '<path d="M4.5 7.5h9M17.5 7.5h2M4.5 16.5h2M10.5 16.5h9"/><circle cx="15.5" cy="7.5" r="2"/><circle cx="8.5" cy="16.5" r="2"/>',
  plug: '<path d="M9 3.5V8M15 3.5V8M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5v4"/>',
  chat: '<path d="M5 18.5V7.2c0-1 .8-1.7 1.7-1.7h10.6c1 0 1.7.8 1.7 1.7v7.6c0 1-.8 1.7-1.7 1.7H8.5z"/>',
  newChat: '<path d="M11 4.5H6.2c-.9 0-1.7.8-1.7 1.7v11.6c0 .9.8 1.7 1.7 1.7h11.6c.9 0 1.7-.8 1.7-1.7V13"/><path d="M17.5 3.5v6M14.5 6.5h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  chart: '<path d="M4.5 19.5h15M7.5 16v-4M12 16V7.5M16.5 16v-6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.1"/>',
  brain: '<path d="M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.3A3 3 0 0 0 7.5 18a2.5 2.5 0 0 0 4.5 1.3V6a2.3 2.3 0 0 0-3-1.5zM15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.3 3 3 0 0 1-3 5.2 2.5 2.5 0 0 1-4.5 1.3"/>',
  download: '<path d="M12 4.5v11M7 11l5 5 5-5M5 19.5h14"/>',
  wrench: '<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5a4 4 0 0 0-2-2z"/>',
};

export function icon(name, size = 18, extraClass = '') {
  return `<svg class="ic ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

// Aster's spark: twelve tapered rays of uneven length around a small core. Each ray is its own
// group so CSS can animate them one by one while Claude is working.
const RAYS = [1, 0.72, 0.9, 0.66, 0.96, 0.7, 0.86, 0.64, 1, 0.74, 0.88, 0.68];
export function spark(size = 28, extraClass = '') {
  const rays = RAYS.map((len, i) => {
    const a = (i * 360) / RAYS.length;
    const L = 3.2 + 7.6 * len;
    return `<g class="ray" style="--i:${i}" transform="rotate(${a} 12 12)"><path d="M12 ${12 - L} C ${12 + 1.15} ${12 - L * 0.55}, ${12 + 0.9} ${12 - 2.2}, 12 12 C ${12 - 0.9} ${12 - 2.2}, ${12 - 1.15} ${12 - L * 0.55}, 12 ${12 - L} Z"/></g>`;
  }).join('');
  return `<svg class="spark ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><g class="spark-rays" fill="currentColor">${rays}</g></svg>`;
}
