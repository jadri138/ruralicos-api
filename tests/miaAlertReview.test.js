const assert = require('assert');
const {
  normalizarReasonCodes,
  construirReviewRowMIA,
  construirDatasetRevisionMIA,
} = require('../src/mia/alertReview');

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

console.log('\n=== TESTS: mia alert review ===\n');

const user = {
  id: 10,
  name: 'Jose',
  phone: '34600000000',
  subscription: 'cooperativa',
  preferences: {
    provincias: ['Teruel'],
    sectores: ['agricultura'],
    subsectores: ['agua'],
    tipos_alerta: { agua_infraestructuras: true },
  },
};

const alerta = {
  id: 22,
  fuente: 'BOE',
  titulo: 'Anuncio de informacion publica de concesion de aguas para riego en Villarquemado (Teruel)',
  url: 'https://example.com/boe',
  fecha: '2026-05-27',
  estado_ia: 'listo',
  resumen_final: 'FICHA_IA\nTIPO: agua_infraestructuras\nPRIORIDAD: media\nRESUMEN_DIGEST: Solicitud de concesion de aguas para riego en termino municipal de Villarquemado. Expediente 42/2026.\nHECHO: informacion publica de solicitud de concesion\nDETALLE: aprovechamiento concreto de aguas\nACCION: presentar alegaciones si procede',
  contenido: 'Comisaria de aguas. Informacion publica de una solicitud de concesion de aguas en termino municipal de Villarquemado. Expediente 42/2026.',
  provincias: ['Teruel'],
  sectores: ['agricultura'],
  subsectores: ['agua'],
  tipos_alerta: ['agua_infraestructuras'],
  embedding_generated_at: '2026-05-27T08:00:00Z',
  created_at: '2026-05-27T07:45:00Z',
};

const digestItem = {
  digest_id: 77,
  user_id: user.id,
  alerta_id: alerta.id,
  fecha: '2026-05-27',
  item_numero: 2,
  score: 0.72,
  motivo_seleccion: 'incluida',
  resumen_usado: alerta.resumen_final,
  tags_json: {
    decision_digest: {
      incluir: true,
      motivo: 'incluida',
    },
  },
};

test('normaliza solo reason codes conocidos', () => {
  const result = normalizarReasonCodes(['territorio_incorrecto', 'RARO', 'resumen_generico']);
  assert.deepStrictEqual(result, ['territorio_incorrecto', 'resumen_generico']);
});

test('construye fila de revision con actor y diagnostico experto', () => {
  const row = construirReviewRowMIA({
    body: {
      digest_id: digestItem.digest_id,
      user_id: user.id,
      alerta_id: alerta.id,
      item_numero: digestItem.item_numero,
      verdict: 'local_solo_si_municipio',
      expected_action: 'bloquear',
      reason_codes: ['localidad_no_declarada', 'expediente_individual'],
      notes: 'Solo mandarla si el usuario declara Villarquemado.',
    },
    actor: { admin_user_id: 7, username: 'admin' },
    alerta,
    user,
  });

  assert.strictEqual(row.verdict, 'local_solo_si_municipio');
  assert.strictEqual(row.expected_action, 'bloquear');
  assert.strictEqual(row.reviewer_admin_user_id, 7);
  assert.strictEqual(row.expert_verdict, 'bloquear');
  assert(row.reason_codes.includes('localidad_no_declarada'));
});

test('rechaza verdict invalido', () => {
  assert.throws(() => construirReviewRowMIA({
    body: {
      digest_id: 1,
      user_id: 2,
      alerta_id: 3,
      verdict: 'me_da_igual',
      expected_action: 'bloquear',
    },
  }), /verdict invalido/);
});

test('dataset marca pendiente y sugiere local_solo_si_municipio', () => {
  const result = construirDatasetRevisionMIA({
    digestItems: [digestItem],
    alertas: [alerta],
    users: [user],
    reviews: [],
    feedbacks: [{ digest_id: 77, user_id: user.id, alerta_id: alerta.id, valor: -1 }],
  });

  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].reviewed, false);
  assert.strictEqual(result.items[0].suggested_verdict, 'local_solo_si_municipio');
  assert.strictEqual(result.summary.pendientes, 1);
  assert.strictEqual(result.summary.con_feedback_negativo, 1);
});

console.log(`\nResultados miaAlertReview: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
