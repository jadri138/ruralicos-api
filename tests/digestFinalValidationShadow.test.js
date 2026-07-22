process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
  FINAL_VALIDATION_MODE,
  DIGEST_FINAL_VALIDATION_MODE,
  filtrarAlertasPorValidacionFinalDigest,
  guardarFactSheetsDigestShadow,
  prepararValidacionFinalDigestShadow,
  resolverModoValidacionFinal,
  resumirValidacionFinalDigest,
} = require('../src/modules/digest/digest.service');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function field(valor, evidencia = valor) {
  return {
    valor,
    evidencia,
    source: 'test',
    confidence: 0.95,
    status: valor && evidencia ? 'verified' : 'no_verificado',
  };
}

function factSheet(overrides = {}) {
  return {
    alerta_id: 501,
    schema_version: 'fact_sheet_v1',
    builder_version: 'fact_sheet_builder_v1',
    status: 'ready_for_digest',
    tipo_documento: field('convocatoria de ayudas'),
    tema_principal: field('Ayudas maquinaria'),
    resumen_neutro: field('Se convocan ayudas para maquinaria agricola.'),
    territorio: [field('Huesca')],
    sectores: [field('Agricultura')],
    subsectores: [field('maquinaria agricola')],
    accion_requerida: field('presentar solicitud'),
    plazo: field('hasta el 30 de junio de 2026'),
    beneficiarios: field('explotaciones agrarias'),
    importe: field('hasta 10.000 euros'),
    requisitos: [],
    url_oficial: field('https://boletin.example/501'),
    truth_score: 96,
    risk_score: 8,
    evidence_coverage: 0.92,
    flags: [],
    reasons: [],
    ...overrides,
  };
}

function alerta(overrides = {}) {
  return {
    id: 501,
    titulo: 'Ayudas maquinaria agricola',
    url: 'https://boletin.example/501',
    provincias: ['Huesca'],
    sectores: ['Agricultura'],
    tipos_alerta: ['ayudas_subvenciones'],
    decision_digest: {
      action: 'include',
      incluir: true,
      riesgo: 'bajo',
      score: 88,
      diagnostico: {
        policy: {
          matches: {
            provincia_expresa: true,
            sector_expreso: true,
            tipo_expreso: true,
          },
        },
      },
    },
    ...overrides,
  };
}

console.log('\n=== TESTS: digest final validation shadow ===\n');

test('prepara fact sheet y validacion final sin escribir en BD', async () => {
  const mensaje = [
    '*Ayudas*',
    '*1. URGENTE - Ayudas maquinaria agricola*',
    'En sencillo: Se convocan ayudas para explotaciones agrarias de Huesca.',
    'Que revisar: plazo hasta el 30 de junio de 2026 e importe de hasta 10.000 euros.',
    'https://boletin.example/501',
  ].join('\n');

  const result = await prepararValidacionFinalDigestShadow({
    mensaje,
    alertas: [alerta()],
    user: { preferences: { provincias: ['Huesca'] } },
    factSheets: { 501: factSheet() },
    loadFactSheetFn: async () => {
      throw new Error('no debe cargar si se inyecta fact sheet');
    },
    buildFactSheetFn: async () => {
      throw new Error('no debe construir si se inyecta fact sheet');
    },
  });

  assert.strictEqual(result.validation.status, 'send');
  assert.strictEqual(result.alertas[0].fact_sheet_status, 'ready_for_digest');
  assert.strictEqual(result.alertas[0].final_validation_status, 'send');
  assert.strictEqual(result.alertas[0].shadow_decision.future_decision, 'include');
  assert.strictEqual(result.validation_summary.items_send, 1);
});

test('construye fact sheet si no existe y deja en revision si la ficha lo exige', async () => {
  const result = await prepararValidacionFinalDigestShadow({
    mensaje: [
      '*1. PARA REVISAR - Ayudas maquinaria agricola*',
      'En sencillo: Puede interesarte si trabajas maquinaria agricola en Huesca.',
      'https://boletin.example/501',
    ].join('\n'),
    alertas: [alerta()],
    loadFactSheetFn: async () => null,
    buildFactSheetFn: async () => factSheet({
      status: 'review_only',
      truth_score: 82,
      risk_score: 42,
      evidence_coverage: 0.55,
    }),
  });

  assert.strictEqual(result.validation.status, 'review_only');
  assert.strictEqual(result.alertas[0].shadow_decision.future_decision, 'review_only');
  assert(result.alertas[0].final_validation_flags.includes('fact_sheet_review_only'));
});

