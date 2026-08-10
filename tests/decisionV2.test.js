const assert = require('assert');
const {
  CONTRACT_VERSION,
  contieneTerminoCompleto,
  evaluarFiltrosObjetivos,
  ejecutarDecisionV2,
  prepararEntradaDecisionV2,
  validarRespuestaDecisionV2,
} = require('../src/modules/alertas/decision-v2/decisionEngine');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function user(overrides = {}) {
  return {
    id: 501,
    name: 'Perfil de prueba',
    subscription: 'agricultor',
    preferences: {
      provincias: ['Zaragoza'],
      sectores: ['agricultura'],
      subsectores: ['olivar'],
      tipos_alerta: ['ayudas'],
    },
    preferencias_extra: '',
    ...overrides,
  };
}

function alert(id, overrides = {}) {
  return {
    id,
    titulo: `Ayuda agraria ${id}`,
    url: `https://boletin.example/alerta-${id}`,
    fecha: '2026-08-10',
    region: 'Aragon',
    fuente: 'BOA',
    contenido: 'Convocatoria oficial para titulares de explotaciones agrarias de Zaragoza.',
    provincias: ['Zaragoza'],
    sectores: ['agricultura'],
    subsectores: [],
    tipos_alerta: ['ayudas'],
    estado_ia: 'descartado',
    duplicado_de: null,
    ...overrides,
  };
}

function validResponse(userId, included = [], excluded = []) {
  return JSON.stringify({
    decision_version: CONTRACT_VERSION,
    user_id: userId,
    included,
    excluded,
  });
}

test('solo filtra una incompatibilidad territorial oficialmente conocida', () => {
  const result = evaluarFiltrosObjetivos({
    alerta: alert(1, { provincias: ['Huesca'], region: 'Aragon' }),
    user: user(),
    sentAlertIds: new Set(),
  });
  assert.strictEqual(result.excluded, true);
  assert.strictEqual(result.exclusion.code, 'official_territory_compatible');

  const unknown = evaluarFiltrosObjetivos({
    alerta: alert(2, { fuente: 'FUENTE_DESCONOCIDA', provincias: [], region: '', contenido: '' }),
    user: user(),
    sentAlertIds: new Set(),
  });
  assert.strictEqual(unknown.excluded, false, 'territorio desconocido no se convierte en exclusion semantica');
});

test('conserva deduplicacion de publicacion e historial usuario-alerta', () => {
  const duplicate = evaluarFiltrosObjetivos({
    alerta: alert(3, { duplicado_de: 2 }),
    user: user(),
    sentAlertIds: new Set(),
  });
  assert.strictEqual(duplicate.exclusion.code, 'publication_not_duplicate');

  const sent = evaluarFiltrosObjetivos({
    alerta: alert(4),
    user: user(),
    sentAlertIds: new Set([4]),
  });
  assert.strictEqual(sent.exclusion.code, 'not_previously_sent_to_user');
});

test('exige URL oficial utilizable antes del LLM', () => {
  const result = evaluarFiltrosObjetivos({
    alerta: alert(5, { url: 'javascript:alert(1)' }),
    user: user(),
    sentAlertIds: new Set(),
  });
  assert.strictEqual(result.exclusion.code, 'official_url_usable');
});

test('pac dentro de impacto no activa una exclusion explicita PAC', () => {
  assert.strictEqual(contieneTerminoCompleto('evaluacion de impacto ambiental', 'pac'), false);
  assert.strictEqual(contieneTerminoCompleto('ayudas de la PAC para agricultores', 'pac'), true);
  const profile = user({ preferencias_extra: 'No quiero PAC.' });
  const impact = evaluarFiltrosObjetivos({
    alerta: alert(6, {
      titulo: 'Evaluacion de impacto ambiental',
      contenido: 'Informacion publica sobre el impacto de una instalacion.',
      sectores: [],
      tipos_alerta: [],
    }),
    user: profile,
    sentAlertIds: new Set(),
  });
  assert.strictEqual(impact.excluded, false);

  const pac = evaluarFiltrosObjetivos({
    alerta: alert(7, { titulo: 'Modificacion de ayudas de la PAC' }),
    user: profile,
    sentAlertIds: new Set(),
  });
  assert.strictEqual(pac.exclusion.code, 'explicit_preference_compatible');
});

test('no usa estado IA, score, taxonomia o resumen como barrera', () => {
  const prepared = prepararEntradaDecisionV2({
    user: user(),
    alerts: [alert(8, {
      estado_ia: 'descartado',
      pre_score: -999,
      pre_status: 'discarded',
      sectores: [],
      taxonomy_tags: ['no_rural'],
      resumen_final: 'Sin relacion rural segun clasificador anterior.',
    })],
    sentAlertIds: new Set(),
  });
  assert.deepStrictEqual(prepared.candidates.map((item) => item.snapshot.alert_id), [8]);
  assert.strictEqual(prepared.llmInput.candidates[0].derived.ai_state, 'descartado');
  assert(prepared.llmInput.candidates[0].official.content_fragment.includes('explotaciones agrarias'));
});

