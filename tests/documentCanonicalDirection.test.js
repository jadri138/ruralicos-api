process.env.CRON_TOKEN = 'document-canonical-direction-token';

const assert = require('assert');
const fixtures = require('./fixtures/p0/original-edges.json');
const registerDeduplicationRoutes = require('../src/modules/alertas/deduplicar.routes');

async function runScenario(derivedName, rowsOrder, derivedId) {
  const base = fixtures.document_relations;
  const original = {
    ...base.original,
    id: 10,
    fecha: '2026-07-20',
    estado_ia: 'listo',
    decision_audit: {},
  };
  const derived = {
    ...base[derivedName],
    id: derivedId,
    fecha: '2026-07-20',
    estado_ia: 'listo',
    decision_audit: {},
  };
  const byName = { original, derived };
  const rows = rowsOrder.map((name) => byName[name]);
  const query = {
    select() { return this; },
    gte() { return this; },
    lte() { return this; },
    eq() { return this; },
    order() { return this; },
    then(resolve) { resolve({ data: rows, error: null }); },
  };
  const supabase = { from: () => query };
  const app = {
    handlers: {},
    get(path, handler) { this.handlers[`GET ${path}`] = handler; },
    post(path, handler) { this.handlers[`POST ${path}`] = handler; },
  };
  registerDeduplicationRoutes(app, supabase);

  return new Promise((resolve, reject) => {
    const req = {
      query: { fecha: '2026-07-20', dry_run: 'true' },
      get: () => process.env.CRON_TOKEN,
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) {
        try {
          assert.strictEqual(this.statusCode, 200);
          assert.strictEqual(body.detalle[0].canonico.id, original.id, `${derivedName}/${rowsOrder.join('-')}`);
          assert.strictEqual(body.deduplicadas, 0, derivedName);
          assert.strictEqual(body.relacionadas, 1, derivedName);
          resolve();
        } catch (error) {
          reject(error);
        }
      },
    };
    app.handlers['GET /alertas/deduplicar'](req, res);
  });
}

(async () => {
  await runScenario('update', ['original', 'derived'], 11);
  await runScenario('update', ['derived', 'original'], 9);
  await runScenario('correction', ['original', 'derived'], 11);
  await runScenario('correction', ['derived', 'original'], 9);
  console.log('OK: original siempre canonico frente a actualizaciones y correcciones');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
