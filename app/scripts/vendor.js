// Bundles the renderer's libraries (marked, DOMPurify, highlight.js, KaTeX) into
// src/renderer/vendor and copies KaTeX's stylesheet + fonts:  node scripts/vendor.js
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const out = path.join(root, 'src', 'renderer', 'vendor');
fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'vendor-entry.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'chrome130',
  outfile: path.join(out, 'vendor.js'),
  legalComments: 'none',
});

const katexDist = path.join(root, 'node_modules', 'katex', 'dist');
fs.copyFileSync(path.join(katexDist, 'katex.min.css'), path.join(out, 'katex.min.css'));
for (const f of fs.readdirSync(path.join(katexDist, 'fonts'))) {
  if (f.endsWith('.woff2')) fs.copyFileSync(path.join(katexDist, 'fonts', f), path.join(out, 'fonts', f));
}
console.log('vendor bundle written to', out);
