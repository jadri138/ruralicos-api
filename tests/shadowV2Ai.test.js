const assert = require('assert');
const corpus = require('./fixtures/shadow-v2/corpus.json');
const {
  AI1_MODEL,
  AI1_INSTRUCTIONS,
  AI1_TEXT_FORMAT,
  AI1_CONTRACT_VERSION,
  AI1_PROMPT_VERSION,
  classifyAlertWithAi1,
  normalizeAi1Result,
} = require('../src/modules/alertas/shadow-v2/ai1');
const {
  AI2_MODEL,
  AI2_INSTRUCTIONS,
  AI2_TEXT_FORMAT,
  AI2_CONTRACT_VERSION,
  AI2_PROMPT_VERSION,
  decideDigestWithAi2,
  normalizeAi2Result,
} = require('../src/modules/alertas/shadow-v2/ai2');
const { projectDigest } = require('../src/modules/alertas/shadow-v2/render');

function fakeResponse(value, usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 }) {
  return Promise.resolve({
    text: JSON.stringify(value),
    metadata: { usage, duration_ms: 12 },
  });
}

async function main() {
  assert.strictEqual(AI1_CONTRACT_VERSION, 'shadow-v2-ai1-3');
  assert.strictEqual(AI1_PROMPT_VERSION, 'shadow-v2-ai1-prompt-6');
  assert(AI1_INSTRUCTIONS.includes('el asunto real de la publicacion es rural'));
  assert(AI1_INSTRUCTIONS.includes('Un puesto de empleo publico'));
  assert(AI1_INSTRUCTIONS.includes('usa actionable=false'));
  assert(AI1_INSTRUCTIONS.includes('No escribas dudas'));
  assert(AI1_INSTRUCTIONS.includes('YYYY-MM-DD'));
  assert(AI1_INSTRUCTIONS.includes('un maximo de 450 caracteres'));
  assert(AI1_INSTRUCTIONS.includes('no uses barras'));
  assert.strictEqual(AI1_TEXT_FORMAT.schema.properties.activities.maxItems, 3);
  assert.strictEqual(
    AI1_TEXT_FORMAT.schema.properties.deadline.anyOf[0].format,
    'date'
  );
  assert.strictEqual(AI2_CONTRACT_VERSION, 'shadow-v2-ai2-4');
  assert.strictEqual(AI2_PROMPT_VERSION, 'shadow-v2-ai2-prompt-7');
  assert(AI2_INSTRUCTIONS.includes('encaje personal concreto'));
  assert(AI2_INSTRUCTIONS.includes('gancho comercial de una sola frase'));
  assert(AI2_INSTRUCTIONS.includes('habla siempre de tu y nunca de usted'));
  assert(AI2_INSTRUCTIONS.includes('el servidor los proyecta desde la ficha verificada'));
  assert(AI2_INSTRUCTIONS.includes('evita un digest repetitivo'));
  assert(AI2_INSTRUCTIONS.includes('si el perfil no demuestra que sea suya'));
  assert.deepStrictEqual(
    AI2_TEXT_FORMAT.schema.properties.selected.items.required,
    ['alert_id', 'reason', 'title']
  );

  const validCard = corpus.accepted_by_ai1[0].ai1;
  assert.deepStrictEqual(normalizeAi1Result(validCard), validCard);

  const normalizedCard = normalizeAi1Result({
    ...validCard,
    activities: ['bovino', 'ovino', 'caprino', 'porcino'],
    beneficiary_types: ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis'],
    deadline: '15 dias habiles desde la publicacion',
  });
  assert.deepStrictEqual(normalizedCard.activities, ['bovino', 'ovino', 'caprino']);
  assert.deepStrictEqual(normalizedCard.beneficiary_types, ['uno', 'dos', 'tres', 'cuatro', 'cinco']);
  assert.strictEqual(normalizedCard.deadline, null, 'un plazo relativo no invalida la ficha completa');

  const deadlineCard = { ...validCard, deadline: '2026-09-01' };
  assert.strictEqual(normalizeAi1Result(deadlineCard, {
    officialContent: 'El plazo de presentacion de solicitudes finaliza el 1 de septiembre de 2026.',
  }).deadline, '2026-09-01', 'conserva un plazo explicito de la persona beneficiaria');
  assert.strictEqual(normalizeAi1Result(deadlineCard, {
    officialContent: 'El plazo empieza desde la fecha de publicacion y las solicitudes se admiten hasta el 1 de septiembre de 2026.',
  }).deadline, '2026-09-01', 'no confunde la referencia a la publicacion con la fecha limite explicita');
  assert.strictEqual(normalizeAi1Result(deadlineCard, {
    officialContent: 'El importe sera transferido al ICO en un solo pago antes del 1 de septiembre de 2026.',
  }).deadline, null, 'descarta fechas administrativas entre organismos');
  assert.strictEqual(normalizeAi1Result(deadlineCard, {
    officialContent: 'Plazo de solicitud: hasta el dia anterior al inicio. Fechas: del 1 de septiembre de 2026 al 24 de septiembre de 2026.',
  }).deadline, null, 'descarta el inicio de un curso usado como plazo');
  assert.strictEqual(normalizeAi1Result(deadlineCard, {
    officialContent: 'El plazo es de quince dias habiles desde la publicacion.',
  }).deadline, null, 'descarta fechas calculadas que no aparecen en la fuente');
  assert.strictEqual(normalizeAi1Result({ ...validCard, deadline: '2026-12-31' }, {
    officialContent: 'La resolucion sera de aplicacion hasta el 31 de diciembre de 2026. Contra ella se podra interponer recurso de alzada.',
  }).deadline, null, 'descarta el fin de vigencia aunque despues se mencione un recurso');
  assert.strictEqual(normalizeAi1Result({ ...validCard, deadline: '2026-08-24' }, {
    officialContent: 'La sustitucion temporal se producira desde el 14 de agosto hasta el 24 de agosto de 2026.',
  }).deadline, null, 'descarta el fin de una sustitucion administrativa');
  assert.strictEqual(normalizeAi1Result({ ...validCard, deadline: '2026-08-12' }, {
    officialContent: 'El plazo de presentacion termina el 12 de agosto de 2026.',
    officialDate: '2026-08-12',
  }).deadline, null, 'la fecha de publicacion no se presenta como plazo del usuario');

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
    callAi: () => fakeResponse({ selected: [], message: 'No hay avisos adecuados para este perfil.' }),
  });
  assert.strictEqual(emptyAi2.status, 'EMPTY');
  assert.strictEqual(emptyAi2.normalizedResponse.message, '');

  const normalizedSelection = normalizeAi2Result({
    selected: [{
      alert_id: 201,
      reason: 'Actividad ganadera compatible.',
      title: 'Ayuda ganadera',
      summary: 'Resumen inventado que el servidor no debe usar',
      action: 'Accion inventada',
      deadline: 'quince dias desde la publicacion',
    }],
    message: 'Aviso util.',
  }, {
    candidateIds: [201],
    maxSelected: 5,
  });
  assert.deepStrictEqual(normalizedSelection.selected[0], {
    alert_id: 201,
    reason: 'Actividad ganadera compatible.',
    title: 'Ayuda ganadera',
  });

  const projectedDigest = projectDigest(normalizedSelection, {
    user: { first_name: 'Ana', name: 'Nombre alternativo' },
    candidates: [{
      alert_id: 201,
      card: {
        summary: 'Resumen verificado por IA 1.',
        action: 'Solicitar la ayuda oficial.',
        deadline: '2026-09-30',
      },
      official_snapshot: { official_url: 'https://example.test/201' },
    }],
  });
  assert(projectedDigest.message.startsWith('¡Hola, Ana! 👋'));
  assert(projectedDigest.message.includes('una novedad rural que merece la pena revisar'));
  assert(projectedDigest.message.includes('*1. Ayuda ganadera*'));
  assert(projectedDigest.message.includes('Resumen verificado por IA 1.'));
  assert(!projectedDigest.message.includes('Resumen inventado'));
  assert(projectedDigest.message.includes('👉 *Qué puedes hacer:* Solicitar la ayuda oficial.'));
  assert(projectedDigest.message.includes('⏳ *Plazo:* 2026-09-30'));
  assert(projectedDigest.message.includes('🔗 *Fuente oficial:* https://example.test/201'));
  assert(projectedDigest.items[0].rendered_block.includes('https://example.test/201'));
  assert(projectedDigest.message.includes(
    '¿Qué te parece esta alerta? Responde brevemente para que el sistema aprenda tus intereses.'
  ));
  assert(projectedDigest.message.endsWith('*Ruralicos* 🌱'));
  const pluralDigest = projectDigest({
    ...normalizedSelection,
    selected: [
      ...normalizedSelection.selected,
      { ...normalizedSelection.selected[0], alert_id: 202, title: 'Curso rural' },
    ],
  }, { user: { first_name: 'Ana' } });
  assert(pluralDigest.message.includes('¿Qué te parecen estas alertas?'));
  assert.strictEqual(projectDigest({ selected: [], message: '' }, {
    user: { first_name: 'Ana' },
  }).message, '');

  assert.throws(() => normalizeAi2Result({
    selected: Array.from({ length: 6 }, (_, index) => ({
      alert_id: index + 1,
      reason: 'razón',
      title: 'título',
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
