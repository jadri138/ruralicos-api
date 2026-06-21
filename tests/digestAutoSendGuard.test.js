process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
  esEnvioAutomaticoPermitido,
  filtrarAlertasEnviablesAutomaticamente,
} = require('../src/modules/digest/digest.service');
const {
  seleccionarAlertasParaDigest,
} = require('../src/modules/alertas/seleccion/alertSelectionEngine');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err.message);
  }
}

console.log('\n=== TESTS: digest auto-send guard (review_only) ===\n');

test('una alerta review_only con incluir=true NO es enviable automaticamente', () => {
  assert.strictEqual(
    esEnvioAutomaticoPermitido({ action: 'review_only', incluir: true }),
    false
  );
});

test('una alerta include con riesgo bajo SI es enviable automaticamente', () => {
  assert.strictEqual(
    esEnvioAutomaticoPermitido({ action: 'include', incluir: true, riesgo: 'bajo' }),
    true
  );
});

test('blocked y exclude nunca son enviables automaticamente', () => {
  assert.strictEqual(esEnvioAutomaticoPermitido({ action: 'blocked' }), false);
  assert.strictEqual(esEnvioAutomaticoPermitido({ action: 'exclude' }), false);
});

test('sin decision auditable se permite por compatibilidad (alertas antiguas / rescate suave)', () => {
  assert.strictEqual(esEnvioAutomaticoPermitido(null), true);
  assert.strictEqual(esEnvioAutomaticoPermitido({}), true);
  assert.strictEqual(esEnvioAutomaticoPermitido({ incluir: true }), true);
});

test('filtra alertas no enviables y conserva las include', () => {
  const { enviables, retenidas } = filtrarAlertasEnviablesAutomaticamente([
    { id: 1, decision_digest: { action: 'include', incluir: true } },
    { id: 2, decision_digest: { action: 'review_only', incluir: true, motivo: 'relleno_revision_segura' } },
    { id: 3, decision_digest: { action: 'exclude', incluir: false } },
    { id: 4 },
  ]);

  assert.deepStrictEqual(enviables.map((a) => a.id), [1, 4]);
  assert.strictEqual(retenidas.length, 2);
  const retenida2 = retenidas.find((r) => r.alerta_id === 2);
  assert.strictEqual(retenida2.action, 'review_only');
  assert.strictEqual(retenida2.motivo, 'relleno_revision_segura');
});

// Integracion con el motor: el relleno seguro entra al pool con action='review_only'
// (incoherencia review_only) y el gate debe retenerlo, dejando solo los include.
const user = {
  subscription: 'cooperativa',
  preferences: {
    provincias: ['Teruel'],
    sectores: ['agricultura'],
    subsectores: ['agua'],
    tipos_alerta: { ayudas_subvenciones: true },
  },
};

function ayudaInclude(id) {
  return {
    id,
    fuente: 'BOA',
    titulo: `Convocatoria de ayudas para riego agricola en Teruel ${id}`,
    url: `https://example.com/${id}`,
    fecha: '2026-06-04',
    estado_ia: 'listo',
    resumen_final: [
      'FICHA_IA',
      'TIPO: ayudas_subvenciones',
      'RESUMEN_DIGEST: Convocatoria de ayudas para explotaciones agrarias con plazo abierto y requisitos claros.',
      'HECHO: convocatoria de ayudas para riego agricola',
      'PLAZO: 20 dias habiles',
      'ACCION: presentar solicitud',
    ].join('\n'),
    contenido: 'Se convocan ayudas para explotaciones agrarias de Teruel con plazo de 20 dias habiles.',
    provincias: ['Teruel'],
    sectores: ['agricultura'],
    subsectores: ['agua'],
    tipos_alerta: ['ayudas_subvenciones'],
    embedding_generated_at: '2026-06-04T08:00:00Z',
    similitud: 0.7,
  };
}

function ayudaRevisionSegura(id) {
  return {
    id,
    fuente: 'BOA',
    titulo: `Ayudas para agricultura en Teruel ${id}`,
    url: `https://example.com/${id}`,
    fecha: '2026-06-04',
    estado_ia: 'listo',
    resumen_final: [
      'FICHA_IA',
      'TIPO: ayudas_subvenciones',
      'PRIORIDAD: baja',
      'RESUMEN_DIGEST: Se publican ayudas para explotaciones agrarias.',
      'HECHO: ayudas para agricultura',
    ].join('\n'),
    contenido: 'Se publican ayudas para explotaciones agrarias de Teruel.',
    provincias: ['Teruel'],
    sectores: ['agricultura'],
    subsectores: [],
    tipos_alerta: ['ayudas_subvenciones'],
    embedding_generated_at: '2026-06-04T08:00:00Z',
    similitud: 0.0,
  };
}

test('el relleno review_only del motor queda retenido por el gate (no autoenvio)', () => {
  const seleccion = seleccionarAlertasParaDigest(
    [ayudaInclude(305), ayudaRevisionSegura(300)],
    user,
    { minIncludeScore: 100, minReviewScore: 50, minReviewQualityScore: 60, minItems: 1, targetItems: 2, maxItems: 2, allowReview: true }
  );

  // El motor mete el review_only como relleno: action='review_only' aunque este en alertas[].
  const review = seleccion.alertas.find((a) => a.id === 300);
  assert.ok(review, 'el review_only debe entrar como relleno con allowReview=true');
  assert.strictEqual(review.decision_digest.action, 'review_only');

  const { enviables, retenidas } = filtrarAlertasEnviablesAutomaticamente(seleccion.alertas);
  assert.ok(!enviables.some((a) => a.id === 300), 'el review_only no debe ser enviable');
  assert.ok(retenidas.some((r) => r.alerta_id === 300), 'el review_only debe quedar retenido');
});

console.log(`\nResultados digestAutoSendGuard: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
