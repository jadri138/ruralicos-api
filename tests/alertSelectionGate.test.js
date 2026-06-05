const assert = require('assert');
const {
  decidirAlertaParaDigest,
  filtrarAlertasParaDigest,
  puedeIncluirRevisionSegura,
} = require('../src/utils/alertSelectionGate');

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

console.log('\n=== TESTS: alert selection gate ===\n');

const userJose = {
  subscription: 'cooperativa',
  preferences: {
    provincias: ['Albacete', 'Teruel', 'Valencia'],
    sectores: ['ganaderia', 'agricultura', 'mixto'],
    subsectores: ['agua', 'medio_ambiente'],
    tipos_alerta: { agua_infraestructuras: true, medio_ambiente: true },
  },
};

const alertaBuena = {
  id: 1,
  fuente: 'DOCM',
  titulo: 'Estudio de impacto ambiental en Albacete',
  url: 'https://example.com/docm.pdf',
  fecha: '2026-05-27',
  estado_ia: 'listo',
  resumen_final: 'FICHA_IA\nTIPO: medio_ambiente\nPRIORIDAD: media\nRESUMEN_DIGEST: El boletin abre informacion publica del estudio de impacto ambiental de una mejora de riego en Albacete, con tramite para alegaciones.\nHECHO: informacion publica ambiental\nDETALLE: mejora de sistema de riego en Albacete',
  contenido: 'Informacion publica del estudio de impacto ambiental del proyecto de mejora del sistema de riego en Albacete.',
  provincias: ['Albacete'],
  sectores: ['agricultura'],
  subsectores: ['agua', 'medio_ambiente'],
  tipos_alerta: ['medio_ambiente', 'agua_infraestructuras'],
  embedding_generated_at: '2026-05-27T08:00:00Z',
};

test('incluye alerta con territorio, tipo y calidad suficientes', () => {
  const decision = decidirAlertaParaDigest(alertaBuena, userJose);
  assert.strictEqual(decision.incluir, true);
  assert.strictEqual(decision.motivo, 'incluida');
  assert.strictEqual(decision.riesgo, 'bajo');
});

test('excluye por territorio no coincidente antes de llegar al digest', () => {
  const decision = decidirAlertaParaDigest({
    ...alertaBuena,
    id: 2,
    titulo: 'Concesion de agua para riego en Corullon (Leon)',
    provincias: [],
  }, userJose);

  assert.strictEqual(decision.incluir, false);
  assert.strictEqual(decision.motivo, 'provincia_no_coincide');
  assert.strictEqual(decision.riesgo, 'alto');
});

test('excluye por calidad insuficiente aunque coincida por preferencias', () => {
  const decision = decidirAlertaParaDigest({
    ...alertaBuena,
    id: 3,
    resumen_final: '',
  }, userJose);

  assert.strictEqual(decision.incluir, false);
  assert.strictEqual(decision.motivo, 'calidad_insuficiente');
});

test('filtra y anota decision para trazabilidad en digest_items', () => {
  const result = filtrarAlertasParaDigest([
    alertaBuena,
    { ...alertaBuena, id: 4, titulo: 'Concesion de agua para riego en Corullon (Leon)', provincias: [] },
  ], userJose);

  assert.strictEqual(result.alertas.length, 1);
  assert.strictEqual(result.excluidas.length, 1);
  assert(result.alertas[0].decision_digest.incluir);
  assert(result.alertas[0].motivo_seleccion_mia.includes('incluida'));
});

test('bloquea expediente individual aunque coincida por provincia si no hay municipio del usuario', () => {
  const decision = decidirAlertaParaDigest({
    ...alertaBuena,
    id: 5,
    fuente: 'BOE',
    titulo: 'Anuncio de informacion publica de concesion de aguas para riego en Villarquemado (Teruel)',
    resumen_final: 'Solicitud de concesion de aguas para aprovechamiento concreto en termino municipal de Villarquemado. Expediente 42/2026.',
    contenido: 'Comisaria de aguas. Informacion publica de una solicitud de concesion en termino municipal de Villarquemado.',
    provincias: ['Teruel'],
    sectores: ['agricultura'],
    subsectores: ['agua'],
    tipos_alerta: ['agua_infraestructuras'],
  }, userJose);

  assert.strictEqual(decision.incluir, false);
  assert.strictEqual(decision.motivo, 'expediente_individual_sin_municipio');
});

test('permite expediente individual provincial cuando el digest activa coincidencia fuerte', () => {
  const decision = decidirAlertaParaDigest({
    ...alertaBuena,
    id: 7,
    fuente: 'BOE',
    titulo: 'Anuncio de informacion publica de concesion de aguas para riego en Villarquemado (Teruel)',
    resumen_final: 'Solicitud de concesion de aguas para aprovechamiento concreto en termino municipal de Villarquemado. Plazo de alegaciones abierto.',
    contenido: 'Comisaria de aguas. Informacion publica de una solicitud de concesion en termino municipal de Villarquemado para riego agricola.',
    provincias: ['Teruel'],
    sectores: ['agricultura'],
    subsectores: ['agua'],
    tipos_alerta: ['agua_infraestructuras'],
  }, userJose, {
    allowIndividualWithoutMunicipio: true,
  });

  assert.strictEqual(decision.incluir, true);
  assert.strictEqual(decision.motivo, 'incluida');
  assert(decision.diagnostico.experto.reasons.some((reason) => reason.code === 'expediente_individual_match_provincial'));
});

test('permite expediente individual si el usuario tiene municipio explicito', () => {
  const decision = decidirAlertaParaDigest({
    ...alertaBuena,
    id: 6,
    fuente: 'BOE',
    titulo: 'Anuncio de informacion publica de concesion de aguas para riego en Villarquemado (Teruel)',
    resumen_final: 'Solicitud de concesion de aguas para aprovechamiento concreto en termino municipal de Villarquemado. Expediente 42/2026.',
    contenido: 'Comisaria de aguas. Informacion publica de una solicitud de concesion en termino municipal de Villarquemado.',
    provincias: ['Teruel'],
    sectores: ['agricultura'],
    subsectores: ['agua'],
    tipos_alerta: ['agua_infraestructuras'],
  }, {
    ...userJose,
    preferences: {
      ...userJose.preferences,
      localidad: 'Villarquemado',
    },
  });

  assert.strictEqual(decision.incluir, true);
});

test('permite revision segura solo con calidad alta y sin senales de bajo valor', () => {
  const revisionAgua = {
    veredicto: 'revisar',
    blocks: [],
    features: ['concepto:agua_riego'],
    signals: {
      es_agua: true,
      es_individual: false,
      es_licitacion: false,
      generico: false,
    },
  };

  assert.strictEqual(
    puedeIncluirRevisionSegura(revisionAgua, { score: 82, critical: false }, { allowReview: true }),
    true
  );
  assert.strictEqual(
    puedeIncluirRevisionSegura({
      ...revisionAgua,
      features: ['tramite:licitacion', 'concepto:agua_riego'],
    }, { score: 92, critical: false }, { allowReview: true }),
    false
  );
  assert.strictEqual(
    puedeIncluirRevisionSegura({
      ...revisionAgua,
      signals: { ...revisionAgua.signals, es_individual: true },
    }, { score: 92, critical: false }, { allowReview: true }),
    false
  );
});

console.log(`\nResultados alertSelectionGate: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