test('trata la suscripcion solo como plan comercial y no como prueba de beneficiario', () => {
  const prepared = prepararEntradaDecisionV2({
    user: user({
      subscription: 'agricultor',
      preferences: {
        provincias: ['Zaragoza'],
        sectores: [],
        subsectores: [],
        cultivos: [],
        especies: [],
        tipos_alerta: [],
      },
    }),
    alerts: [alert(81, {
      titulo: 'Ayuda para empresas de servicios digitales',
      contenido: 'Convocatoria oficial dirigida exclusivamente a empresas de servicios digitales.',
      sectores: [],
      tipos_alerta: [],
    })],
  });

  assert.strictEqual(prepared.profile.subscription, 'agricultor');
  assert.strictEqual(prepared.policy.subscription_meaning, 'commercial_plan_only');
  assert.strictEqual(prepared.policy.subscription_role_inference, 'forbidden');
  assert.deepStrictEqual(prepared.policy.beneficiary_fit_requires, [
    'explicit_profile_information',
    'official_document_evidence',
  ]);
  assert.match(prepared.policy.system_prompt, /plan de suscripcion es solo un plan comercial/i);
  assert.match(prepared.policy.system_prompt, /nunca demuestra que el usuario sea agricultor/i);
  assert.match(prepared.policy.system_prompt, /informacion explicita del perfil/i);
  assert.match(prepared.policy.system_prompt, /documento oficial/i);
});

test('valida cobertura exacta, IDs, duplicados y maximo', () => {
  const prepared = prepararEntradaDecisionV2({
    user: user(),
    alerts: [alert(9), alert(10)],
  });
  const duplicate = validarRespuestaDecisionV2(validResponse(501, [
    { alert_id: 9, priority: 1, reason: 'Encaja.', evidence: ['Texto oficial.'] },
  ], [
    { alert_id: 9, reason: 'No encaja.', evidence: ['Texto oficial.'] },
  ]), {
    userId: 501,
    candidates: prepared.candidates,
    maxIncluded: 1,
  });
  assert.strictEqual(duplicate.ok, false);
  assert(duplicate.errors.some((error) => error.code === 'duplicate_alert_id'));
  assert(duplicate.errors.some((error) => error.code === 'missing_candidate_ids'));

  const repeatedPriority = validarRespuestaDecisionV2(validResponse(501, [
    { alert_id: 9, priority: 1, reason: 'Encaja.', evidence: ['Texto oficial.'] },
    { alert_id: 10, priority: 1, reason: 'Tambien encaja.', evidence: ['Texto oficial.'] },
  ], []), {
    userId: 501,
    candidates: prepared.candidates,
    maxIncluded: 2,
  });
  assert.strictEqual(repeatedPriority.ok, false);
  assert(repeatedPriority.errors.some((error) => error.code === 'invalid_priority_sequence'));
});

test('hace una sola decision conjunta y conserva todas las candidatas una vez', async () => {
  let calls = 0;
  let received = null;
  const result = await ejecutarDecisionV2({
    user: user(),
    alerts: [alert(11), alert(12), alert(11)],
    maxIncluded: 2,
    callLLM: async ({ input }) => {
      calls += 1;
      received = JSON.parse(input);
      return validResponse(501, [
        { alert_id: 11, priority: 1, reason: 'Relacion directa.', evidence: ['Titulares de explotaciones agrarias.'] },
      ], [
        { alert_id: 12, reason: 'Menor relevancia conjunta.', evidence: ['Convocatoria general.'] },
      ]);
    },
  });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(received.candidates.map((item) => item.alert_id), [11, 12]);
  assert.strictEqual(result.status, 'GENERATED');
  assert.deepStrictEqual(result.selected_alerts.map((item) => item.id), [11]);
  assert.strictEqual(result.decisions.length, 2);
  assert.strictEqual(result.duplicate_input_count, 1);
});

test('permite exactamente un reintento para corregir formato', async () => {
  const inputs = [];
  const result = await ejecutarDecisionV2({
    user: user(),
    alerts: [alert(13)],
    maxIncluded: 1,
    callLLM: async ({ input }) => {
      inputs.push(input);
      if (inputs.length === 1) return '{invalido';
      return validResponse(501, [
        { alert_id: 13, priority: 1, reason: 'Encaja.', evidence: ['Evidencia oficial.'] },
      ], []);
    },
  });
  assert.strictEqual(inputs.length, 2);
  assert(inputs[1].includes('Corrige exclusivamente el formato tecnico'));
  assert.strictEqual(result.status, 'GENERATED');
  assert.strictEqual(result.llm_attempts, 2);
});

