// The modes the picker offers. Which Ollama model each one runs is a setting
// (Settings -> Local models, see ollama.js); "smart" adds the careful working method to the
// system prompt (see project.js).
const MODELS = [
  { id: 'quick', name: 'Quick', desc: 'fast answers and small jobs', smart: false },
  { id: 'smart', name: 'Smart', desc: 'plans, checks its work, keeps notes · slower', smart: true },
  // a coding fine-tune with the refusals removed ("abliterated"); works with Smart's careful method
  { id: 'coder', name: 'Coder', desc: 'coding model without refusals · plans and checks like Smart', smart: true, coder: true },
  // a 30B coding model through the colibri engine (see colibri.js): much stronger, about 1 token a second.
  // The default folder holds the abliterated build (refusals removed), like the Coder mode's model.
  { id: 'coder30', name: 'Coder 30B', desc: 'Qwen3-Coder 30B without refusals, through colibrì · strongest, very slow', smart: true, coder: true, engine: 'colibri' },
];

// Ollama can only switch a model's reasoning on or off, so "effort" is just that.
const EFFORTS = [
  { id: 'default', name: 'Thinking on', desc: 'Reasons step by step before answering (shown in the chat)' },
  { id: 'off', name: 'Thinking off', desc: 'Answers straight away, faster' },
];

/** Mode id for a conversation's model field (older chats stored the Ollama model name). */
function modeOf(id) {
  if (id === 'smart' || id === 'local-agent') return 'smart';
  if (id === 'coder' || id === 'coder30') return id;
  return 'quick';
}

function modelInfo(id) {
  return MODELS.find((m) => m.id === modeOf(id));
}

/** Local models cost nothing; kept so the usage code paths stay the same. */
function costOf() {
  return 0;
}

module.exports = { MODELS, EFFORTS, modeOf, modelInfo, costOf };
