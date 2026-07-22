process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const fixtures = require('./fixtures/p0/original-edges.json');
const {
  cultivosEspecificosAlerta,
  diagnosticarAlertaUsuario,
} = require('../src/modules/alertas/seleccion/alertaMatcher');
const {
  DOCUMENT_RELATION,
  clasificarRelacionDocumental,
  esRelacionDuplicada,
} = require('../src/modules/alertas/intelligence/documentRelation');
const {
  construirPersistenciaBarreraRural,
  evaluarBarreraRuralOficial,
} = require('../src/modules/alertas/clasificacion/officialRuralEvidenceGate');

function user(subsectores = []) {
  return {
    plan: 'premium',
    preferences: {
      provincias: [],
      sectores: ['agricultura'],
      subsectores,
      tipos_alerta: {},
    },
  };
}

for (const fixture of fixtures.crop_cases) {
  assert.deepStrictEqual(
    cultivosEspecificosAlerta(fixture.alert),
    fixture.expected_crops,
    `${fixture.id}: cultivo inferido solo desde evidencia documental`
  );
  const general = diagnosticarAlertaUsuario(fixture.alert, user());
  assert.strictEqual(
    fixture.general_user_result === 'allow' ? general.ok : general.motivo,
    fixture.general_user_result === 'allow' ? true : fixture.general_user_result,
    `${fixture.id}: perfil general`
  );
  if (fixture.matching_user_result === 'allow') {
    assert.strictEqual(diagnosticarAlertaUsuario(fixture.alert, user(['trigo'])).ok, true, fixture.id);
  }
}

for (const fixture of fixtures.incomplete_evidence_cases) {
  const gate = evaluarBarreraRuralOficial(fixture);
  assert.strictEqual(gate.action, 'needs_evidence', fixture.id);
  assert.strictEqual(gate.reason_code, 'contenido_oficial_insuficiente', fixture.id);
  assert(gate.diagnostics.reason_evidence.matched_patterns.includes(fixture.expected_pattern), fixture.id);
  const persistence = construirPersistenciaBarreraRural(fixture, gate);
  assert.strictEqual(persistence.patch.estado_ia, 'needs_evidence', fixture.id);
  assert.deepStrictEqual(
    persistence.patch.decision_audit.official_rural_gate.diagnostics.reason_evidence,
    gate.diagnostics.reason_evidence,
    `${fixture.id}: auditoria de evidencia persistida`
  );
}

const { original, update, correction, republication, other_organization: otherOrganization } = fixtures.document_relations;
for (const [left, right, expected] of [
  [original, update, DOCUMENT_RELATION.LEGAL_UPDATE],
  [update, original, DOCUMENT_RELATION.LEGAL_UPDATE],
  [original, correction, DOCUMENT_RELATION.LEGAL_CORRECTION],
  [correction, original, DOCUMENT_RELATION.LEGAL_CORRECTION],
]) {
  const relation = clasificarRelacionDocumental(left, right);
  assert.strictEqual(relation.relation, expected, `${left.id} -> ${right.id}`);
  assert.strictEqual(esRelacionDuplicada(relation.relation), false, `${left.id} -> ${right.id}`);
}

assert.strictEqual(
  clasificarRelacionDocumental(original, republication).relation,
  DOCUMENT_RELATION.CROSS_SOURCE_REPUBLICATION
);
assert.strictEqual(
  clasificarRelacionDocumental(original, otherOrganization).relation,
  DOCUMENT_RELATION.NEW,
  'misma referencia con organismos distintos no es republicacion'
);

console.log('OK: bordes P0 de cultivos, evidencia incompleta y relaciones documentales');
