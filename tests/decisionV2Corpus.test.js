const assert = require('assert');
const corpus = require('./fixtures/decision-v2/corpus.json');
const {
  CONTRACT_VERSION,
  ejecutarDecisionV2,
} = require('../src/modules/alertas/decision-v2/decisionEngine');

function buildAlert(item) {
  return {
    id: item.id,
    titulo: item.title,
    url: `https://boletin.example/documentos/${item.id}`,
    fecha: '2026-08-10',
    region: item.province,
    fuente: 'BOE',
    contenido: item.official_content,
    provincias: [item.province],
    sectores: [],
    subsectores: [],
    tipos_alerta: [],
    estado_ia: item.expected === 'include' ? 'descartado' : 'listo',
    resumen_final: item.derived_summary,
    duplicado_de: null,
  };
}

(async () => {
  console.log('\n=== TESTS: corpus contractual decision-v2 con LLM simulado ===\n');
  let calls = 0;
  let payload = null;
  const expectedById = new Map(corpus.cases.map((item) => [item.id, item]));
  const result = await ejecutarDecisionV2({
    user: corpus.profile,
    alerts: corpus.cases.map(buildAlert),
    maxIncluded: 5,
    callLLM: async ({ input }) => {
      calls += 1;
      payload = JSON.parse(input);
      let priority = 0;
      const included = [];
      const excluded = [];
      for (const candidate of payload.candidates) {
        const fixture = expectedById.get(candidate.alert_id);
        if (fixture.expected === 'include') {
          priority += 1;
          included.push({
            alert_id: fixture.id,
            priority,
            reason: 'Relacion rural respaldada por el documento oficial.',
            evidence: [fixture.evidence],
          });
        } else {
          excluded.push({
            alert_id: fixture.id,
            reason: 'No existe relacion agraria respaldada por el documento oficial.',
            evidence: [fixture.evidence],
          });
        }
      }
      return JSON.stringify({
        decision_version: CONTRACT_VERSION,
        user_id: corpus.profile.id,
        needs_review: false,
        review_reason: '',
        included,
        excluded,
      });
    },
  });

  assert.strictEqual(calls, 1, 'todo el corpus debe decidirse en una unica llamada conjunta');
  assert.strictEqual(payload.candidates.length, corpus.cases.length);
  assert.deepStrictEqual(
    result.decisions.filter((item) => item.decision === 'include').map((item) => item.alert_id),
    corpus.cases.filter((item) => item.expected === 'include').map((item) => item.id)
  );
  assert.deepStrictEqual(
    result.decisions.filter((item) => item.decision === 'exclude').map((item) => item.alert_id),
    corpus.cases.filter((item) => item.expected === 'exclude').map((item) => item.id)
  );

  for (const fixture of corpus.cases) {
    const candidate = payload.candidates.find((item) => item.alert_id === fixture.id);
    assert(candidate, `falta candidata ${fixture.id}`);
    assert(candidate.official.content_fragment.includes(fixture.official_content));
    assert.strictEqual(candidate.derived.final_summary, fixture.derived_summary);
  }

  const impacto = payload.candidates.find((item) => item.alert_id === 7103);
  assert(impacto.official.content_fragment.includes('impacto ambiental'));
  assert(!/\bPAC\b/.test(impacto.official.content_fragment));
  assert(/PAC/.test(impacto.derived.final_summary), 'el dato enganoso queda marcado como derivado');
  assert.strictEqual(result.status, 'GENERATED');
  console.log('OK: siete casos observados recorren el contrato conjunto con decisiones simuladas');
  console.log('\nResultados corpus contractual decision-v2: 1 aprobado, 0 fallidos');
})().catch((error) => {
  console.error('FAIL: corpus contractual decision-v2 con LLM simulado');
  console.error(error.stack || error.message);
  process.exit(1);
});
