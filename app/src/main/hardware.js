// What this PC can run. Two parts:
//   probe()      reads the graphics cards, RAM, CPU and free disk space
//   recommend()  picks a model and context size per mode for that hardware (a pure function,
//                tested in test/hardware.test.js)
// The recommendation is a starting point shown in the setup dialog; nothing is changed until the
// user applies it. What Ollama reports after a model is loaded stays the truth (see chat.js).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MB = 1048576;

// ---------------------------------------------------------------- the models to choose from

// Biggest first. Sizes are the download sizes in the Ollama library (checked 2026-11-17); every
// tag here lists tool support there. Quick stops at 9B: a fast answer matters more than size.
const QWEN = [
  { base: 'qwen3.5:122b', sizeMb: 81000 },
  { base: 'qwen3.5:27b', sizeMb: 17000 },
  { base: 'qwen3.5:9b', sizeMb: 6600 },
  { base: 'qwen3.5:4b', sizeMb: 3400 },
  { base: 'qwen3.5:2b', sizeMb: 2700 },
  { base: 'qwen3.5:0.8b', sizeMb: 1200 },
];
const LADDERS = {
  quick: QWEN.filter((m) => m.sizeMb <= 6600),
  smart: QWEN,
  // the same family with the refusals removed; the 9B is the coding fine-tune
  coder: [
    { base: 'huihui_ai/qwen3.5-abliterated:27b', sizeMb: 17000 },
    { base: 'huihui_ai/qwen3.5-abliterated:9b-OmniCoder', sizeMb: 6400 },
    { base: 'huihui_ai/qwen3.5-abliterated:4B', sizeMb: 3300 },
    { base: 'huihui_ai/qwen3.5-abliterated:2B', sizeMb: 1900 },
    { base: 'huihui_ai/qwen3.5-abliterated:0.8B', sizeMb: 1000 },
  ],
};

const MIN_CARD_MB = 3000; // less than this is an onboard chip: treated as "no graphics card"

// ---------------------------------------------------------------- how a model sits in memory

/**
 * Memory a loaded model takes: the file, the working memory for the context (grows with the
 * model) and a little overhead. Matches the one measured point: the 9B with a 49k context
 * took 7.6 GB in total on the GTX 1070.
 */
function footprintMb(sizeMb, ctx) {
  return Math.round(sizeMb + (ctx / 1024) * (8 + sizeMb / 550) + 200);
}

/**
 * Where a model of that size ends up. Ollama keeps a reserve on the card, and a model that
 * does not fit completely gets clearly less than the whole card (measured: 5.4 of 8 GB).
 */
function place(sizeMb, ctx, vramMb) {
  const need = footprintMb(sizeMb, ctx);
  if (!vramMb || vramMb < MIN_CARD_MB) return { where: 'cpu', needMb: need, spillMb: need };
  if (need <= vramMb - Math.max(1024, vramMb * 0.12)) return { where: 'gpu', needMb: need, spillMb: 0 };
  return { where: 'split', needMb: need, spillMb: Math.round(need - vramMb * 0.68) };
}

// ---------------------------------------------------------------- the recommendation

const GPU_CTX = [49152, 32768]; // tried in this order when looking for a full fit
const MAX_SPILL_MB = 2560; // a model may reach this far into normal RAM (the 9B on an 8 GB card does)
const MAX_SPILL_SHARE = 0.3;

function pickForCard(ladder, vramMb, ramMb, allowSpill) {
  for (const m of ladder) {
    for (const ctx of GPU_CTX) {
      const p = place(m.sizeMb, ctx, vramMb);
      if (p.where === 'gpu') return { ...m, ctx, ...p };
    }
    if (!allowSpill) continue;
    const p = place(m.sizeMb, GPU_CTX[0], vramMb);
    if (p.spillMb <= MAX_SPILL_MB && p.spillMb <= p.needMb * MAX_SPILL_SHARE && p.spillMb <= Math.max(0, ramMb - 8192)) return { ...m, ctx: GPU_CTX[0], ...p };
  }
  const last = ladder[ladder.length - 1];
  return { ...last, ctx: 16384, ...place(last.sizeMb, 16384, vramMb) };
}

function pickForCpu(ladder, budgetMb, ctx) {
  for (const m of ladder) {
    const need = footprintMb(m.sizeMb, ctx);
    if (need <= budgetMb) return { ...m, ctx, where: 'cpu', needMb: need, spillMb: need };
  }
  const last = ladder[ladder.length - 1];
  return { ...last, ctx: 16384, where: 'cpu', needMb: footprintMb(last.sizeMb, 16384), spillMb: footprintMb(last.sizeMb, 16384) };
}

