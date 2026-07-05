const assert = require('assert');
const { omitirScraperSiCapturado } = require('../src/modules/boletines/scraperSkip');

let passed = 0;
let failed = 0;

function test(name, fn) {
  Promise.resolve()
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

// Mock encadenable: cualquier método devuelve el propio builder; al hacer await
// se resuelve con el resultado configurado (los builders de supabase-js son thenables).
function fakeSupabase(result) {
  const calls = [];
  const builder = {};
  for (const method of ['select', 'eq', 'in', 'or', 'order', 'limit']) {
    builder[method] = (...args) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.then = (resolve) => resolve(result);
  return {
    calls,
    from(table) {
      calls.push({ method: 'from', args: [table] });
      return builder;
    },
  };
}

console.log('\n=== TESTS: scraper skip (cortocircuito de duplicados) ===\n');

test('omite el scrape si hay run previo hoy con volumen', async () => {
  const supabase = fakeSupabase({
    data: [{ id: 42, nuevas: 5, duplicadas: 12, status: 'ok', started_at: '2026-07-04T06:00:00Z' }],
    error: null,
  });
  const runsGuardados = [];

  const omision = await omitirScraperSiCapturado(supabase, {
    path: '/scrape-boe-oficial',
    fuente: 'BOE',
    fecha: '2026-07-04',
    guardarRun: async (_supabase, run) => runsGuardados.push(run),
  });

  assert(omision, 'debe devolver resultado de omisión');
  assert.strictEqual(omision.skipped, true);
  assert.strictEqual(omision.ok, true);
  assert.strictEqual(omision.quality.severity, 'ok');
  assert(omision.quality.flags.includes('omitido_ya_capturado'));
  assert.strictEqual(omision.body.run_previo_id, 42);

  assert.strictEqual(runsGuardados.length, 1, 'debe registrar el run omitido');
  assert.strictEqual(runsGuardados[0].status, 'ok');
  assert.strictEqual(runsGuardados[0].nuevas, 0);
  assert(/ya capturado hoy/.test(runsGuardados[0].mensaje));
});

test('NO omite si el run previo no tiene volumen (boletín aún no publicado)', async () => {
  // El filtro .or('nuevas.gt.0,duplicadas.gt.0') hace que la query no devuelva
  // filas sin volumen: simulamos resultado vacío.
  const supabase = fakeSupabase({ data: [], error: null });

  const omision = await omitirScraperSiCapturado(supabase, {
    path: '/scrape-boph-oficial',
    fuente: 'BOPH',
    fecha: '2026-07-04',
    guardarRun: async () => {
      throw new Error('no debe registrar nada');
    },
  });

  assert.strictEqual(omision, null);
});

test('force=true salta el cortocircuito', async () => {
  const supabase = fakeSupabase({
    data: [{ id: 42, nuevas: 5, duplicadas: 12, status: 'ok' }],
    error: null,
  });

  const omision = await omitirScraperSiCapturado(supabase, {
    path: '/scrape-boe-oficial',
    fuente: 'BOE',
    fecha: '2026-07-04',
    force: true,
  });

  assert.strictEqual(omision, null);
  assert.strictEqual(supabase.calls.length, 0, 'con force no debe ni consultar');
});

test('SCRAPER_SKIP_ALREADY_CAPTURED=false desactiva el cortocircuito', async () => {
  const original = process.env.SCRAPER_SKIP_ALREADY_CAPTURED;
  process.env.SCRAPER_SKIP_ALREADY_CAPTURED = 'false';
  try {
    const supabase = fakeSupabase({ data: [{ id: 1, nuevas: 3, duplicadas: 0 }], error: null });
    const omision = await omitirScraperSiCapturado(supabase, {
      path: '/scrape-boe-oficial',
      fuente: 'BOE',
      fecha: '2026-07-04',
    });
    assert.strictEqual(omision, null);
  } finally {
    if (original === undefined) delete process.env.SCRAPER_SKIP_ALREADY_CAPTURED;
    else process.env.SCRAPER_SKIP_ALREADY_CAPTURED = original;
  }
});

test('si la consulta falla, no bloquea: se scrapea con normalidad', async () => {
  const supabase = fakeSupabase({ data: null, error: { message: 'connection refused' } });

  const omision = await omitirScraperSiCapturado(supabase, {
    path: '/scrape-boe-oficial',
    fuente: 'BOE',
    fecha: '2026-07-04',
  });

  assert.strictEqual(omision, null);
});

process.on('beforeExit', () => {
  console.log(`\nResultados scraperSkip: ${passed} aprobados, ${failed} fallidos`);
});