test('registra ERROR si el contrato vuelve a fallar, sin fallback semantico', async () => {
  let calls = 0;
  const result = await ejecutarDecisionV2({
    user: user(),
    alerts: [alert(14)],
    callLLM: async () => {
      calls += 1;
      return '{sigue-invalido';
    },
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(result.status, 'ERROR');
  assert.strictEqual(result.error_code, 'invalid_llm_contract');
  assert.strictEqual(result.selected_alerts.length, 0);
  assert.strictEqual(result.decisions[0].decision, null);
});

test('registra ERROR inmediato ante fallo tecnico', async () => {
  let calls = 0;
  const result = await ejecutarDecisionV2({
    user: user(),
    alerts: [alert(15)],
    callLLM: async () => {
      calls += 1;
      throw new Error('servicio no disponible');
    },
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(result.status, 'ERROR');
  assert.strictEqual(result.error_code, 'llm_technical_error');
  assert.strictEqual(result.selected_alerts.length, 0);
});

test('conserva muchas candidatas y sus truncamientos ante un limite tecnico', async () => {
  const candidateCount = 240;
  const alerts = Array.from({ length: candidateCount }, (_, index) => alert(2000 + index, {
    titulo: `Documento oficial extenso ${index + 1}`,
    contenido: `Contenido oficial ${index + 1}. ${'evidencia rural '.repeat(180)}`,
  }));
  const expectedIds = alerts.map((item) => item.id);
  let receivedIds = [];
  const result = await ejecutarDecisionV2({
    user: user(),
    alerts,
    totalOfficialChars: 50000,
    callLLM: async ({ input }) => {
      receivedIds = JSON.parse(input).candidates.map((candidate) => candidate.alert_id);
      const error = new Error('context_length_exceeded');
      error.metadata = {
        response_status: 'error',
        technical_limit: 'context_length_exceeded',
      };
      throw error;
    },
  });

  assert.deepStrictEqual(receivedIds, expectedIds, 'la peticion conjunta debe conservar todos los IDs');
  assert.deepStrictEqual(
    result.candidates_snapshot.map((snapshot) => snapshot.alert_id),
    expectedIds,
    'los snapshots auditables deben conservar todos los IDs'
  );
  assert(result.candidates_snapshot.every((snapshot) => snapshot.official.content_truncated === true));
  assert(result.candidates_snapshot.every((snapshot) =>
    snapshot.official.content_original_chars > snapshot.official.content_fragment.length
  ));
  assert.strictEqual(result.status, 'ERROR');
  assert.strictEqual(result.error_code, 'llm_technical_error');
  assert.strictEqual(result.error_details.technical_limit, 'context_length_exceeded');
  assert.strictEqual(result.decisions.length, candidateCount);
  assert(result.decisions.every((decision) =>
    decision.decision_source === 'technical_error' && decision.decision === null
  ));
});

test('devuelve EMPTY sin llamar al LLM cuando todas quedan objetivamente fuera', async () => {
  let calls = 0;
  const result = await ejecutarDecisionV2({
    user: user(),
    alerts: [alert(16, { duplicado_de: 1 }), alert(17, { url: '' })],
    callLLM: async () => {
      calls += 1;
      throw new Error('no deberia llamarse');
    },
  });
  assert.strictEqual(calls, 0);
  assert.strictEqual(result.status, 'EMPTY');
  assert.strictEqual(result.decisions.length, 2);
  assert(result.decisions.every((decision) => decision.decision === 'exclude'));
});

test('devuelve EMPTY cuando el LLM excluye todas las candidatas', async () => {
  const result = await ejecutarDecisionV2({
    user: user(),
    alerts: [alert(18), alert(19)],
    callLLM: async () => validResponse(501, [], [
      { alert_id: 18, reason: 'No encaja.', evidence: ['Documento oficial 18.'] },
      { alert_id: 19, reason: 'No encaja.', evidence: ['Documento oficial 19.'] },
    ]),
  });
  assert.strictEqual(result.status, 'EMPTY');
  assert.strictEqual(result.selected_alerts.length, 0);
  assert(result.decisions.every((decision) => decision.decision === 'exclude'));
});

(async () => {
  let passed = 0;
  let failed = 0;
  console.log('\n=== TESTS: decision-v2 ===\n');
  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      console.log(`OK: ${item.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL: ${item.name}`);
      console.error(error.stack || error.message);
    }
  }
  console.log(`\nResultados decision-v2: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
})();
