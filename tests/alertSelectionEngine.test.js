const assert = require('assert');
const {
  decidirAlertaParaDigest,
  seleccionarAlertasParaDigest,
} = require('../src/utils/alertSelectionEngine');

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

console.log('\n=== TESTS: alert selection engine v2 ===\n');

const user = {
  subscription: 'cooperativa',
  preferences: {
    provincias: ['Teruel', 'Zaragoza'],
    sectores: ['agricultura', 'ganaderia'],
    subsectores: ['agua', 'vacuno', 'olivar'],
    tipos_alerta: {
      ayudas_subvenciones: true,
      agua_infraestructuras: true,
      normativa_general: true,
      medio_ambiente: true,
    },
  },
};

function alerta(id, overrides = {}) {
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
      'PRIORIDAD: media',
      'RESUMEN_DIGEST: Convocatoria de ayudas para explotaciones agrarias con plazo de solicitud abierto y requisitos operativos claros.',
      'HECHO: convocatoria de ayudas para riego agricola',
      'PLAZO: 20 dias habiles',
      'ACCION: presentar solicitud',
    ].join('\n'),
    contenido: 'Se convocan ayudas para explotaciones agrarias de Teruel con plazo de solicitud de 20 dias habiles.',
    provincias: ['Teruel'],
    sectores: ['agricultura'],
    subsectores: ['agua'],
    tipos_alerta: ['ayudas_subvenciones'],
    embedding_generated_at: '2026-06-04T08:00:00Z',
    similitud: 0.7,
    ...overrides,
  };
}

test('incluye alertas accionables con score explicable', () => {
  const decision = decidirAlertaParaDigest(alerta(1), user);
  assert.strictEqual(decision.incluir, true);
  assert(decision.score >= 80);
  assert(decision.diagnostico.ranking.reasons.some((reason) => reason.code === 'accion_con_plazo'));
});

test('bloquea licitaciones aunque coincidan preferencias', () => {
  const decision = decidirAlertaParaDigest(alerta(2, {
    titulo: 'Anuncio de formalizacion de contrato de servicios agrarios en Teruel',
    resumen_final: 'FICHA_IA\nTIPO: normativa_general\nRESUMEN_DIGEST: Anuncio de formalizacion de contrato de servicios administrativos.',
    contenido: 'Anuncio de formalizacion de contrato y adjudicacion de contrato.',
    tipos_alerta: ['normativa_general'],
  }), user);

  assert.strictEqual(decision.incluir, false);
  assert.strictEqual(decision.motivo, 'licitacion_bajo_valor');
});

test('revision segura exige calidad alta configurada', () => {
  const decision = decidirAlertaParaDigest({
    id: 3,
    fuente: 'BOE',
    titulo: 'Informacion publica sobre explotaciones agrarias',
    url: 'https://example.com/3',
    fecha: '2026-06-04',
    estado_ia: 'listo',
    resumen_final: [
      'FICHA_IA',
      'RESUMEN_DIGEST: Informacion publica con plazo para alegaciones.',
      'PLAZO: 20 dias habiles',
    ].join('\n'),
    contenido: 'Informacion publica con plazo para alegaciones.',
    provincias: ['nacional'],
    sectores: ['agricultura'],
    subsectores: [],
    tipos_alerta: ['normativa_general'],
    embedding_generated_at: '2026-06-04T08:00:00Z',
  }, {
    subscription: 'cooperativa',
    preferences: { provincias: [], sectores: [], subsectores: [], tipos_alerta: {} },
  }, {
    minIncludeScore: 80,
    minReviewScore: 50,
    minReviewQualityScore: 99,
  });

  assert.strictEqual(decision.incluir, false);
  assert.strictEqual(decision.motivo, 'score_insuficiente');
  assert(decision.score >= 50 && decision.score < 80);
});

test('selecciona con diversidad y conserva minimo cuando hay candidatas', () => {
  const result = seleccionarAlertasParaDigest([
    alerta(10, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
    alerta(11, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
    alerta(12, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
    alerta(13, { fuente: 'BOE', provincias: ['Teruel'], tipos_alerta: ['agua_infraestructuras'] }),
    alerta(14, { fuente: 'BOCYL', provincias: ['Zaragoza'], tipos_alerta: ['medio_ambiente'] }),
  ], user, {
    minItems: 3,
    targetItems: 4,
    maxItems: 4,
    maxPerFuente: 2,
    maxPerTipo: 2,
  });

  assert(result.alertas.length >= 3);
  assert(result.alertas.length <= 4);
  assert(new Set(result.alertas.map((item) => item.fuente)).size >= 2);
  assert(result.resumen.incluidas >= 3);
});

test('rellena con intereses fuertes aunque compartan fuente y tipo', () => {
  const result = seleccionarAlertasParaDigest([
    alerta(20, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
    alerta(21, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
    alerta(22, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
    alerta(23, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
    alerta(24, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
  ], user, {
    minItems: 3,
    targetItems: 5,
    maxItems: 5,
    maxPerFuente: 2,
    maxPerTipo: 2,
    relaxedFillMinScore: 76,
  });

  assert.strictEqual(result.alertas.length, 5);
  assert.strictEqual(result.resumen.incluidas, 5);
});

test('no sobreexpone expedientes individuales aunque haya pocos avisos', () => {
  const result = seleccionarAlertasParaDigest([
    alerta(30, {
      titulo: 'Solicitud de concesion de aguas para riego en Teruel 30',
      contenido: 'Solicitud de concesion de aguas para riego agricola en Teruel con plazo de alegaciones.',
      tipos_alerta: ['agua_infraestructuras'],
    }),
    alerta(31, {
      titulo: 'Solicitud de concesion de aguas para riego en Teruel 31',
      contenido: 'Solicitud de concesion de aguas para riego agricola en Teruel con plazo de alegaciones.',
      tipos_alerta: ['agua_infraestructuras'],
    }),
    alerta(32, {
      titulo: 'Solicitud de concesion de aguas para riego en Teruel 32',
      contenido: 'Solicitud de concesion de aguas para riego agricola en Teruel con plazo de alegaciones.',
      tipos_alerta: ['agua_infraestructuras'],
    }),
  ], user, {
    minItems: 3,
    targetItems: 3,
    maxItems: 3,
    maxIndividualItems: 2,
  });

  assert.strictEqual(result.alertas.length, 2);
  assert.strictEqual(result.resumen.fuera_por_diversidad, 1);
});

console.log(`\nResultados alertSelectionEngine: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