test('guarda shadow decision con digest_id cuando hay digest insertado', async () => {
  const calls = [];
  const validation = {
    item_results: [{
      alerta_id: 501,
      status: 'blocked',
      flags: ['deadline_claim_without_evidence'],
      reasons: [{ code: 'deadline_claim_without_evidence', status: 'blocked', detail: 'sin plazo' }],
    }],
  };

  const result = await guardarFactSheetsDigestShadow({
    alertas: [{ ...alerta(), fact_sheet: factSheet() }],
    validation,
    organizationId: 12,
    digestId: 77,
    storeFactSheetFn: async (supabase, options) => {
      calls.push(options);
      return { ok: true, available: true, stored: true };
    },
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.stored, 1);
  assert.strictEqual(calls[0].shadowDecision.digest_id, 77);
  assert.strictEqual(calls[0].shadowDecision.future_decision, 'blocked');
});

test('enforcement solo acepta items con validacion send', async () => {
  const result = filtrarAlertasPorValidacionFinalDigest([
    alerta({ id: 501 }),
    alerta({ id: 502 }),
    alerta({ id: 503 }),
  ], {
    item_results: [
      { alerta_id: 501, status: 'send', flags: [], reasons: [] },
      { alerta_id: 502, status: 'review_only', flags: ['selection_review_only'], reasons: [] },
      { alerta_id: 503, status: 'blocked', flags: ['fact_sheet_blocked'], reasons: [] },
    ],
  });

  assert.strictEqual(result.aceptadas.length, 1);
  assert.strictEqual(result.rechazadas.length, 2);
  assert.strictEqual(result.summary.blocked, 1);
  assert.strictEqual(result.summary.review_only, 1);
});

test('resuelve modo nuevo y mantiene compatibilidad con booleano legacy', async () => {
  assert.strictEqual(DIGEST_FINAL_VALIDATION_MODE, FINAL_VALIDATION_MODE.ENFORCE);
  assert.strictEqual(resolverModoValidacionFinal({}), FINAL_VALIDATION_MODE.ENFORCE);
  assert.strictEqual(
    resolverModoValidacionFinal({ mode: 'critical', legacyEnforcement: 'false' }),
    FINAL_VALIDATION_MODE.CRITICAL
  );
  assert.strictEqual(
    resolverModoValidacionFinal({ mode: '', legacyEnforcement: 'true' }),
    FINAL_VALIDATION_MODE.ENFORCE
  );
  assert.strictEqual(
    resolverModoValidacionFinal({ mode: '', legacyEnforcement: 'false' }),
    FINAL_VALIDATION_MODE.SHADOW
  );
});

test('critical ya no relaja el gate automatico: solo send es enviable', async () => {
  const result = filtrarAlertasPorValidacionFinalDigest([
    alerta({ id: 601 }),
    alerta({ id: 602 }),
    alerta({
      id: 603,
      fact_sheet: { flags: ['notificacion_individual'] },
    }),
  ], {
    item_results: [
      {
        alerta_id: 601,
        status: 'blocked',
        flags: ['territory_claim_without_evidence'],
        reasons: [],
      },
      {
        alerta_id: 602,
        status: 'blocked',
        flags: ['deadline_claim_without_evidence'],
        reasons: [],
      },
      {
        alerta_id: 603,
        status: 'blocked',
        flags: ['fact_sheet_blocked'],
        reasons: [],
      },
    ],
  }, { mode: 'critical' });

  assert.deepStrictEqual(result.aceptadas.map((item) => item.id), []);
  assert.deepStrictEqual(result.rechazadas.map((item) => item.alerta.id), [601, 602, 603]);
  assert.strictEqual(result.summary.mode, 'enforce');
  assert.strictEqual(result.summary.requested_mode, 'critical');
  assert.strictEqual(result.summary.critical_reasons.deadline_claim_without_evidence, 1);
  assert.strictEqual(result.summary.critical_reasons.notificacion_individual, 1);
});

test('shadow no puede saltarse la autoridad final del envio automatico', async () => {
  const result = filtrarAlertasPorValidacionFinalDigest([
    alerta({ id: 701 }),
  ], {
    item_results: [{
      alerta_id: 701,
      status: 'blocked',
      flags: ['official_url_missing'],
      reasons: [],
    }],
  }, { mode: 'shadow' });

  assert.strictEqual(result.aceptadas.length, 0);
  assert.strictEqual(result.rechazadas.length, 1);
  assert.strictEqual(result.summary.mode, 'enforce');
  assert.strictEqual(result.summary.requested_mode, 'shadow');
});

test('doble check critico bloquea el item si hay discrepancia', async () => {
  const result = await prepararValidacionFinalDigestShadow({
    mensaje: [
      '*1. URGENTE - Ayudas maquinaria agricola*',
      'En sencillo: Se convocan ayudas para explotaciones agrarias de Huesca.',
      'Que revisar: plazo hasta el 30 de junio de 2026.',
      'https://boletin.example/501',
    ].join('\n'),
    alertas: [alerta()],
    factSheets: { 501: factSheet() },
    doubleCheckFn: async () => ({
      status: 'blocked_review',
      required: true,
      ok: false,
      disagreements: [{ field: 'plazo', left: '30 de junio', right: '15 de julio' }],
    }),
  });

  assert.strictEqual(result.validation.status, 'blocked');
  assert(result.alertas[0].final_validation_flags.includes('critical_double_check_blocked_review'));
});

test('resume validacion final para digest_attempts', async () => {
  const summary = resumirValidacionFinalDigest({
    ok: false,
    status: 'review_only',
    flags: ['selection_review_only'],
    diagnostics: {
      items_total: 2,
      items_send: 1,
      items_review_only: 1,
      items_blocked: 0,
    },
  });

  assert.strictEqual(summary.status, 'review_only');
  assert.strictEqual(summary.items_total, 2);
  assert(summary.flags.includes('selection_review_only'));
});

(async () => {
  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      console.log(`OK: ${item.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL: ${item.name}`);
      console.error(err.message);
    }
  }

  console.log(`\nResultados digestFinalValidationShadow: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
})();
