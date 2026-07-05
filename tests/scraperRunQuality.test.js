const assert = require('assert');
const { evaluarRespuestaScraper } = require('../src/modules/boletines/scraperRunQuality');

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

console.log('\n=== TESTS: scraper run quality ===\n');

test('marca ok cuando el scraper devuelve metricas limpias', () => {
  const quality = evaluarRespuestaScraper({
    responseOk: true,
    body: { success: true, nuevas: 3, duplicadas: 1, errores: 0, relevantes: 4 },
    fuente: 'BOE',
  });

  assert.strictEqual(quality.severity, 'ok');
  assert.strictEqual(quality.ok, true);
});

test('marca warning si responde 200 sin metricas de volumen', () => {
  const quality = evaluarRespuestaScraper({
    responseOk: true,
    body: { success: true, mensaje: 'procesado' },
    fuente: 'DOGV',
  });

  assert.strictEqual(quality.severity, 'warning');
  assert(quality.flags.includes('sin_metrica_volumen'));
});

test('marca warning si no hay volumen y no se explica', () => {
  const quality = evaluarRespuestaScraper({
    responseOk: true,
    body: { success: true, nuevas: 0, duplicadas: 0, errores: 0, relevantes: 0 },
    fuente: 'BOTHA',
  });

  assert.strictEqual(quality.severity, 'warning');
  assert(quality.flags.includes('sin_volumen_no_explicado'));
});

test('marca ok si no hay volumen pero el mensaje lo explica', () => {
  const casos = [
    'No hay boletín BOPH para 2026-07-04 (sin publicación o festivo)',
    'No se han encontrado documentos BOA hoy',
    'No hay boletín BOCYL publicado hoy (festivo o fin de semana)',
    'No hay disposiciones BON en el ultimo boletin',
  ];

  for (const mensaje of casos) {
    const quality = evaluarRespuestaScraper({
      responseOk: true,
      body: { success: true, nuevas: 0, duplicadas: 0, errores: 0, totales: 0, mensaje },
      fuente: 'BOPH',
    });
    assert.strictEqual(quality.severity, 'ok', `debería ser ok: "${mensaje}" → ${quality.flags}`);
  }
});

test('marca ok cuando hubo documentos aunque todos cayeran por filtro (caso BOA)', () => {
  const quality = evaluarRespuestaScraper({
    responseOk: true,
    body: {
      success: true,
      totales: 1,
      documentos_insertables: 0,
      nuevas: 0,
      duplicadas: 0,
      errores: 0,
      mensaje: 'BOA procesado (captura bruta + 1 MLKOB = 1 alerta + filtro)',
    },
    fuente: 'BOA',
  });

  assert.strictEqual(quality.severity, 'ok');
});

test('marca error por HTTP o errores internos', () => {
  const httpQuality = evaluarRespuestaScraper({
    responseOk: false,
    httpStatus: 500,
    body: { error: 'timeout' },
  });
  assert.strictEqual(httpQuality.severity, 'error');
  assert(httpQuality.flags.includes('http_error'));

  const bodyQuality = evaluarRespuestaScraper({
    responseOk: true,
    body: { success: true, nuevas: 0, errores: 1 },
  });
  assert.strictEqual(bodyQuality.severity, 'error');
  assert(bodyQuality.flags.includes('errores_reportados'));
});

console.log(`\nResultados scraperRunQuality: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
