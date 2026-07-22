const assert = require('assert');
const { construirFactSheetAlertaSync } = require('../src/modules/alertas/intelligence/factSheetBuilder');

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

function sectorVerificado(sheet, valor) {
  return (sheet.sectores || []).some(
    (item) => item.valor === valor && item.status === 'verified'
  );
}

console.log('\n=== TESTS: fact sheet builder ===\n');

test('verifica el sector agricultura cuando el texto dice "agricultores"', () => {
  const sheet = construirFactSheetAlertaSync({
    id: 1,
    titulo: 'Convocatoria de ayudas para agricultores en Huesca',
    contenido: 'Se convocan ayudas dirigidas a los agricultores titulares de explotaciones. Plazo de solicitudes 20 dias habiles.',
    resumen_final: 'Ayudas para agricultores de Huesca.',
    provincias: ['huesca'],
    sectores: ['agricultura'],
    tipos_alerta: ['ayudas_subvenciones'],
    url: 'https://www.boa.aragon.es/ejemplo',
  }, {});

  assert(sectorVerificado(sheet, 'agricultura'), 'el sector agricultura deberia quedar verificado');
  assert(!sheet.flags.includes('sector_no_verificado'), 'no deberia marcar sector_no_verificado');
});

test('verifica el sector ganaderia con la palabra "ganaderos"', () => {
  const sheet = construirFactSheetAlertaSync({
    id: 2,
    titulo: 'Sanidad animal: nuevas obligaciones para ganaderos',
    contenido: 'Resolucion que afecta a los ganaderos de vacuno y ovino sobre sanidad animal.',
    provincias: ['teruel'],
    sectores: ['ganaderia'],
    tipos_alerta: ['normativa_general'],
    url: 'https://www.boa.aragon.es/ejemplo2',
  }, {});

  assert(sectorVerificado(sheet, 'ganaderia'), 'el sector ganaderia deberia quedar verificado');
});

test('no inventa sector si el texto no lo respalda', () => {
  const sheet = construirFactSheetAlertaSync({
    id: 3,
    titulo: 'Licitacion de obra publica municipal',
    contenido: 'Anuncio de licitacion para la obra de un edificio administrativo.',
    provincias: ['zaragoza'],
    sectores: ['agricultura'],
    tipos_alerta: ['licitaciones'],
    url: 'https://www.boa.aragon.es/ejemplo3',
  }, {});

  assert(!sectorVerificado(sheet, 'agricultura'), 'no deberia verificar un sector sin evidencia textual');
});

test('usa la geografia compartida para provincias fuera de Aragon', () => {
  const sheet = construirFactSheetAlertaSync({
    id: 4,
    titulo: 'Ayudas para explotaciones agrarias de Córdoba',
    contenido: 'Se convocan ayudas para explotaciones agrarias de la provincia de Córdoba.',
    provincias: ['Córdoba'],
    sectores: ['agricultura'],
    tipos_alerta: ['ayudas_subvenciones'],
    url: 'https://www.juntadeandalucia.es/boja/ejemplo',
  });

  assert(
    sheet.territorio.some((item) => item.valor === 'cordoba' && item.status === 'verified'),
    'Cordoba debe quedar verificada con el registro geografico compartido'
  );
});

test('no convierte no_detectado en un plazo verificado', () => {
  const sheet = construirFactSheetAlertaSync({
    id: 5,
    titulo: 'Bases de ayudas para explotaciones agrarias',
    contenido: 'Se publican las bases reguladoras de ayudas para explotaciones agrarias.',
    resumen_final: 'FICHA_IA\nTIPO: ayudas_subvenciones\nPLAZO: no_detectado\nBENEFICIARIOS: no_detectado',
    provincias: [],
    sectores: ['agricultura'],
    tipos_alerta: ['ayudas_subvenciones'],
    url: 'https://www.boe.es/ejemplo',
  });

  assert.strictEqual(sheet.plazo.valor, null);
  assert.strictEqual(sheet.plazo.status, 'no_verificado');
  assert.notStrictEqual(sheet.beneficiarios.valor, 'no_detectado');
});

test('no convierte la fecha del titulo en plazo verificado', () => {
  const sheet = construirFactSheetAlertaSync({
    id: 6,
    titulo: 'Resolucion de 16 de junio de 2026 por la que se convocan ayudas para explotaciones agrarias',
    contenido: 'Se convocan ayudas para explotaciones agrarias. Beneficiarios: titulares de explotaciones agrarias.',
    resumen_final: [
      'FICHA_IA',
      'TIPO: ayudas_subvenciones',
      'RESUMEN_DIGEST: Se convocan ayudas para explotaciones agrarias.',
      'PLAZO: Resolucion de 16 de junio de 2026 por la que se convocan ayudas para explotaciones agrarias',
    ].join('\n'),
    provincias: [],
    sectores: ['agricultura'],
    tipos_alerta: ['ayudas_subvenciones'],
    url: 'https://www.boe.es/ejemplo-fecha-titulo',
  });

  assert.strictEqual(sheet.plazo.valor, null);
  assert.strictEqual(sheet.plazo.status, 'no_verificado');
});

