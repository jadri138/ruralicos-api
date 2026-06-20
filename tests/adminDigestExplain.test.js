const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  construirWhyNotSentResponse,
  construirWhySentDigest,
  normalizarDigestExplainParams,
} = require('../src/modules/admin/digestExplain');

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

console.log('\n=== TESTS: admin digest explain ===\n');

test('normaliza parametros de consulta', () => {
  const params = normalizarDigestExplainParams({
    digest_id: '77',
    user_id: '141',
    fecha: '2026-06-20',
    kind: 'daily',
    limit: '5000',
  });

  assert.strictEqual(params.digest_id, 77);
  assert.strictEqual(params.user_id, 141);
  assert.strictEqual(params.fecha, '2026-06-20');
  assert.strictEqual(params.kind, 'daily');
  assert.strictEqual(params.limit, 100);
});

test('construye explicacion why-sent con seleccion, fact sheet y validacion final', () => {
  const result = construirWhySentDigest({
    digest: {
      id: 77,
      user_id: 141,
      fecha: '2026-06-20',
      mensaje: 'Mensaje largo',
      enviado: true,
      alerta_ids: [501],
    },
    digestItems: [{
      id: 9,
      digest_id: 77,
      item_numero: 1,
      alerta_id: 501,
      selection_score: 91,
      selection_action: 'include',
      selection_reason: 'incluida',
      selection_risk: 'bajo',
      selection_decision: { action: 'include', score: 91 },
      tags_json: {
        fact_sheet_status: 'ready_for_digest',
        truth_score: 96,
        risk_score: 8,
        evidence_coverage: 0.92,
        final_validation_status: 'send',
        final_validation_flags: [],
        shadow_decision: { future_decision: 'include' },
      },
    }],
    alertas: [{
      id: 501,
      titulo: 'Ayuda maquinaria',
      fuente: 'BOA',
      fecha: '2026-06-20',
      url: 'https://boletin.example/501',
      provincias: ['Huesca'],
      sectores: ['Agricultura'],
      subsectores: [],
      tipos_alerta: ['ayudas_subvenciones'],
    }],
    factSheets: [{
      alerta_id: 501,
      status: 'ready_for_digest',
      truth_score: 96,
      risk_score: 8,
      evidence_coverage: 0.92,
      generated_at: '2026-06-20T10:00:00Z',
    }],
    attempts: [{ id: 3, digest_id: 77, status: 'generated' }],
  });

  assert.strictEqual(result.digest.id, 77);
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].selection.action, 'include');
  assert.strictEqual(result.items[0].fact_sheet.status, 'ready_for_digest');
  assert.strictEqual(result.items[0].final_validation.status, 'send');
  assert.strictEqual(result.items[0].shadow_decision.future_decision, 'include');
});

test('construye why-not-sent desde digest_attempts', () => {
  const result = construirWhyNotSentResponse({
    attempts: [{
      id: 12,
      user_id: 141,
      fecha: '2026-06-20',
      kind: 'daily',
      status: 'no_send',
      motivo_no_envio: 'final_validation_blocked',
      metadata_json: {
        final_validation: { status: 'blocked', items_blocked: 1 },
        final_validation_enforcement: { rejected: 1 },
      },
      total_alertas_dia: 5,
      tras_quality_gate: 4,
      tras_filtro_usuario: 2,
      tras_scoring: 1,
      alertas_finales: 0,
    }],
    users: [{
      id: 141,
      legal_name: 'Cooperativa Norte',
      phone: '+34123456789',
      subscription: 'cooperativa',
      organization_id: 12,
    }],
  });

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].attempt.motivo_no_envio, 'final_validation_blocked');
  assert.strictEqual(result[0].user.name, 'Cooperativa Norte');
  assert.strictEqual(result[0].final_validation.status, 'blocked');
  assert.strictEqual(result[0].final_validation_enforcement.rejected, 1);
});

test('registra endpoints admin protegidos', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/modules/admin/admin.panel.routes.js'), 'utf8');
  assert(source.includes("app.get('/admin/digest/why-sent', requireAdmin"), 'Existe endpoint why-sent protegido');
  assert(source.includes("app.get('/admin/digest/why-not-sent', requireAdmin"), 'Existe endpoint why-not-sent protegido');
});

console.log(`\nResultados adminDigestExplain: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
