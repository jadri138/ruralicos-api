const assert = require('assert');
const {
  OPENAI_MODELS,
  defaultReasoningForModel,
} = require('../src/platform/ia/modelPolicy');
const { AI1_MODEL } = require('../src/modules/alertas/shadow-v2/ai1');
const { AI2_MODEL } = require('../src/modules/alertas/shadow-v2/ai2');

process.env.IA_GPT5_NANO_REASONING_EFFORT = 'minimal';
process.env.IA_GPT56_LUNA_REASONING_EFFORT = 'low';

assert.strictEqual(OPENAI_MODELS.economy, 'gpt-5-nano');
assert.strictEqual(OPENAI_MODELS.qualityEfficient, 'gpt-5.6-luna');
assert.strictEqual(OPENAI_MODELS.embedding, 'text-embedding-3-small');
assert.strictEqual(AI1_MODEL, OPENAI_MODELS.economy);
assert.strictEqual(AI2_MODEL, OPENAI_MODELS.qualityEfficient);
assert.deepStrictEqual(defaultReasoningForModel('gpt-5-nano-2025-08-07'), { effort: 'minimal' });
assert.deepStrictEqual(defaultReasoningForModel('gpt-5.6-luna'), { effort: 'low' });
assert.strictEqual(defaultReasoningForModel('gpt-4o-mini'), null);

console.log('OK: politica de modelos economicos y razonamiento validada');