/**
 * hw: { gpu: { name, vramMb } | null, ramMb }
 * Returns { modes: { quick, smart, coder }, card, notes } where each mode is
 * { base, sizeMb, ctx, where: 'gpu' | 'split' | 'cpu', needMb, spillMb }.
 */
function recommend(hw) {
  const ramMb = Number(hw?.ramMb) || 8192;
  const vramMb = Number(hw?.gpu?.vramMb) || 0;
  const card = vramMb >= MIN_CARD_MB;
  const notes = [];
  let quick;
  let smart;
  let coder;
  if (card) {
    smart = pickForCard(LADDERS.smart, vramMb, ramMb, true);
    coder = pickForCard(LADDERS.coder, vramMb, ramMb, true);
    quick = pickForCard(LADDERS.quick, vramMb, ramMb, false);
    // Quick should be the faster one: with a 9B or bigger as Smart it takes the next size down
    if (quick.base === smart.base && smart.sizeMb >= 6600) {
      const i = LADDERS.quick.findIndex((m) => m.base === quick.base);
      if (LADDERS.quick[i + 1]) quick = pickForCard(LADDERS.quick.slice(i + 1), vramMb, ramMb, false);
    }
    if ([quick, smart, coder].some((m) => m.where === 'split')) notes.push('Models marked "partly in RAM" are bigger than the card can hold: they work, but answer slower than the ones that fit.');
  } else {
    // everything runs on the CPU out of normal RAM: small models, smaller context
    const budget = Math.max(0, ramMb - 5120) * 0.6;
    const ctx = ramMb >= 15000 ? 32768 : 16384;
    const upTo = (ladder, maxMb) => ladder.filter((m) => m.sizeMb <= maxMb);
    smart = pickForCpu(upTo(LADDERS.smart, 6600), budget, ctx);
    coder = pickForCpu(upTo(LADDERS.coder, 6600), budget, ctx);
    quick = pickForCpu(upTo(LADDERS.quick, 3400), budget / 2, ctx);
    notes.push(
      hw?.gpu
        ? `The ${hw.gpu.name} has too little memory of its own for these models, so they run on the CPU. Expect slow answers.`
        : 'No graphics card with its own memory was found, so the models run on the CPU. Expect slow answers.',
    );
  }
  return { modes: { quick, smart, coder }, card, notes };
}

/**
 * How one given model would sit on this hardware: { ctx, where, needMb, spillMb, tooBig }.
 * For the list of other choices in the setup dialog.
 */
function fitModel(m, hw) {
  const ramMb = Number(hw?.ramMb) || 8192;
  const vramMb = Number(hw?.gpu?.vramMb) || 0;
  let fit;
  if (vramMb >= MIN_CARD_MB) {
    fit = { ctx: GPU_CTX[0], ...place(m.sizeMb, GPU_CTX[0], vramMb) };
    for (const ctx of GPU_CTX) {
      const p = place(m.sizeMb, ctx, vramMb);
      if (p.where === 'gpu') {
        fit = { ctx, ...p };
        break;
      }
    }
  } else {
    const ctx = ramMb >= 15000 ? 32768 : 16384;
    const need = footprintMb(m.sizeMb, ctx);
    fit = { ctx, where: 'cpu', needMb: need, spillMb: need };
  }
  // what has to go into normal RAM must leave room for Windows and the app
  fit.tooBig = fit.spillMb > Math.max(0, ramMb - 4096);
  return fit;
}

/** The next smaller model for a mode (for the "this is slow" hint), or null at the bottom. */
function stepDown(mode, base) {
  const ladder = LADDERS[mode] || LADDERS.smart;
  const all = [...ladder, ...QWEN];
  const cur = all.find((m) => m.base.toLowerCase() === String(base).toLowerCase());
  const below = ladder.filter((m) => (cur ? m.sizeMb < cur.sizeMb : true));
  return below.length && cur ? below[0].base : null;
}

// ---------------------------------------------------------------- reading the hardware

function run(file, args, ms = 6000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: ms, maxBuffer: 4 * MB }, (err, out) => resolve(err ? '' : String(out)));
  });
}

const vendorOf = (name) => (/nvidia|geforce|rtx|gtx|quadro/i.test(name) ? 'nvidia' : /amd|radeon/i.test(name) ? 'amd' : /intel|arc\b|iris|uhd/i.test(name) ? 'intel' : 'other');

