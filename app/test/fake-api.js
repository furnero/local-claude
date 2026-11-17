// A local stand-in for api.anthropic.com that streams Messages-API events the way the real API
// does, so the app can be tested end to end without an API key or cost:
//   node test/fake-api.js 8787 [log.jsonl]
// then start Aster with ASTER_BASE_URL=http://127.0.0.1:8787 (see test/drive.js).
// The scenario is picked from the last user text: "tool", "mcp", "search", "error", "long", else a
// normal answer with thinking, markdown, code and math.
const http = require('node:http');
const fs = require('node:fs');

const port = Number(process.argv[2] || 8787);
const logFile = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return { text: m.content, results: [] };
    const results = m.content.filter((b) => b.type === 'tool_result');
    const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return { text, results };
  }
  return { text: '', results: [] };
}

function chunks(text, size = 6) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const ANSWER = `Here's a quick tour of what I can render.

## A heading

Some **bold** text, some *italics*, \`inline code\` and a [link](https://example.com).

| Model | Speed |
| --- | --- |
| Sonnet 5.5 | Fast |
| Opus 5.5 | Thorough |

Math works too: $e^{i\\pi} + 1 = 0$ and

$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$

\`\`\`python
def greet(name):
    return f"Hello, {name}!"
\`\`\`

\`\`\`html
<!doctype html><html><body style="font-family:sans-serif;display:grid;place-items:center;height:100vh;background:#faf9f5"><h1 id="t">Hello from a preview</h1><script>document.getElementById('t').style.color='#c96442'</script></body></html>
\`\`\`

- one
- two
- three`;

async function stream(res, model, blocks, stopReason, usage) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': `req_${n}` });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const id = `msg_fake_${++n}`;
  send('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 } } });
  let index = 0;
  for (const b of blocks) {
    if (res.destroyed) return;
    if (b.type === 'thinking') {
      send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      for (const c of chunks(b.thinking, 8)) {
        send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: c } });
        await sleep(20);
      }
      send('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'fakesig' } });
    } else if (b.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      for (const c of chunks(b.text, b.fast ? 40 : 5)) {
        if (res.destroyed) return;
        send('content_block_delta', { index, delta: { type: 'text_delta', text: c } });
        await sleep(b.fast ? 2 : 12);
      }
      for (const cit of b.citations || []) send('content_block_delta', { index, delta: { type: 'citations_delta', citation: cit } });
    } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      send('content_block_start', { index, content_block: { type: b.type, id: b.id, name: b.name, input: {} } });
      for (const c of chunks(JSON.stringify(b.input), 7)) {
        send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: c } });
        await sleep(15);
      }
    } else {
      send('content_block_start', { index, content_block: b });
      await sleep(300);
    }
    send('content_block_stop', { index });
    index++;
  }
  send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage || 320, ...(blocks.some((b) => b.name === 'web_search') ? { server_tool_use: { web_search_requests: 1 } } : {}) } });
  send('message_stop', {});
  res.end();
}

