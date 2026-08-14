const assert = require('assert');
const corpus = require('./fixtures/shadow-v2/corpus.json');
const { prefilterAlert } = require('../src/modules/alertas/shadow-v2/prefilter');
const {
  RURAL_ORGANIZATIONS,
  RURAL_TERMS_BY_TOPIC,
} = require('../src/modules/alertas/shadow-v2/config');
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
assert.strictEqual(uncertain.passed, false);
assert.strictEqual(uncertain.decision, 'REJECT');
assert(uncertain.reasons.includes('no_rural_signal'));

const genericAid = prefilterAlert(snapshot({
  id: 998,
  title: 'Convocatoria de ayudas y subvenciones',
  organization: 'Consejería de Cultura',
  official_content: 'Las entidades interesadas podrán solicitar la ayuda dentro del plazo.',
}));
assert.strictEqual(genericAid.passed, false, 'las palabras administrativas genéricas no son señal rural');

const ambiguousPacInBody = prefilterAlert(snapshot({
  id: 995,
  title: 'Diligencia tributaria',
  organization: 'Administración tributaria',
  official_content: 'Leyenda de códigos: PAC, pago de subvenciones; RA, requerimiento de aceptación.',
}));
assert.strictEqual(ambiguousPacInBody.passed, false, 'PAC en una leyenda administrativa no es señal rural');

const pacInTitle = prefilterAlert(snapshot({
  id: 994,
  title: 'Solicitud única de la PAC 2026',
  organization: 'Administración autonómica',
  official_content: 'Se publica el trámite correspondiente.',
}));
assert.strictEqual(pacInTitle.passed, true, 'PAC en el título sí es una señal rural explícita');

const feminineLivestock = prefilterAlert(snapshot({
  id: 992,
  title: 'Licencia de actividad clasificada',
  organization: 'Ayuntamiento',
  official_content: 'Se solicita licencia para una explotacion bovina de cebo con 513 plazas.',
}));
assert.strictEqual(feminineLivestock.passed, true, 'bovina debe reconocerse como senal rural');
assert(feminineLivestock.detected_rural_terms.includes('bovina'));

for (const organization of RURAL_ORGANIZATIONS) {
  const result = prefilterAlert(snapshot({
    id: 997,
    title: 'Resolución administrativa',
    organization,
    official_content: 'Se publica la resolución.',
  }));
  assert.strictEqual(result.passed, true, `organismo rural no detectado: ${organization}`);
  assert(result.detected_organizations.includes(organization));

  const inTitle = prefilterAlert(snapshot({
    id: 993,
    title: `${organization}: resolución administrativa`,
    organization: 'Administración general',
    official_content: 'Se publica la resolución.',
  }));
  assert.strictEqual(inTitle.passed, true, `organismo rural no detectado en título: ${organization}`);
}

for (const [topic, terms] of Object.entries(RURAL_TERMS_BY_TOPIC)) {
  for (const term of terms) {
    const result = prefilterAlert(snapshot({
      id: 996,
      title: `Publicación sobre ${term}`,
      organization: 'Administración autonómica',
      official_content: 'Información oficial.',
    }));
    assert.strictEqual(result.passed, true, `vocabulario rural no detectado: ${topic}/${term}`);
    assert(result.detected_rural_terms.includes(term));
  }
}

const duplicate = prefilterAlert({ ...snapshot(corpus.accepted_by_ai1[0]), duplicate_of: 2 });
assert.strictEqual(duplicate.passed, false);
assert.strictEqual(duplicate.decision, 'REJECT');
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
assert.strictEqual(signalsCompatible(['agricultura'], ['trigo']), true);
assert.strictEqual(signalsCompatible(['agricultura'], ['frutales']), true);
assert.strictEqual(signalsCompatible(['agricultura'], ['frutos_secos']), true);
assert.strictEqual(signalsCompatible(['agricultura'], ['semillas']), true);
assert.strictEqual(signalsCompatible(['ganaderia'], ['ovino']), true);
assert.strictEqual(signalsCompatible(['ganaderia'], ['caprinas']), true);
assert.strictEqual(signalsCompatible(['bovino'], ['porcino']), false, 'dos subtipos hermanos no son equivalentes');
assert.strictEqual(signalsCompatible(['vacuna'], ['bovino']), false, 'vacuna no debe interpretarse como ganado vacuno');
assert.strictEqual(signalsCompatible(['frutales'], ['cereal']), false, 'dos cultivos hermanos no son equivalentes');
assert.strictEqual(signalsCompatible(['ganaderia bovina'], ['porcino']), false, 'un subtipo explicito no debe abrir toda la familia');

assert.strictEqual(matchClassificationToProfile({
  classification: { ...irrigation, card: { ...irrigation.card, territories: { national: false, regions: ['Aragón'], provinces: [], municipalities: [] } } },
  user: { preferences: { provincias: ['Huesca'], actividades: ['frutales'], tipos_beneficiario: ['agricultor'] } },
}).candidate, true, 'una región explícita debe ser compatible con sus provincias');

assert.strictEqual(matchClassificationToProfile({
  classification: irrigation,
  user: { preferences: { provincias: ['Huesca'], actividades: ['frutales'], tipos_beneficiario: ['agricultor'] } },
}).candidate, true, 'frutales y territorio compatibles deben generar candidata');

assert.strictEqual(matchClassificationToProfile({
  classification: {
    ...irrigation,
    card: { ...irrigation.card, activities: ['agricultura'], beneficiary_types: [] },
  },
  user: { preferences: { provincias: ['Huesca'], subsectores: ['trigo', 'cebada'] } },
}).candidate, true, 'la actividad padre agricultura debe encajar con subsectores agricolas concretos');

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