/** NVIDIA cards, as the driver reports them. */
async function nvidiaCards() {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  return out
    .split(/\r?\n/)
    .map((l) => l.split(',').map((x) => x.trim()))
    .filter(([name, mem]) => name && Number(mem) > 0)
    .map(([name, mem]) => ({ name: name.replace(/^NVIDIA\s+/i, ''), vramMb: Number(mem), vendor: 'nvidia' }));
}

/**
 * Every display adapter Windows knows, with its real memory size. (The usual WMI field is a
 * 32-bit number and tops out at 4 GB; the driver's own 64-bit entry in the registry does not.)
 */
async function registryCards() {
  if (process.platform !== 'win32') return [];
  const key = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
  const [mem, desc] = await Promise.all([run('reg', ['query', key, '/s', '/v', 'HardwareInformation.qwMemorySize']), run('reg', ['query', key, '/s', '/v', 'DriverDesc'])]);
  const byKey = (text, re) => {
    const map = new Map();
    let cur = null;
    for (const line of text.split(/\r?\n/)) {
      const k = line.match(/^HKEY_LOCAL_MACHINE\\.*\\(\d{4})\s*$/i);
      if (k) cur = k[1];
      const v = line.match(re);
      if (v && cur) map.set(cur, v[1].trim());
    }
    return map;
  };
  const sizes = byKey(mem, /REG_QWORD\s+(0x[0-9a-f]+)/i);
  const names = byKey(desc, /REG_SZ\s+(.+)$/i);
  const cards = [];
  for (const [k, hex] of sizes) {
    const name = names.get(k);
    const vramMb = Math.round(Number(BigInt(hex)) / MB);
    if (name && vramMb > 0) cards.push({ name: name.replace(/^NVIDIA\s+/i, ''), vramMb, vendor: vendorOf(name) });
  }
  return cards;
}

function modelsFolder() {
  return process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
}

function freeDiskMb(folder) {
  let p = folder;
  for (let i = 0; i < 6; i++) {
    try {
      const s = fs.statfsSync(p);
      return Math.round((Number(s.bavail) * Number(s.bsize)) / MB);
    } catch {
      const up = path.dirname(p);
      if (up === p) break;
      p = up;
    }
  }
  return null;
}

// test hook: LOCALCLAUDE_FAKE_HW='{"gpu":{"name":"Test GPU","vramMb":8192},"ramMb":16384}'
function fakeHw() {
  if (process.env.LOCALCLAUDE_FAKE_HW) {
    try {
      return JSON.parse(process.env.LOCALCLAUDE_FAKE_HW);
    } catch {}
  }
  if (process.env.ASTER_BASE_URL) return { gpu: { name: 'Test GPU', vramMb: 8192, vendor: 'nvidia' }, ramMb: 16384 };
  return null;
}

let cardsCache = null;
/**
 * { gpu, gpus, ramMb, ramFreeMb, cpu: { name, cores }, disk: { folder, freeMb } }
 * gpu is the card the models will mostly use: several NVIDIA cards count together (Ollama
 * spreads a model over them), otherwise the one with the most memory.
 */
async function probe() {
  const cpus = os.cpus();
  const base = {
    ramMb: Math.round(os.totalmem() / MB),
    ramFreeMb: Math.round(os.freemem() / MB),
    cpu: { name: (cpus[0]?.model || 'CPU').replace(/\s+/g, ' ').trim(), cores: cpus.length },
    disk: { folder: modelsFolder(), freeMb: freeDiskMb(modelsFolder()) },
  };
  const fake = fakeHw();
  if (fake) return { ...base, ...fake, gpus: fake.gpus || (fake.gpu ? [fake.gpu] : []), gpu: fake.gpu || null, fake: true };
  if (!cardsCache) {
    const nv = await nvidiaCards();
    const reg = await registryCards();
    // the registry also lists virtual adapters (remote desktop, second-screen tools): no memory, filtered out above
    const others = reg.filter((c) => c.vendor !== 'nvidia' || !nv.length);
    cardsCache = [...nv, ...others].sort((a, b) => b.vramMb - a.vramMb);
  }
  const gpus = cardsCache;
  const nv = gpus.filter((c) => c.vendor === 'nvidia');
  let gpu = gpus[0] || null;
  if (nv.length > 1) gpu = { name: `${nv.length} NVIDIA cards (${nv.map((c) => c.name).join(' + ')})`, vramMb: nv.reduce((s, c) => s + c.vramMb, 0), vendor: 'nvidia' };
  else if (nv.length === 1) gpu = nv[0];
  return { ...base, gpus, gpu };
}

module.exports = { probe, recommend, place, footprintMb, fitModel, stepDown, LADDERS, MIN_CARD_MB };
