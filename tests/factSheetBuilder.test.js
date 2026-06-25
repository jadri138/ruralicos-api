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

console.log(`\nResultados factSheetBuilder: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
