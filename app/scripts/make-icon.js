// Draws Aster's app icon (the spark on a clay tile) without any image library, every size on
// its own so small ones stay crisp:  node scripts/make-icon.js
// writes assets/icon.png (256 px), assets/icon.ico (16-256 px) and assets/icons/<size>.png.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const TILE_TOP = [58, 62, 74];
const TILE_BOTTOM = [30, 32, 40];
const MARK = [232, 138, 104];
const RAYS = [1, 0.72, 0.9, 0.66, 0.96, 0.7, 0.86, 0.64, 1, 0.74, 0.88, 0.68];

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function roundBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// distance to a ray that is w0 wide at the center and tapers to w1 at its tip
function taper(px, py, cx, cy, ang, len, w0, w1) {
  const dx = Math.sin(ang);
  const dy = -Math.cos(ang);
  const ux = px - cx;
  const uy = py - cy;
  const t = clamp((ux * dx + uy * dy) / len);
  const qx = ux - dx * len * t;
  const qy = uy - dy * len * t;
  return Math.hypot(qx, qy) - (w0 + (w1 - w0) * t);
}

function render(S) {
  const px = Buffer.alloc(S * S * 4);
  const small = S <= 24;
  const inset = S <= 32 ? 0 : S * 0.03;
  const half = S / 2 - inset;
  const radius = S * (small ? 0.2 : 0.23);
  const c = S / 2;
  const reach = S * (small ? 0.4 : 0.36);
  const w0 = Math.max(S * 0.045, small ? 1.1 : 0.9);
  const rays = small ? RAYS.filter((_, i) => i % 2 === 0) : RAYS;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const X = x + 0.5;
      const Y = y + 0.5;
      const dTile = roundBox(X, Y, c, c, half, half, radius);
      const aTile = clamp(0.5 - dTile);
      let col = mix(TILE_TOP, TILE_BOTTOM, clamp(Y / S));
      let d = Infinity;
      rays.forEach((len, i) => {
        const ang = (i * 2 * Math.PI) / rays.length;
        const L = reach * (0.3 + 0.7 * len);
        d = Math.min(d, taper(X, Y, c, c, ang, L, w0, small ? 0.45 : 0.25));
      });
      const aMark = clamp(0.5 - d);
      col = mix(col, MARK, aMark);
      const i = (y * S + x) * 4;
      px[i] = Math.round(col[0]);
      px[i + 1] = Math.round(col[1]);
      px[i + 2] = Math.round(col[2]);
      px[i + 3] = Math.round(255 * aTile);
    }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let k = n;
  for (let i = 0; i < 8; i++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1;
  return k >>> 0;
});
const crc = (b) => {
  let k = 0xffffffff;
  for (const v of b) k = crcTable[(k ^ v) & 255] ^ (k >>> 8);
  return (k ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const cc = Buffer.alloc(4);
  cc.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, cc]);
};

function png(S, px) {
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function ico(images) {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size;
    head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((im) => im.data)]);
}

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const assets = path.join(__dirname, '..', 'assets');
const dir = path.join(assets, 'icons');
fs.mkdirSync(dir, { recursive: true });
const images = SIZES.map((size) => ({ size, data: png(size, render(size)) }));
for (const im of images) fs.writeFileSync(path.join(dir, `${im.size}.png`), im.data);
fs.writeFileSync(path.join(assets, 'icon.png'), images.find((im) => im.size === 256).data);
fs.writeFileSync(path.join(assets, 'icon.ico'), ico(images));
console.log(`icons written to ${assets} (${SIZES.join(', ')} px)`);
