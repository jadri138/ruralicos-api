process.env.CRON_TOKEN = process.env.CRON_TOKEN || 'token-de-test-suficiente';

const assert = require('assert');
const { registrarBoletinRuta, crearFiltroRural } = require('../src/modules/boletines/rutas/shared/registrarBoletinRuta');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`OK: ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`FAIL: ${name}`);
      console.error(err.message);
      process.exitCode = 1;
    });
}

function fakeApp() {
  const rutas = new Map();
  return {
    rutas,
    get(path, handler) {
      rutas.set(path, handler);
    },
  };
}

function fakeReq({ fecha, token = process.env.CRON_TOKEN } = {}) {
  const headers = { 'x-cron-token': token };
  return {
    query: fecha ? { fecha } : {},
    get: (name) => headers[String(name).toLowerCase()] || '',
  };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

const HOY = () => '2026-07-04';

function configBase(overrides = {}) {
  return {
    paths: ['/scrape-test-oficial', '/scrape-test'],
    fuente: 'TEST',
    region: 'Testlandia',
    hoy: HOY,
    obtenerDocs: async () => [],
    mensajes: { sinDocs: 'No hay boletín TEST hoy (sin publicación)', procesado: 'TEST procesado' },
    ...overrides,
  };
}

async function main() {
  console.log('\n=== TESTS: registrarBoletinRuta (factoría de rutas de boletín) ===\n');

  await test('registra todos los paths configurados', () => {
    const app = fakeApp();
    registrarBoletinRuta(app, {}, configBase());
    assert.deepStrictEqual([...app.rutas.keys()], ['/scrape-test-oficial', '/scrape-test']);
  });

  await test('rechaza sin cron token', async () => {
    const app = fakeApp();
    registrarBoletinRuta(app, {}, configBase());
    const res = fakeRes();
    await app.rutas.get('/scrape-test')(fakeReq({ token: 'incorrecto' }), res);
    assert.strictEqual(res.statusCode, 403);
  });

  await test('sin documentos: respuesta estándar con métricas a 0 y mensaje explicativo', async () => {
    const app = fakeApp();
    registrarBoletinRuta(app, {}, configBase());
    const res = fakeRes();
    await app.rutas.get('/scrape-test')(fakeReq(), res);

    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.totales, 0);
    assert.strictEqual(res.body.nuevas, 0);
    assert.strictEqual(res.body.saltadasFiltro, 0);
    assert.strictEqual(res.body.fecha, '2026-07-04');
    assert.strictEqual(res.body.mensaje, 'No hay boletín TEST hoy (sin publicación)');
  });

  await test('fechaModo query: pasa la fecha de la query o null', async () => {
    const fechas = [];
    const app = fakeApp();
    registrarBoletinRuta(app, {}, configBase({
      fechaModo: 'query',
      obtenerDocs: async (fecha) => {
        fechas.push(fecha);
        return [];
      },
    }));
    await app.rutas.get('/scrape-test')(fakeReq({ fecha: '2026-07-01' }), fakeRes());
    await app.rutas.get('/scrape-test')(fakeReq(), fakeRes());
    assert.deepStrictEqual(fechas, ['2026-07-01', null]);
  });

  await test('fechaModo hoy: ignora la query y usa hoy()', async () => {
    const fechas = [];
    const app = fakeApp();
    registrarBoletinRuta(app, {}, configBase({
      fechaModo: 'hoy',
      obtenerDocs: async (fecha) => {
        fechas.push(fecha);
        return [];
      },
    }));
    await app.rutas.get('/scrape-test')(fakeReq({ fecha: '2026-07-01' }), fakeRes());
    assert.deepStrictEqual(fechas, ['2026-07-04']);
  });

  await test('fechaModo query-o-hoy: query si existe, hoy() si no', async () => {
    const fechas = [];
    const app = fakeApp();
    registrarBoletinRuta(app, {}, configBase({
      fechaModo: 'query-o-hoy',
      obtenerDocs: async (fecha) => {
        fechas.push(fecha);
        return [];
      },
    }));
    await app.rutas.get('/scrape-test')(fakeReq({ fecha: '2026-07-01' }), fakeRes());
    await app.rutas.get('/scrape-test')(fakeReq(), fakeRes());
    assert.deepStrictEqual(fechas, ['2026-07-01', '2026-07-04']);
  });

  await test('error del scraper: 500 con mensaje', async () => {
    const app = fakeApp();
    registrarBoletinRuta(app, {}, configBase({
      obtenerDocs: async () => {
        throw new Error('portal caído');
      },
    }));
    const res = fakeRes();
    await app.rutas.get('/scrape-test')(fakeReq(), res);
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.error, 'portal caído');
  });

  await test('config inválida lanza al registrar (no en runtime)', () => {
    assert.throws(() => registrarBoletinRuta(fakeApp(), {}, configBase({ paths: [] })), /falta paths/);
    assert.throws(() => registrarBoletinRuta(fakeApp(), {}, configBase({ obtenerDocs: null })), /obtenerDocs/);
  });

  await test('crearFiltroRural: excluir gana, incluir requiere match, acentos normalizados', () => {
    const filtro = crearFiltroRural({
      excluir: ['ayuntamiento', 'oposición'],
      incluir: ['ganader', 'regadío'],
    });
    assert.strictEqual(filtro('Ayudas a la ganadería extensiva'), true);
    assert.strictEqual(filtro('Plan de regadio de la comarca'), true);
    assert.strictEqual(filtro('Ganadería: oposicion al cuerpo de veterinarios'), false);
    assert.strictEqual(filtro('Presupuesto del AYUNTAMIENTO ganadero'), false);
    assert.strictEqual(filtro('Convocatoria de empleo público'), false);
  });

  console.log(`\nResultados registrarBoletinRuta: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}

main();
