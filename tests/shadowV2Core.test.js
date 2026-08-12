const assert = require('assert');
const corpus = require('./fixtures/shadow-v2/corpus.json');
const { prefilterAlert } = require('../src/modules/alertas/shadow-v2/prefilter');
const {
  matchClassificationToProfile,
  orderCandidates,
  signalsCompatible,
} = require('../src/modules/alertas/shadow-v2/profileMatch');
const { officialSnapshot } = require('../src/modules/alertas/shadow-v2/repository');

function snapshot(item) {
  return {
    alert_id: item.id,
    title: item.title,
    organization: item.organization,
    source: 'BOLETIN_OFICIAL',
    official_url: `https://example.test/${item.id}`,
    official_content: item.official_content,
    duplicate_of: null,
  };
}

for (const item of [...corpus.excluded, ...corpus.accepted_by_ai1]) {
  assert.strictEqual(
    prefilterAlert(snapshot(item)).passed,
    item.expected_prefilter ?? true,
    `prefiltro inesperado para ${item.title}`
  );
}
for (const item of corpus.excluded.filter((entry) => entry.ai1)) {
  assert(
    item.ai1.relevant === false || item.ai1.actionable === false || item.ai1.status === 'closed',
    `${item.title} debe quedar fuera tras IA 1`
  );
}
for (const item of corpus.accepted_by_ai1) {
  assert.strictEqual(item.ai1.relevant, true);
  assert.strictEqual(item.ai1.actionable, true);
  assert.notStrictEqual(item.ai1.status, 'closed');
}

const uncertain = prefilterAlert(snapshot({
  id: 999,
  title: 'Información pública de una nueva disposición',
  organization: 'Administración autonómica',
  official_content: 'Se abre un trámite de información pública.',
}));
assert.strictEqual(uncertain.passed, true);
assert(uncertain.reasons.includes('uncertain_forwarded'));

const duplicate = prefilterAlert({ ...snapshot(corpus.accepted_by_ai1[0]), duplicate_of: 2 });
assert.strictEqual(duplicate.passed, false);
assert(duplicate.reasons.includes('duplicate_already_resolved'));

const byId = new Map(corpus.accepted_by_ai1.map((item) => [item.id, {
  alert_id: item.id,
  card: item.ai1,
  official_snapshot: { date: '2026-08-12' },
}]));
const bovine = byId.get(201);
const irrigation = byId.get(202);
const slurry = byId.get(203);

assert.strictEqual(matchClassificationToProfile({
  classification: bovine,
  user: { preferences: { provincias: ['Asturias'], actividades: ['bovino'], tipos_beneficiario: ['titular de explotación ganadera'] } },
}).candidate, true, 'vacuno y territorio compatibles deben generar candidata');
assert.strictEqual(signalsCompatible(['ganadería bovina'], ['vacuno']), true);
assert.strictEqual(signalsCompatible(['titular de explotación ganadera'], ['ganadero']), true);

assert.strictEqual(matchClassificationToProfile({
  classification: { ...irrigation, card: { ...irrigation.card, territories: { national: false, regions: ['Aragón'], provinces: [], municipalities: [] } } },
  user: { preferences: { provincias: ['Huesca'], actividades: ['frutales'], tipos_beneficiario: ['agricultor'] } },
}).candidate, true, 'una región explícita debe ser compatible con sus provincias');

assert.strictEqual(matchClassificationToProfile({
  classification: irrigation,
  user: { preferences: { provincias: ['Huesca'], actividades: ['frutales'], tipos_beneficiario: ['agricultor'] } },
}).candidate, true, 'frutales y territorio compatibles deben generar candidata');

const farmerWithoutLivestock = matchClassificationToProfile({
  classification: slurry,
  user: { preferences: { provincias: ['Segovia'], actividades: ['agricultura'], tipos_beneficiario: ['agricultor'] } },
});
assert.strictEqual(farmerWithoutLivestock.candidate, false);
assert(farmerWithoutLivestock.reasons.includes('activity_mismatch'));

const sameTerritoryNotEnough = matchClassificationToProfile({
  classification: bovine,
  user: { preferences: { provincias: ['Asturias'], actividades: ['turismo'], tipos_beneficiario: ['entidad local'] } },
});
assert.strictEqual(sameTerritoryNotEnough.candidate, false);

const sent = matchClassificationToProfile({
  classification: bovine,
  user: { preferences: { provincias: ['Asturias'], actividades: ['bovino'] } },
  sentAlertIds: [201],
});
assert.strictEqual(sent.candidate, false);
assert(sent.reasons.includes('already_sent'));

const closed = matchClassificationToProfile({
  classification: { alert_id: 300, card: { ...bovine.card, status: 'closed' } },
  user: { preferences: { provincias: ['Asturias'], actividades: ['bovino'] } },
});
assert.strictEqual(closed.candidate, false);

const ordered = orderCandidates([
  { alert_id: 2, card: { status: 'upcoming', deadline: '2026-08-14' }, official_snapshot: { date: '2026-08-12' } },
  { alert_id: 3, card: { status: 'active', deadline: '2026-09-01' }, official_snapshot: { date: '2026-08-12' } },
  { alert_id: 1, card: { status: 'active', deadline: '2026-08-13' }, official_snapshot: { date: '2026-08-11' } },
], new Date('2026-08-12T12:00:00Z'));
assert.deepStrictEqual(ordered.map((item) => item.alert_id), [1, 3, 2]);

const truncated = officialSnapshot(
  { id: 77, titulo: 'Texto largo', contenido: 'x'.repeat(1200), duplicado_de: null },
  null,
  1000
);
assert.strictEqual(truncated.official_content.length, 1000);
assert.strictEqual(truncated.official_content_truncated, true);
assert.strictEqual(truncated.official_content_original_chars, 1200);

console.log('OK: prefiltro, corpus 12 de agosto y cruce ficha-perfil shadow-v2');
