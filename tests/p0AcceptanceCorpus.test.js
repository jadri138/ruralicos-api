process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  diagnosticarAlertaUsuario,
  diagnosticarCoherenciaTaxonomicaAlerta,
  resolverTerritorioAlerta,
} = require('../src/modules/alertas/seleccion/alertaMatcher');
const {
  normalizarClasificacionCanonica,
} = require('../src/shared/taxonomyRegistry');
const {
  crearPrefiltroRural,
} = require('../src/modules/boletines/scrapers/shared/ruralFilter');
const {
  esEnvioAutomaticoPermitido,
} = require('../src/modules/digest/digest.service');
const {
  construirPersistenciaBarreraRural,
  evaluarBarreraRuralOficial,
} = require('../src/modules/alertas/clasificacion/officialRuralEvidenceGate');
const {
  esDescarteAuditable,
} = require('../src/modules/alertas/clasificacion/discardDecision');
const {
  prepararReparacionDescarteHistorico,
} = require('../src/modules/alertas/clasificacion/legacyDiscardRepair');
const {
  describirEstadoPendiente,
} = require('../src/modules/alertas/alertPipelineStates');
const {
  evaluarCalidadEvidencia,
} = require('../src/modules/boletines/scrapers/BOPA/bopaScraper');

const fixturePath = path.join(__dirname, 'fixtures', 'p0', 'acceptance-corpus.json');
const corpus = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(error.stack || error.message);
  }
}

test('corpus P0.4 bloquea los seis negativos oficiales conocidos', () => {
  assert.strictEqual(corpus.official_rural_gate.negative_cases.length, 6);
  for (const fixture of corpus.official_rural_gate.negative_cases) {
    const gate = evaluarBarreraRuralOficial(fixture);
    assert.strictEqual(gate.action, 'discard', fixture.id);
    assert.strictEqual(gate.reason_code, fixture.expected_reason_code, fixture.id);
    const persistence = construirPersistenciaBarreraRural(fixture, gate);
    assert.strictEqual(persistence.patch.estado_ia, 'descartado', fixture.id);
    assert.strictEqual(persistence.patch.discard_stage, 'official_rural_gate', fixture.id);
  }
});

test('corpus P0.4 nunca descarta controles agrarios positivos', () => {
  assert(corpus.official_rural_gate.agrarian_positive_cases.length >= 2);
  for (const fixture of corpus.official_rural_gate.agrarian_positive_cases) {
    const gate = evaluarBarreraRuralOficial(fixture);
    assert.strictEqual(gate.action, fixture.expected_action, fixture.id);
    assert.strictEqual(construirPersistenciaBarreraRural(fixture, gate), null, fixture.id);
  }
});

test('corpus P0.2 conserva expansion autonomica y prioridad provincial', () => {
  for (const fixture of Object.values(corpus.territory)) {
    const result = resolverTerritorioAlerta(fixture.alert);
    for (const province of fixture.expected_contains) {
      assert(result.provincias_normalizadas.includes(province), `${province} ausente`);
    }
    for (const province of fixture.expected_excludes) {
      assert(!result.provincias_normalizadas.includes(province), `${province} no debe estar`);
    }
  }
});

test('corpus P0.1 detecta la taxonomia incoherente', () => {
  const fixture = corpus.taxonomy.incoherent;
  const result = diagnosticarCoherenciaTaxonomicaAlerta(fixture.alert);
  assert(result);
  assert.strictEqual(result.motivo, fixture.expected_reason);
});

test('corpus P0.3 distingue BOPA sin evidencia y recuperado', () => {
  const missing = corpus.bopa.without_evidence;
  const missingQuality = evaluarCalidadEvidencia(missing.texto);
  assert.strictEqual(missingQuality.valida, missing.expected_valid);
  assert.strictEqual(missingQuality.razon, missing.expected_reason);
  assert.strictEqual(missing.estado_ia, 'needs_evidence');

  const recovered = corpus.bopa.recovered;
  const recoveredQuality = evaluarCalidadEvidencia(recovered.texto);
  assert.strictEqual(recoveredQuality.valida, recovered.expected_valid);
  assert.strictEqual(recovered.estado_ia_before, 'needs_evidence');
  assert.strictEqual(recovered.estado_ia_after, 'pendiente_clasificar');
});

test('corpus P0.5 distingue descarte legacy estructurado e incompleto', () => {
  const structured = corpus.discards.structured_legacy;
  const incomplete = corpus.discards.incomplete_legacy;
  assert.strictEqual(esDescarteAuditable(structured), true);
  assert.strictEqual(esDescarteAuditable(incomplete), false);

  const plan = prepararReparacionDescarteHistorico(incomplete);
  assert.strictEqual(plan.status, 'repair_unknown_reason');
  assert.strictEqual(plan.patch.discard_reason_code, incomplete.expected_repair_code);
  assert.strictEqual(plan.patch.estado_ia, 'descartado');
});

