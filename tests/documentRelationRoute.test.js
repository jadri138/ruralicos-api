process.env.CRON_TOKEN = 'document-relation-test-token';

const assert = require('assert');
const registerDeduplicationRoutes = require('../src/modules/alertas/deduplicar.routes');

const rows = [
  {
    id: 1,
    fuente: 'DOGC',
    fecha: '2026-07-10',
    titulo: 'Ley 5/2026, de medidas para las explotaciones agrarias',
    contenido: 'Texto autonomico de la Ley 5/2026 sobre explotaciones agrarias.',
    estado_ia: 'listo',
    decision_audit: {},
  },
  {
    id: 2,
    fuente: 'BOE',
    fecha: '2026-07-18',
    titulo: 'Ley 5/2026, de medidas para las explotaciones agrarias',
    contenido: 'Publicacion estatal de la Ley 5/2026 sobre explotaciones agrarias.',
    estado_ia: 'listo',
    decision_audit: {},
  },
];

const filters = [];
const query = {
  select() { return this; },
  gte(column, value) { filters.push(['gte', column, value]); return this; },
  lte(column, value) { filters.push(['lte', column, value]); return this; },
  eq(column, value) { filters.push(['eq', column, value]); return this; },
  order() { return this; },
  then(resolve) { resolve({ data: rows, error: null }); },
};
const supabase = {
  from(table) {
    assert.strictEqual(table, 'alertas');
    return query;
  },
};
const app = {
  handlers: {},
  get(path, handler) { this.handlers[`GET ${path}`] = handler; },
  post(path, handler) { this.handlers[`POST ${path}`] = handler; },
};

registerDeduplicationRoutes(app, supabase);

const req = {
  query: { fecha: '2026-07-18', dry_run: 'true', lookback_days: '30' },
  get(name) {
    return name.toLowerCase() === 'x-cron-token' ? process.env.CRON_TOKEN : '';
  },
};

new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) {
      try {
        assert.strictEqual(this.statusCode, 200);
        assert.strictEqual(body.lookback_days, 30);
        assert.strictEqual(body.deduplicadas, 1);
        assert.strictEqual(body.detalle[0].relaciones[0].relation, 'cross_source_republication');
        assert(filters.some(([op, column, value]) => op === 'gte' && column === 'fecha' && value === '2026-06-18'));
        assert(filters.some(([op, column, value]) => op === 'lte' && column === 'fecha' && value === '2026-07-18'));
        console.log('OK: deduplicacion diaria compara republicaciones de fechas anteriores');
        resolve();
      } catch (error) {
        reject(error);
      }
    },
  };

  app.handlers['GET /alertas/deduplicar'](req, res);
}).catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
