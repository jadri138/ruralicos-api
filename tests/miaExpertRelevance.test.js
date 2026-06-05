const assert = require('assert');
const { evaluarRelevanciaExperta } = require('../src/mia/expertRelevance');
const { extraerFeaturesAlerta } = require('../src/brain/alertFeatures');

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

console.log('\n=== TESTS: mia expert relevance ===\n');

const user = {
  subscription: 'cooperativa',
  preferences: {
    provincias: ['Cadiz'],
    sectores: ['agricultura', 'mixto'],
    subsectores: ['olivar', 'agua'],
    tipos_alerta: {
      ayudas_subvenciones: true,
      agua_infraestructuras: true,
      normativa_general: true,
    },
  },
};

const baseAlert = {
  id: 1,
  fuente: 'BOJA',
  titulo: 'Convocatoria de ayudas para modernizacion de explotaciones de olivar en Cadiz',
  url: 'https://example.com/alerta',
  fecha: '2026-05-27',
  created_at: '2026-05-27T08:00:00Z',
  estado_ia: 'listo',
  resumen_final: 'FICHA_IA\nTIPO: ayudas_subvenciones\nPRIORIDAD: alta\nRESUMEN_DIGEST: Convocatoria de ayudas para explotaciones de olivar en Cadiz con plazo de solicitud abierto.\nHECHO: convocatoria de ayudas\nPLAZO: 20 dias habiles\nACCION: presentar solicitud',
  contenido: 'Se convocan ayudas para modernizacion de explotaciones agrarias de olivar en Cadiz. Plazo de presentacion de solicitudes de 20 dias habiles.',
  provincias: ['Cadiz'],
  sectores: ['agricultura'],
  subsectores: ['olivar'],
  tipos_alerta: ['ayudas_subvenciones'],
  embedding_generated_at: '2026-05-27T08:30:00Z',
};

test('incluye ayuda concreta con territorio, sector, accion y plazo', () => {
  const result = evaluarRelevanciaExperta(baseAlert, user);
  assert.strictEqual(result.veredicto, 'incluir');
  assert(result.score >= 80);
  assert(result.reasons.some((reason) => reason.code === 'accion_con_plazo'));
});

test('bloquea expediente individual sin municipio declarado aunque coincida provincia', () => {
  const result = evaluarRelevanciaExperta({
    ...baseAlert,
    id: 2,
    titulo: 'Informacion publica de concesion de aguas en Medina Sidonia (Cadiz)',
    resumen_final: 'Solicitud de concesion de aguas para aprovechamiento concreto en termino municipal de Medina Sidonia. Expediente 42/2026.',
    contenido: 'Comisaria de aguas. Informacion publica de solicitud de concesion de aguas en termino municipal de Medina Sidonia.',
    subsectores: ['agua'],
    tipos_alerta: ['agua_infraestructuras'],
  }, user);

  assert.strictEqual(result.veredicto, 'bloquear');
  assert(result.blocks.some((block) => block.code === 'expediente_individual_sin_municipio'));
});

test('no trata una relacion de titulares como expediente individual por defecto', () => {
  const alertaTitulares = {
    ...baseAlert,
    id: 21,
    titulo: 'Relacion de titulares con requerimiento de subsanacion de ayudas PAC en Cadiz',
    resumen_final: 'FICHA_IA\nTIPO: ayudas_subvenciones\nPRIORIDAD: media\nRESUMEN_DIGEST: Se publica una relacion de titulares con requerimiento de subsanacion de ayudas PAC en Cadiz, con plazo para aportar documentacion.\nHECHO: requerimiento de subsanacion de ayudas PAC\nPLAZO: 10 dias habiles\nACCION: aportar documentacion',
    contenido: 'Relacion de titulares de solicitudes de ayudas PAC con requerimiento de subsanacion y plazo para aportar documentacion.',
    tipos_alerta: ['ayudas_subvenciones'],
  };

  const features = extraerFeaturesAlerta(alertaTitulares);
  const result = evaluarRelevanciaExperta(alertaTitulares, user);
  assert(!features.includes('tramite:individual'));
  assert(!result.blocks.some((block) => block.code === 'expediente_individual_sin_municipio'));
  assert.strictEqual(result.veredicto, 'incluir');
});

test('permite expediente individual si coincide municipio declarado', () => {
  const result = evaluarRelevanciaExperta({
    ...baseAlert,
    id: 3,
    titulo: 'Informacion publica de concesion de aguas en Medina Sidonia (Cadiz)',
    resumen_final: 'Solicitud de concesion de aguas para aprovechamiento concreto en termino municipal de Medina Sidonia. Expediente 42/2026.',
    contenido: 'Comisaria de aguas. Informacion publica de solicitud de concesion de aguas en termino municipal de Medina Sidonia.',
    subsectores: ['agua'],
    tipos_alerta: ['agua_infraestructuras'],
  }, {
    ...user,
    preferences: {
      ...user.preferences,
      municipio: 'Medina Sidonia',
    },
  });

  assert.strictEqual(result.veredicto, 'incluir');
  assert(result.reasons.some((reason) => reason.code === 'expediente_local_explicito'));
});

test('bloquea alerta critica de calidad aunque parezca agraria', () => {
  const result = evaluarRelevanciaExperta({
    ...baseAlert,
    id: 4,
    titulo: 'Notificaciones. Notificacion de 15/05/2026',
    resumen_final: 'El boletin publica una notificacion al interesado tras no haberse podido practicar la notificacion personal.',
    contenido: 'Intentada sin efecto la notificacion personal, se notifica al interesado un acto administrativo.',
  }, user);

  assert.strictEqual(result.veredicto, 'bloquear');
  assert(result.blocks.some((block) => block.code === 'calidad_insuficiente'));
});

console.log(`\nResultados miaExpertRelevance: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