test('corpus P0.4 retiene estados sin ruta automatica a listo', () => {
  assert.strictEqual(corpus.retained_states.length, 2);
  for (const fixture of corpus.retained_states) {
    const gate = evaluarBarreraRuralOficial(fixture.alert);
    const persistence = construirPersistenciaBarreraRural(fixture.alert, gate);
    assert(persistence, fixture.id);
    assert.strictEqual(persistence.patch.estado_ia, fixture.expected_state, fixture.id);
    assert.notStrictEqual(persistence.patch.estado_ia, fixture.forbidden_state, fixture.id);
    const state = describirEstadoPendiente(persistence.patch.estado_ia);
    assert.strictEqual(state.tipo_pendiente, 'retenido', fixture.id);
    assert.strictEqual(state.procesamiento_automatico, false, fixture.id);
  }
});

test('plan P0.1 conserva forestal municipal y descarta ruido administrativo', () => {
  const decidir = crearPrefiltroRural();
  for (const fixture of corpus.revised_plan.route_prefilter) {
    const decision = decidir(fixture.text);
    assert(
      fixture.allowed_actions.includes(decision.action),
      `${fixture.id}: ${decision.action} no pertenece a ${fixture.allowed_actions.join(', ')}`
    );
  }
});

test('plan P0.2 bloquea taxonomia vacia con accion de revision', () => {
  const fixture = corpus.revised_plan.empty_taxonomy;
  const result = diagnosticarAlertaUsuario(fixture.alert, {
    subscription: 'cooperativa',
    preferences: { provincias: [], sectores: [], subsectores: [], tipos_alerta: {} },
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.action, fixture.expected_action);
  assert.strictEqual(result.reason, fixture.expected_reason);
});

test('plan P0.4 limpia la taxonomia contaminada de antibioticos', () => {
  const fixture = corpus.revised_plan.antibiotics;
  const normalized = normalizarClasificacionCanonica(fixture.alert, fixture.classification);
  assert.deepStrictEqual(normalized.sectores, fixture.expected_taxonomy.sectores);
  assert.deepStrictEqual(normalized.subsectores, fixture.expected_taxonomy.subsectores);
  assert.deepStrictEqual(normalized.tipos_alerta, fixture.expected_taxonomy.tipos_alerta);
  const resultTags = [
    ...normalized.sectores,
    ...normalized.subsectores,
    ...normalized.tipos_alerta,
  ];
  for (const forbidden of fixture.expected_taxonomy.forbidden) {
    assert(!resultTags.includes(forbidden), `etiqueta no respaldada: ${forbidden}`);
  }
});

test('plan P0.5 aplica la barrera ganadera antes del scoring', () => {
  const fixture = corpus.revised_plan.antibiotics;
  const normalized = normalizarClasificacionCanonica(fixture.alert, fixture.classification);
  const alert = { ...fixture.alert, ...normalized };
  for (const profile of fixture.profiles) {
    const result = diagnosticarAlertaUsuario(alert, {
      subscription: 'cooperativa',
      preferences: {
        provincias: [],
        sectores: profile.sectores,
        subsectores: profile.subsectores,
        tipos_alerta: profile.expected_match ? { sanidad_animal: true } : { normativa_general: true },
      },
    });
    assert.strictEqual(result.ok, profile.expected_match, `${profile.id}: ${result.motivo}`);
    if (!profile.expected_match) {
      assert.strictEqual(result.motivo, 'animal_health_requires_livestock_profile', profile.id);
    }
  }
});

test('plan P0.6 hace fail-closed la decision ausente', () => {
  for (const [id, fixture] of Object.entries(corpus.revised_plan.decision_digest)) {
    assert.strictEqual(
      esEnvioAutomaticoPermitido(fixture.decision, fixture.options || {}),
      fixture.expected_allowed,
      id
    );
  }
});

test('plan P0.8 agrupa las regresiones forestal, ruido, sector y taxonomia', () => {
  assert.strictEqual(corpus.revised_plan.route_prefilter.length, 5);
  assert.strictEqual(corpus.revised_plan.antibiotics.profiles.length, 4);
  assert.strictEqual(corpus.revised_plan.empty_taxonomy.expected_action, 'review');
});

console.log(`\nResultados p0AcceptanceCorpus: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed === 0 ? 0 : 1);
