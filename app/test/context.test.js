// Unit checks for the context-window trimming (src/main/context.js):  node test/context.test.js
const { fit } = require('../src/main/context');

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};
const text = (t) => [{ type: 'text', text: t }];
const big = (n) => 'x'.repeat(n);
const valid = (msgs) => {
  // every tool_result must follow an assistant message that holds its tool_use
  const ids = new Set();
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') ids.add(b.id);
      if (b.type === 'tool_result' && !ids.has(b.tool_use_id)) return false;
    }
  }
  return msgs[0].role === 'user';
};

// a chat with 12 tool rounds of 20k characters each
const msgs = [{ role: 'user', content: text('first question') }];
for (let i = 0; i < 12; i++) {
  msgs.push({ role: 'assistant', content: [{ type: 'thinking', thinking: big(3000), signature: '' }, { type: 'tool_use', id: `t${i}`, name: 'run_command', input: { command: `step ${i}` } }] });
  msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `out ${i} ${big(20000)}` }] });
}
msgs.push({ role: 'assistant', content: text('all done') });
msgs.push({ role: 'user', content: text('second question') });
const before = JSON.stringify(msgs);

const small = fit(msgs, { ctx: 200000, system: big(3000), tools: [], maxTokens: 16384 });
check('fits untouched in a big window', !small.trimmed && small.messages.length === msgs.length);

const r = fit(msgs, { ctx: 16384, system: big(3000), tools: [], maxTokens: 5000 });
check('trimmed for a 16k window', r.trimmed);
check('result is inside the budget', r.usedTokens <= r.budgetTokens, `${r.usedTokens} of ${r.budgetTokens}`);
check('saved conversation is not changed', JSON.stringify(msgs) === before);
check('tool calls and results still pair up', valid(r.messages));
check('newest messages are kept whole', JSON.stringify(r.messages.slice(-1)) === JSON.stringify(msgs.slice(-1)) && r.messages.some((m) => JSON.stringify(m).includes('out 11')));
check('old reasoning is dropped', !r.messages.slice(0, -4).some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'thinking')));

const tiny = fit(msgs, { ctx: 4096, system: big(2000), tools: [], maxTokens: 1300 });
check('tiny window: still valid and inside the budget', valid(tiny.messages) && tiny.usedTokens <= tiny.budgetTokens, `${tiny.usedTokens} of ${tiny.budgetTokens}, ${tiny.messages.length} messages`);
check('tiny window: starts with the first question or a note that the start was left out', /first question|left out to fit/.test(JSON.stringify(tiny.messages[0])));

// one turn so long that only dropping whole turns helps
const many = [];
for (let i = 0; i < 40; i++) many.push({ role: 'user', content: text(`question ${i} ${big(3000)}`) }, { role: 'assistant', content: text(`answer ${i} ${big(3000)}`) });
const dropped = fit(many, { ctx: 8192, system: big(1000), tools: [], maxTokens: 2000 });
check('long chat: oldest turns are dropped with a note', dropped.usedTokens <= dropped.budgetTokens && JSON.stringify(dropped.messages[0]).includes('left out to fit') && JSON.stringify(dropped.messages).includes('question 39') && !JSON.stringify(dropped.messages).includes('question 0 '), `${dropped.messages.length} messages`);
check('tiny window: the latest question survives', JSON.stringify(tiny.messages[tiny.messages.length - 1]).includes('second question'));

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