let fakePlacement = null;
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const url = new URL(req.url, 'http://x');
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ method: req.method, path: url.pathname, beta: req.headers['anthropic-beta'] || null, key: req.headers['x-api-key'] ? 'set' : null, body: body ? JSON.parse(body) : null })}\n`);

  if (req.method === 'GET' && url.pathname === '/page.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Fake Page</title><style>p{color:red}</style><script>var hidden=1</script></head><body><nav>menu</nav><h1>Paper server</h1><p>The newest build is <b>1.21.1-99</b> &amp; it is stable.</p><ul><li>one</li><li>two</li></ul></body></html>');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/file.bin') {
    const data = Buffer.alloc(3 * 1048576 + 123, 7);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length });
    res.end(data);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    if (req.headers['x-api-key'] === 'sk-ant-wrong') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-5-5', type: 'model', display_name: 'Claude Sonnet 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-sonnet-5-5', last_id: 'claude-sonnet-5-5' }));
    return;
  }
  // Ollama's download route: progress as JSON lines. A name with "broken" fails like a missing model.
  if (req.method === 'POST' && url.pathname === '/api/pull') {
    const name = JSON.parse(body).model;
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    if (/broken/.test(name)) {
      res.end(`${JSON.stringify({ status: 'pulling manifest' })}\n${JSON.stringify({ error: 'pull model manifest: file does not exist' })}\n`);
      return;
    }
    for (const line of [{ status: 'pulling manifest' }, { status: 'downloading', total: 1000, completed: 400 }, { status: 'downloading', total: 1000, completed: 1000 }, { status: 'success' }]) {
      res.write(`${JSON.stringify(line)}\n`);
      await new Promise((r) => setTimeout(r, 60));
    }
    res.end();
    return;
  }
  // Ollama's "what is loaded" route. Empty unless a test set a placement with POST /test/placement.
  if (req.method === 'GET' && url.pathname === '/api/ps') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: fakePlacement ? [{ name: 'loaded-model', ...fakePlacement }] : [] }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/test/placement') {
    fakePlacement = JSON.parse(body); // { size, size_vram } in bytes, or null
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
    res.writeHead(404);
    res.end();
    return;
  }
  const p = JSON.parse(body);
  if (!p.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `msg_t${++n}`, type: 'message', role: 'assistant', model: p.model, content: [{ type: 'text', text: 'Fake chat title' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 50, output_tokens: 5 } }));
    return;
  }
  const { text, results } = lastUser(p.messages);
  const model = p.model;
  if (results.length) {
    const r = results[0];
    const out = typeof r.content === 'string' ? r.content : (r.content || []).map((c) => c.text || '').join('');
    const first = out.split('\n').find((l) => l.trim() && !/^Exit code/.test(l)) || '(nothing)';
    await stream(res, model, [{ type: 'text', text: r.is_error ? `The tool call didn't go through: ${out.slice(0, 120)}` : `Done. The tool returned: **${first.trim()}**` }], 'end_turn', 40);
    return;
  }
  if (!results.length && text.startsWith('[Automatic check]')) {
    await stream(res, model, [{ type: 'text', text: 'Checked: everything verified.' }], 'end_turn', 20);
    return;
  }
  const t = text.toLowerCase();
  const tu = (name, input, lead = 'One moment.') => stream(res, model, [{ type: 'thinking', thinking: `Thinking about ${name}.\nStep one, then step two.` }, { type: 'text', text: lead }, { type: 'tool_use', id: `toolu_${name}_${n}`, name, input }], 'tool_use');
  const sys = typeof p.system === 'string' ? p.system : (p.system || []).map((b) => b.text).join('\n');
  // ---- Local Claude scenarios
  // Qwen3-Coder's tool call written as text with the opening tag missing: the app has to recover it
  if (t.includes('malformed call')) {
    await stream(res, model, [{ type: 'text', text: `Looking.\n<function=search_files>\n<parameter=name>\npackage.json\n</parameter>\n</function>\n</tool_call>` }], 'end_turn', 30);
    return;
  }
  if (t.includes('complex job')) return tu('suggest_smart_mode', { reason: 'it needs several steps and a server to test.' }, 'Let me check the mode first.');
  if (t.includes('pick one')) return tu('ask_user', { question: 'Which **Minecraft** version should the test server run?', options: ['1.21.1', '1.20.4'] });
  if (t.includes('start server')) return tu('start_process', { command: "1..60 | ForEach-Object { \"tick $_\"; Start-Sleep -Milliseconds 400 }; $l = [Console]::In.ReadLine(); \"got input: $l\"", name: 'fake server' });
  if (t.includes('watch server')) return tu('process_output', { id: 'p1', until_text: 'tick 8', wait_seconds: 30 });
  if (t.includes('type into')) return tu('send_input', { id: 'p1', text: 'stop' });
  if (t.includes('kill server')) return tu('stop_process', { id: 'p1' });
  if (t.includes('download it')) return tu('download_file', { url: `http://127.0.0.1:${port}/file.bin`, path: process.env.FAKE_DL || 'dl-test\\file.bin' });
  if (t.includes('note this')) {
    const nf = /Your notes file for this project: (.+)/.exec(sys)?.[1]?.trim();
    return tu('edit_file', { path: nf, old_string: '## Done\r\n', new_string: '## Done\r\n- 2026-11-13: fake test entry\r\n' }, 'Writing it down.');
  }
  if (t.includes('touch memory')) return tu('write_file', { path: require('node:path').join(require('node:os').homedir(), '.claude', 'zz-should-not-exist.md'), content: 'x' });
  if (t.includes('make a plan')) return tu('update_plan', { items: [{ text: 'Download the jar', status: 'done' }, { text: 'Start the server', status: 'in_progress' }, 'Test the login'] }, 'Here is my plan.');
  if (t.includes('remember this')) return tu('save_note', { section: 'facts', text: 'fake fact 42 lives in the attic' });
  if (t.includes('recall it')) return tu('search_memory', { query: 'attic fake' });
  if (t.includes('forget it')) return tu('remove_note', { contains: 'fake fact 42' });
  if (t.includes('read the page')) return tu('web_fetch', { url: `http://127.0.0.1:${port}/page.html` });
  if (t.includes('slow job')) return tu('run_command', { command: "Start-Sleep -Seconds 4; 'slow done'", timeout_seconds: '30' });
  if (t.includes('find files')) return tu('search_files', { name: '*.json', text: 'productName' });
  if (t.includes('error')) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }));
    return;
  }
  if (t.includes('mcp')) {
    await stream(res, model, [{ type: 'thinking', thinking: '**Using the echo tool**\nThe user wants the MCP echo.' }, { type: 'text', text: "I'll ask the echo server." }, { type: 'tool_use', id: `toolu_m${n}`, name: 'mcp__echo__echo', input: { text: 'hi from mcp' } }], 'tool_use');
    return;
  }
  if (t.includes('tool')) {
    await stream(
      res,
      model,
      [
        { type: 'thinking', thinking: '**Planning the command**\nI should check the PowerShell version with a harmless command.' },
        { type: 'text', text: "I'll run a quick, harmless command to check." },
        { type: 'tool_use', id: `toolu_${n}`, name: 'run_command', input: { command: "Write-Output 'hello from aster'; $PSVersionTable.PSVersion.ToString()", shell: 'powershell' } },
      ],
      'tool_use',
    );
    return;
  }
  if (t.includes('search')) {
    const sid = `srvtoolu_${n}`;
    await stream(
      res,
      model,
      [
        { type: 'server_tool_use', id: sid, name: 'web_search', input: { query: 'electron 44 release notes' } },
        {
          type: 'web_search_tool_result',
          tool_use_id: sid,
          content: [
            { type: 'web_search_result', url: 'https://www.electronjs.org/blog', title: 'Electron Blog', encrypted_content: 'x', page_age: null },
            { type: 'web_search_result', url: 'https://github.com/electron/electron/releases', title: 'Releases · electron/electron', encrypted_content: 'x', page_age: null },
          ],
        },
        {
          type: 'text',
          text: 'Electron ships a new major version every eight weeks, and its blog lists the changes.',
          citations: [{ type: 'web_search_result_location', url: 'https://www.electronjs.org/blog', title: 'Electron Blog', encrypted_index: 'x', cited_text: 'new major' }],
        },
      ],
      'end_turn',
    );
    return;
  }
  const long = t.includes('long') ? `${ANSWER}\n\n`.repeat(4) : ANSWER;
  await stream(res, model, [{ type: 'thinking', thinking: '**Understanding the request**\nA friendly test message.\n\n**Choosing a format**\nShow off markdown, a table, math and code.' }, { type: 'text', text: long }], 'end_turn');
});

server.listen(port, '127.0.0.1', () => console.log(`fake api on ${port}`));
