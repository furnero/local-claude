// node test/hardware.test.js
// The recommendation per hardware. The first case is the PC this app was built on: it must
// keep getting the setup that was tuned and measured there.
const { recommend, place, footprintMb, stepDown } = require('../src/main/hardware');

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const GB = 1024;
const show = (r) => ['quick', 'smart', 'coder'].map((m) => `${r.modes[m].base}@${r.modes[m].ctx / 1024}k/${r.modes[m].where}`).join('  ');
function expect(name, hw, want) {
  const r = recommend(hw);
  const ok = ['quick', 'smart', 'coder'].every((m) => {
    const [base, ctx, where] = want[m];
    return r.modes[m].base === base && r.modes[m].ctx === ctx && r.modes[m].where === where;
  });
  check(name, ok, show(r));
  return r;
}
const card = (vramGb, ramGb, name = 'Test card') => ({ gpu: { name, vramMb: vramGb * GB }, ramMb: ramGb * GB });

// the measured point: the 9B with a 49k context took 7.6 GB, 5.4 on the 8 GB card and 2.2 in RAM
check('footprint of the 9B at 49k is about 7.6 GB', Math.abs(footprintMb(6600, 49152) - 7780) < 150, `${footprintMb(6600, 49152)} MB`);
const p = place(6600, 49152, 8192);
check('the 9B on an 8 GB card is split, about 2.2 GB in RAM', p.where === 'split' && Math.abs(p.spillMb - 2250) < 300, `${p.where} ${p.spillMb} MB`);

expect('GTX 1070 (8 GB) + 16 GB RAM: unchanged defaults', card(8, 16), {
  quick: ['qwen3.5:4b', 49152, 'gpu'],
  smart: ['qwen3.5:9b', 49152, 'split'],
  coder: ['huihui_ai/qwen3.5-abliterated:9b-OmniCoder', 49152, 'split'],
});
expect('the same PC as Windows reports it (16,178 MB of RAM)', { gpu: { name: 'GeForce GTX 1070', vramMb: 8192 }, ramMb: 16178 }, {
  quick: ['qwen3.5:4b', 49152, 'gpu'],
  smart: ['qwen3.5:9b', 49152, 'split'],
  coder: ['huihui_ai/qwen3.5-abliterated:9b-OmniCoder', 49152, 'split'],
});
expect('8 GB card but only 8 GB RAM: nothing may spill into RAM', card(8, 8), {
  quick: ['qwen3.5:4b', 49152, 'gpu'],
  smart: ['qwen3.5:4b', 49152, 'gpu'],
  coder: ['huihui_ai/qwen3.5-abliterated:4B', 49152, 'gpu'],
});
expect('6 GB card', card(6, 16), {
  quick: ['qwen3.5:4b', 49152, 'gpu'],
  smart: ['qwen3.5:4b', 49152, 'gpu'],
  coder: ['huihui_ai/qwen3.5-abliterated:4B', 49152, 'gpu'],
});
expect('12 GB card: the 9B fits completely, Quick takes the size below', card(12, 16), {
  quick: ['qwen3.5:4b', 49152, 'gpu'],
  smart: ['qwen3.5:9b', 49152, 'gpu'],
  coder: ['huihui_ai/qwen3.5-abliterated:9b-OmniCoder', 49152, 'gpu'],
});
expect('16 GB card: a 27B would put far too much on the CPU, stays at 9B', card(16, 32), {
  quick: ['qwen3.5:4b', 49152, 'gpu'],
  smart: ['qwen3.5:9b', 49152, 'gpu'],
  coder: ['huihui_ai/qwen3.5-abliterated:9b-OmniCoder', 49152, 'gpu'],
});
expect('24 GB card: 27B models, completely on the card', card(24, 32), {
  quick: ['qwen3.5:9b', 49152, 'gpu'],
  smart: ['qwen3.5:27b', 49152, 'gpu'],
  coder: ['huihui_ai/qwen3.5-abliterated:27b', 49152, 'gpu'],
});
expect('32 GB card', card(32, 64), {
  quick: ['qwen3.5:9b', 49152, 'gpu'],
  smart: ['qwen3.5:27b', 49152, 'gpu'],
  coder: ['huihui_ai/qwen3.5-abliterated:27b', 49152, 'gpu'],
});
const none16 = expect('no graphics card, 16 GB RAM: small models on the CPU', { gpu: null, ramMb: 16 * GB }, {
  quick: ['qwen3.5:2b', 32768, 'cpu'],
  smart: ['qwen3.5:4b', 32768, 'cpu'],
  coder: ['huihui_ai/qwen3.5-abliterated:4B', 32768, 'cpu'],
});
check('the CPU case says so in a note', none16.notes.some((n) => /CPU/.test(n)) && none16.card === false);
expect('no graphics card, 8 GB RAM: the smallest models', { gpu: null, ramMb: 8 * GB }, {
  quick: ['qwen3.5:0.8b', 16384, 'cpu'],
  smart: ['qwen3.5:0.8b', 16384, 'cpu'],
  coder: ['huihui_ai/qwen3.5-abliterated:0.8B', 16384, 'cpu'],
});
const onboard = expect('onboard chip with 2 GB counts as no card', { gpu: { name: 'Intel UHD Graphics', vramMb: 2048 }, ramMb: 16 * GB }, {
  quick: ['qwen3.5:2b', 32768, 'cpu'],
  smart: ['qwen3.5:4b', 32768, 'cpu'],
  coder: ['huihui_ai/qwen3.5-abliterated:4B', 32768, 'cpu'],
});
check('the note names the onboard chip', onboard.notes.some((n) => /Intel UHD Graphics/.test(n)));
const r4 = recommend(card(4, 16));
check('4 GB card: Quick fits completely, nothing bigger than the 4B anywhere', r4.modes.quick.where === 'gpu' && Object.values(r4.modes).every((m) => m.sizeMb <= 3400), show(r4));

// never recommend more spill than the limits, on any card size
let worst = '';
for (let gb = 3; gb <= 96; gb++) {
  for (const ram of [8, 16, 32, 64]) {
    const r = recommend(card(gb, ram));
    for (const m of Object.values(r.modes)) if (m.where === 'split' && (m.spillMb > 2560 || m.spillMb > ram * GB - 8192)) worst = `${gb} GB card, ${ram} GB RAM: ${m.base} spills ${m.spillMb} MB`;
    if (r.modes.quick.where === 'split') worst = `${gb} GB card: Quick is split`;
  }
}
check('no card size gets a model that reaches far into RAM, and Quick is never split', !worst, worst);

check('step down from the 9B in Smart is the 4B', stepDown('smart', 'qwen3.5:9b') === 'qwen3.5:4b', String(stepDown('smart', 'qwen3.5:9b')));
check('step down ignores letter case of the tag', stepDown('coder', 'huihui_ai/qwen3.5-abliterated:4b') === 'huihui_ai/qwen3.5-abliterated:2B');
check('nothing below the smallest, and nothing for an unknown model', stepDown('quick', 'qwen3.5:0.8b') === null && stepDown('smart', 'somebody/else:7b') === null);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