test('extrae un plazo real cuando el texto oficial dice que finaliza en una fecha', () => {
  const sheet = construirFactSheetAlertaSync({
    id: 7,
    titulo: 'Ayudas ICO-MAPA-SAECA por sequia',
    contenido: 'Se convocan ayudas para explotaciones agrarias y ganaderas. El plazo de presentacion de solicitudes finalizara el 30 de septiembre de 2028.',
    resumen_final: 'FICHA_IA\nTIPO: ayudas_subvenciones\nRESUMEN_DIGEST: Ayudas ICO-MAPA-SAECA por sequia.',
    provincias: [],
    sectores: ['agricultura', 'ganaderia'],
    tipos_alerta: ['ayudas_subvenciones'],
    url: 'https://www.boe.es/ejemplo-plazo-real',
  });

  assert.strictEqual(sheet.plazo.status, 'verified');
  assert(/30 de septiembre de 2028/i.test(sheet.plazo.valor || sheet.plazo.evidencia || ''), 'deberia conservar la fecha de fin real');
});

test('separa fechas juridicas y accion estructurada del caso de antibioticos', () => {
  const sheet = construirFactSheetAlertaSync({
    id: 15110,
    fecha: '2026-07-18',
    titulo: 'Indicadores nacionales de consumo de antibioticos veterinarios',
    contenido: [
      'Se publican los indicadores nacionales de 2026 para explotaciones ganaderas.',
      'Producen efectos tres meses despues de su publicacion.',
      'Contra la resolucion cabe recurso de reposicion en el plazo de 1 mes.',
      'Las explotaciones deben consultar PRESVET y revisar los indicadores con su veterinario.',
    ].join(' '),
    sectores: ['ganaderia'],
    subsectores: ['porcino'],
    tipos_alerta: ['sanidad_animal', 'normativa_general'],
    url: 'https://www.boe.es/ejemplo-antibioticos',
  });

  assert.strictEqual(sheet.publication_date.valor, '2026-07-18');
  assert.strictEqual(sheet.effective_date.valor, '2026-10-18');
  assert.strictEqual(sheet.appeal_deadline.valor, '1 mes');
  assert.strictEqual(sheet.application_deadline.valor, null);
  assert.strictEqual(sheet.accion_codigo.valor, 'consultar_presvet');
  assert(sheet.resumen_estructurado.acto_publicado_ahora.valor.includes('Se publican'));
  assert(sheet.taxonomy_evidence.some((item) => item.tag === 'sector:ganaderia'));
  assert(sheet.taxonomy_evidence.some((item) => item.tag === 'tipo:sanidad_animal'));
});

test('una etiqueta sin evidencia queda marcada para revision', () => {
  const sheet = construirFactSheetAlertaSync({
    id: 8,
    titulo: 'Resolucion sobre explotaciones ganaderas',
    contenido: 'Se regulan requisitos para explotaciones ganaderas.',
    sectores: ['ganaderia'],
    tipos_alerta: ['fiscalidad'],
    url: 'https://www.boe.es/ejemplo-sin-evidencia-fiscal',
  });

  assert(sheet.unsupported_taxonomy_tags.includes('tipo:fiscalidad'));
  assert(sheet.flags.includes('unsupported_taxonomy_tag'));
  assert.notStrictEqual(sheet.status, 'ready_for_digest');
});

test('acciones estructuradas exigen evidencia documental y cubren el catalogo P1.6', () => {
  const actions = [
    ['consultar_presvet', 'Las explotaciones deberan consultar PRESVET.'],
    ['revisar_con_veterinario', 'Se recomienda revisar los indicadores con el veterinario.'],
    ['presentar_solicitud', 'Los interesados podran presentar una solicitud.'],
    ['presentar_alegaciones', 'Se abre un plazo para presentar alegaciones.'],
    ['subsanar_documentacion', 'Los solicitantes deberan subsanar la documentacion.'],
    ['justificar_ayuda', 'Los beneficiarios deberan justificar la ayuda.'],
    ['contactar_organismo', 'Para resolver dudas se deberan dirigir al organismo gestor.'],
    ['sin_accion_inmediata', 'La publicacion no requiere accion inmediata.'],
    ['solo_informativo', 'El contenido se publica a efectos informativos.'],
  ];

  for (const [expected, contenido] of actions) {
    const sheet = construirFactSheetAlertaSync({
      id: expected,
      titulo: 'Norma para explotaciones agrarias',
      contenido,
      sectores: ['agricultura'],
      tipos_alerta: ['normativa_general'],
      url: `https://www.boe.es/${expected}`,
    });
    assert.strictEqual(sheet.accion_codigo.valor, expected, expected);
    assert.strictEqual(sheet.accion_codigo.source, 'alerta.contenido', expected);
  }

  const unsupported = construirFactSheetAlertaSync({
    id: 'generated-action-only',
    titulo: 'Norma para explotaciones agrarias',
    contenido: 'La resolucion informa de un marco juridico agrario.',
    resumen_final: 'FICHA_IA\nACCION: presentar solicitud',
    sectores: ['agricultura'],
    tipos_alerta: ['normativa_general'],
    url: 'https://www.boe.es/generated-action-only',
  });
  assert.strictEqual(unsupported.accion_codigo.valor, null);
});

console.log(`\nResultados factSheetBuilder: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
