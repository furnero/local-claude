// Measures how a model sits in memory and how fast it runs under different Ollama server
// settings. It restarts `ollama serve` for each setting, so run it only when nothing else uses Ollama.
//   node test/bench-ollama.js <model> [<model> ...]
// Prints, per setting: total size, share on the GPU, RAM part, prompt-reading and writing speed.
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');

const EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');
const API = 'http://127.0.0.1:11434';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTINGS = [
  { name: 'default', env: {} },
  { name: 'flash attention + q8 cache', env: { OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0' } },
];
// about 700 tokens of prompt, so reading speed can be measured
const PROMPT = `${'The quick brown fox jumps over the lazy dog near the old stone bridge. '.repeat(45)}\n\nIn two sentences: what animal jumps, and over what?`;

async function up() {
  try {
    return (await fetch(`${API}/api/version`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function restart(env) {
  try {
    execFileSync('taskkill.exe', ['/IM', 'ollama.exe', '/F'], { stdio: 'ignore' });
  } catch {}
  for (let i = 0; i < 20 && (await up()); i++) await sleep(300);
  const child = spawn(EXE, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } });
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await up()) return;
    await sleep(500);
  }
  throw new Error('ollama did not start');
}

async function run(model) {
  const body = { model, prompt: PROMPT, stream: false, think: false, keep_alive: '2m', options: { num_predict: 120, temperature: 0 } };
  const post = async () => (await fetch(`${API}/api/generate`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15 * 60 * 1000) })).json();
  const first = await post(); // includes loading
  if (first.error) throw new Error(first.error);
  // second run with a changed prompt start, so the prompt is read again and not taken from the cache
  body.prompt = `Note ${Date.now()}. ${PROMPT}`;
  const r = await post();
  const ps = ((await (await fetch(`${API}/api/ps`)).json()).models || []).find((m) => m.name.startsWith(model));
  const gb = (n) => (n / 1073741824).toFixed(1);
  return {
    total: gb(ps.size),
    gpuShare: Math.round((ps.size_vram / ps.size) * 100),
    ram: gb(ps.size - ps.size_vram),
    load: (first.load_duration / 1e9).toFixed(0),
    read: Math.round(r.prompt_eval_count / (r.prompt_eval_duration / 1e9)),
    write: (r.eval_count / (r.eval_duration / 1e9)).toFixed(1),
  };
}

(async () => {
  const models = process.argv.slice(2);
  for (const s of SETTINGS) {
    await restart(s.env);
    for (const m of models) {
      try {
        const r = await run(m);
        console.log(`${s.name.padEnd(28)} ${m.padEnd(52)} ${r.total} GB total, ${r.gpuShare}% on GPU, ${r.ram} GB RAM | load ${r.load}s | reads ${r.read} tok/s | writes ${r.write} tok/s`);
      } catch (e) {
        console.log(`${s.name.padEnd(28)} ${m.padEnd(52)} FAILED: ${e.message}`);
      }
      await fetch(`${API}/api/generate`, { method: 'POST', body: JSON.stringify({ model: m, keep_alive: 0 }) }).catch(() => {});
      await sleep(2500);
    }
  }
  // leave a plain server running
  await restart({});
  console.log('done (server restarted with default settings)');
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
