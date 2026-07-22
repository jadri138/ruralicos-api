process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const corpus = require('./fixtures/audited-2026-07-21/false-discard-corpus.json');
const { crearPrefiltroRural } = require('../src/modules/boletines/scrapers/shared/ruralFilter');
const { preclassifyAlerta } = require('../src/modules/alertas/clasificacion/alertPreclassifier');
const {
  clasificarLocalmente,
  detectarExclusionDuraAlerta,
} = require('../src/modules/alertas/alertas.service');
const { evaluarBarreraRuralOficial } = require('../src/modules/alertas/clasificacion/officialRuralEvidenceGate');

const prefilter = crearPrefiltroRural();

for (const fixture of corpus.clear_cases) {
  const alerta = { ...fixture, id: fixture.id };
  const route = prefilter(`${fixture.titulo}\n${fixture.contenido}`);
  const preclassification = preclassifyAlerta(alerta);
  const classification = clasificarLocalmente(alerta);

  assert.notStrictEqual(route.action, 'discard', `${fixture.id}: el prefiltro no descarta`);
  assert.notStrictEqual(preclassification.pre_status, 'discard', `${fixture.id}: el preclasificador no descarta`);
  assert.strictEqual(classification.es_relevante, true, `${fixture.id}: el fallback local conserva el caso claro`);

  if (fixture.expected_types_any?.length) {
    assert(
      fixture.expected_types_any.some((type) => classification.tipos_alerta.includes(type)),
      `${fixture.id}: tipo esperado ${fixture.expected_types_any.join('|')}`
    );
  }
  if (fixture.expected_sectors_any?.length) {
    assert(
      fixture.expected_sectors_any.some((sector) => classification.sectores.includes(sector)),
      `${fixture.id}: sector esperado ${fixture.expected_sectors_any.join('|')}`
    );
  }
  if (fixture.expected_subsectors_any?.length) {
    assert(
      fixture.expected_subsectors_any.some((subsector) => classification.subsectores.includes(subsector)),
      `${fixture.id}: subsector esperado ${fixture.expected_subsectors_any.join('|')}`
    );
  }
  for (const forbidden of fixture.forbidden_types || []) {
    assert(!classification.tipos_alerta.includes(forbidden), `${fixture.id}: tipo obsoleto prohibido ${forbidden}`);
  }
  for (const forbidden of fixture.forbidden_discard_codes || []) {
    assert.notStrictEqual(classification.discard_reason_code, forbidden, `${fixture.id}: descarte falso ${forbidden}`);
  }
}

for (const fixture of corpus.evidence_cases) {
  const preclassification = preclassifyAlerta({ ...fixture, id: fixture.id });
  assert.strictEqual(preclassification.pre_status, fixture.expected_pre_status, fixture.id);
}

for (const fixture of corpus.doubtful_cases) {
  const alerta = { ...fixture, id: fixture.id };
  const preclassification = preclassifyAlerta(alerta);
  const classification = clasificarLocalmente(alerta);
  assert(
    ['review', 'needs_evidence', 'discard', 'keep'].includes(preclassification.pre_status),
    `${fixture.id}: resultado dudoso explicito`
  );
  if (!classification.es_relevante) {
    assert(classification.discard_reason_code, `${fixture.id}: descarte estructurado`);
    assert(classification.discard_reason, `${fixture.id}: descarte con motivo`);
  }
}

for (const fixture of corpus.false_reason_cases) {
  const gate = evaluarBarreraRuralOficial(fixture);
  const localReason = detectarExclusionDuraAlerta(fixture);
  for (const forbidden of fixture.forbidden_reason_codes) {
    assert.notStrictEqual(gate.reason_code, forbidden, `${fixture.id}: motivo incompatible ${forbidden}`);
    assert.notStrictEqual(localReason, forbidden, `${fixture.id}: exclusion local incompatible ${forbidden}`);
  }
  if (gate.action === 'discard') {
    assert(
      Array.isArray(gate.diagnostics.reason_evidence?.matched_patterns)
        && gate.diagnostics.reason_evidence.matched_patterns.length > 0,
      `${fixture.id}: un motivo de descarte debe auditar patrones positivos`
    );
  }
}

console.log(`OK: corpus auditado de falsos descartes (${corpus.clear_cases.length} claros, ${corpus.doubtful_cases.length} dudosos, ${corpus.false_reason_cases.length} motivos)`);
