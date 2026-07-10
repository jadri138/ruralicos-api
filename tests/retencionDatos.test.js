// Tests de la purga por politica de retencion: dry-run no borra nunca, el
// borrado real va por lotes hasta vaciar, y un error en una tabla no
// interrumpe el resto de la politica.

const assert = require('assert');
const { purgarPorRetencion, POLITICA_RETENCION } = require('../src/services/retencionDatos');

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
      console.error(err.stack || err.message);
      process.exitCode = 1;
    });
}

// Supabase falso por tabla: filas viejas simuladas como lista de ids.
function fakeSupabase(estado) {
  const borrados = {};
  return {
    borrados,
    from(tabla) {
      const t = estado[tabla] || { ids: [], countError: null, delError: null };
      let esCount = false;
      let limite = null;
      const builder = {
        select(_cols, opts) { esCount = Boolean(opts && opts.head); return builder; },
        lt() { return builder; },
        order() { return builder; },
        limit(n) { limite = n; return builder; },
        delete() {
          return {
            in: async (_col, ids) => {
              if (t.delError) return { error: { message: t.delError } };
              borrados[tabla] = (borrados[tabla] || []).concat(ids);
              t.ids = t.ids.filter((id) => !ids.includes(id));
              return { error: null };
            },
          };
        },
        then(resolve) {
          if (esCount) {
            if (t.countError) return resolve({ count: null, error: { message: t.countError } });
            return resolve({ count: t.ids.length, error: null });
          }
          const filas = t.ids.slice(0, limite || t.ids.length).map((id) => ({ id }));
          return resolve({ data: filas, error: null });
        },
      };
      return builder;
    },
  };
}

console.log('\n=== TESTS: retencion de datos (purga por politica) ===\n');

const politicaMini = [
  { tabla: 'logs', dias: 180 },
  { tabla: 'webhook_events', dias: 90 },
];

test('dry-run: cuenta purgables y NO borra nada', async () => {
  const db = fakeSupabase({ logs: { ids: [1, 2, 3] }, webhook_events: { ids: [9] } });
  const r = await purgarPorRetencion(db, { dryRun: true, politica: politicaMini });
  assert.strictEqual(r.dry_run, true);
  assert.deepStrictEqual(db.borrados, {}, 'no debe borrar en dry-run');
  assert.strictEqual(r.resultados[0].purgables, 3);
  assert.strictEqual(r.resultados[0].borradas, 0);
});

test('borrado real: purga por lotes hasta vaciar', async () => {
  const db = fakeSupabase({ logs: { ids: [1, 2, 3, 4, 5] }, webhook_events: { ids: [] } });
  const r = await purgarPorRetencion(db, { dryRun: false, batchSize: 2, politica: politicaMini });
  assert.strictEqual(r.resultados[0].borradas, 5);
  assert.deepStrictEqual(db.borrados.logs, [1, 2, 3, 4, 5]);
  assert.strictEqual(r.resultados[1].purgables, 0);
});

test('maxBatchesPorTabla acota el trabajo y reporta pendientes', async () => {
  const db = fakeSupabase({ logs: { ids: [1, 2, 3, 4, 5, 6] }, webhook_events: { ids: [] } });
  const r = await purgarPorRetencion(db, {
    dryRun: false, batchSize: 2, maxBatchesPorTabla: 2, politica: politicaMini,
  });
  assert.strictEqual(r.resultados[0].borradas, 4);
  assert.strictEqual(r.resultados[0].pendientes, 2);
});

test('un error en una tabla no interrumpe el resto', async () => {
  const db = fakeSupabase({
    logs: { ids: [1], countError: 'tabla rota' },
    webhook_events: { ids: [7, 8] },
  });
  const r = await purgarPorRetencion(db, { dryRun: false, politica: politicaMini });
  assert.strictEqual(r.resultados[0].error, 'tabla rota');
  assert.strictEqual(r.resultados[1].borradas, 2, 'webhook_events debe purgarse igualmente');
});

test('error al borrar: reporta el error y conserva lo ya borrado', async () => {
  const db = fakeSupabase({
    logs: { ids: [1, 2], delError: 'permiso denegado' },
    webhook_events: { ids: [] },
  });
  const r = await purgarPorRetencion(db, { dryRun: false, politica: politicaMini });
  assert.strictEqual(r.resultados[0].borradas, 0);
  assert.strictEqual(r.resultados[0].error, 'permiso denegado');
});

test('la politica por defecto solo incluye tablas operativas seguras', () => {
  const tablas = POLITICA_RETENCION.map((r) => r.tabla);
  assert(!tablas.includes('users'), 'users jamas se purga por antiguedad');
  assert(!tablas.includes('mia_inbound_messages'), 'conversaciones fuera de la v1 (FK de agent_cases)');
  assert(!tablas.includes('user_memory'), 'aprendizaje se borra con el derecho al olvido, no por edad');
  assert(tablas.includes('webhook_events'));
  assert(tablas.includes('logs'));
});

process.on('exit', () => {
  console.log(`\nResultados retencionDatos: ${passed} aprobados, ${failed} fallidos`);
});
