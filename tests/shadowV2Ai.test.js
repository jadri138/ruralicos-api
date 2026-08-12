const assert = require('assert');
const corpus = require('./fixtures/shadow-v2/corpus.json');
const {
  AI1_MODEL,
  classifyAlertWithAi1,
  normalizeAi1Result,
} = require('../src/modules/alertas/shadow-v2/ai1');
const {
  AI2_MODEL,
  decideDigestWithAi2,
  normalizeAi2Result,
} = require('../src/modules/alertas/shadow-v2/ai2');

function fakeResponse(value, usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 }) {
  return Promise.resolve({
    text: JSON.stringify(value),
    metadata: { usage, duration_ms: 12 },
  });
}

async function main() {
  const validCard = corpus.accepted_by_ai1[0].ai1;
  assert.deepStrictEqual(normalizeAi1Result(validCard), validCard);

  let ai1Calls = 0;
  const validAi1 = await classifyAlertWithAi1({
    officialSnapshot: {
      alert_id: 201,
      title: corpus.accepted_by_ai1[0].title,
      organization: corpus.accepted_by_ai1[0].organization,
      source: 'BOPA',
      date: '2026-08-12',
      official_url: 'https://example.test/201',
      official_content: corpus.accepted_by_ai1[0].official_content,
    },
    maxOfficialChars: 30000,
    callAi: async (prompt, instructions, model, options) => {
      ai1Calls += 1;
      assert.strictEqual(model, 'gpt-5-nano');
      assert.strictEqual(options.retries, 0);
      assert.strictEqual(options.skipAudit, true);
      assert(!prompt.includes('estado_ia'));
      assert(!prompt.includes('pre_score'));
      return fakeResponse(validCard);
    },
  });
  assert.strictEqual(AI1_MODEL, 'gpt-5-nano');
  assert.strictEqual(ai1Calls, 1);
  assert.strictEqual(validAi1.status, 'SUCCESS');
  assert.strictEqual(validAi1.usage.total_tokens, 15);

  let invalidAi1Calls = 0;
  const invalidAi1 = await classifyAlertWithAi1({
    officialSnapshot: { alert_id: 1, title: 'Ayuda agraria', official_content: 'Texto oficial' },
    maxOfficialChars: 30000,
    callAi: async () => {
      invalidAi1Calls += 1;
      return { text: '{"relevant":"yes"}', metadata: { duration_ms: 3, usage: null } };
    },
  });
  assert.strictEqual(invalidAi1Calls, 1, 'IA 1 invalida no debe provocar fallback');
  assert.strictEqual(invalidAi1.status, 'ERROR');
  assert.strictEqual(invalidAi1.rawResponse, '{"relevant":"yes"}');
  assert.strictEqual(invalidAi1.normalizedResponse, null);

  const candidates = corpus.accepted_by_ai1.slice(0, 2).map((item) => ({
    alert_id: item.id,
    card: item.ai1,
    official_snapshot: { title: item.title, official_url: `https://example.test/${item.id}` },
  }));
  const selectedPayload = {
    selected: candidates.map((candidate) => ({
      alert_id: candidate.alert_id,
      reason: 'El perfil acredita actividad y territorio compatibles.',
      title: candidate.official_snapshot.title,
      summary: candidate.card.summary,
      action: candidate.card.action,
      deadline: candidate.card.deadline,
    })),
    message: 'Dos avisos útiles y accionables para tu actividad.',
  };
  let ai2Calls = 0;
  const validAi2 = await decideDigestWithAi2({
    user: { id: 7, name: 'Persona fixture', preferences: { provincias: ['Asturias'], actividades: ['bovino'] } },
    candidates,
    sentAlertIds: [],
    maxSelected: 5,
    maxPromptChars: 60000,
    callAi: async (prompt, instructions, model, options) => {
      ai2Calls += 1;
      assert.strictEqual(model, 'gpt-5.6-luna');
      assert.strictEqual(options.retries, 0);
      assert.strictEqual(options.skipAudit, true);
      assert(!prompt.includes('subscription'));
      return fakeResponse(selectedPayload);
    },
  });
  assert.strictEqual(AI2_MODEL, 'gpt-5.6-luna');
  assert.strictEqual(ai2Calls, 1);
  assert.strictEqual(validAi2.status, 'GENERATED');
  assert.strictEqual(validAi2.normalizedResponse.selected.length, 2);

  const emptyAi2 = await decideDigestWithAi2({
    user: { id: 8, preferences: {} },
    candidates,
    maxSelected: 5,
    maxPromptChars: 60000,
    callAi: () => fakeResponse({ selected: [], message: '' }),
  });
  assert.strictEqual(emptyAi2.status, 'EMPTY');

  assert.throws(() => normalizeAi2Result({
    selected: Array.from({ length: 6 }, (_, index) => ({
      alert_id: index + 1,
      reason: 'razón',
      title: 'título',
      summary: 'resumen',
      action: 'acción',
      deadline: null,
    })),
    message: 'mensaje',
  }, { candidateIds: [1, 2, 3, 4, 5, 6], maxSelected: 5 }), /ai2_too_many_selected/);

  let invalidAi2Calls = 0;
  const invalidAi2 = await decideDigestWithAi2({
    user: { id: 9, preferences: {} },
    candidates,
    maxSelected: 5,
    maxPromptChars: 60000,
    callAi: async () => {
      invalidAi2Calls += 1;
      return { text: '{"selected":[{"alert_id":999}],"message":"x"}', metadata: {} };
    },
  });
  assert.strictEqual(invalidAi2Calls, 1, 'IA 2 invalida no debe provocar segunda opinion');
  assert.strictEqual(invalidAi2.status, 'ERROR');

  let oversizedCalls = 0;
  const oversized = await decideDigestWithAi2({
    user: { id: 10, preferences: { nota: 'x'.repeat(5000) } },
    candidates,
    maxSelected: 5,
    maxPromptChars: 2000,
    callAi: async () => { oversizedCalls += 1; return fakeResponse(selectedPayload); },
  });
  assert.strictEqual(oversized.status, 'ERROR');
  assert.strictEqual(oversized.error.code, 'personal_prompt_too_large');
  assert.strictEqual(oversizedCalls, 0, 'un prompt excesivo no debe llamar a IA 2');

  console.log('OK: contratos IA 1/IA 2, modelos fijos, errores sin fallback y limites');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
