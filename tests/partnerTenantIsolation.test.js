// Aislamiento multi-tenant del panel partner.
//
// Monta las rutas reales de partner.data.routes.js sobre un `app` y un `supabase`
// falsos (sin DB). El supabase falso respeta los `.eq('organization_id', X)` y los
// `.in('user_id', ids)` que usan los handlers, de modo que el test comprueba que un
// staff de la organizacion A nunca recibe socios ni digests de la organizacion B.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const assert = require('assert');
const dataRoutes = require('../src/modules/partner/partner.data.routes');

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`OK: ${name}`))
    .catch((err) => {
      console.error(`FAIL: ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

// ──────────────────────────────────────────────────────────────────
// Dataset de dos cooperativas. A = org 1, B = org 2.
// ──────────────────────────────────────────────────────────────────
const A_IDS = [101, 102];
const B_IDS = [201, 202];

const DATA = {
  users: [
    { id: 101, organization_id: 1, name: 'A-uno', legal_name: 'Socio A1', phone: '34600000001', email: null, subscription: 'cooperativa', created_at: '2026-01-01T00:00:00Z' },
    { id: 102, organization_id: 1, name: 'A-dos', legal_name: 'Socio A2', phone: '34600000002', email: null, subscription: 'free', created_at: '2026-01-02T00:00:00Z' },
    { id: 201, organization_id: 2, name: 'B-uno', legal_name: 'Socio B1', phone: '34600000201', email: null, subscription: 'cooperativa', created_at: '2026-01-03T00:00:00Z' },
    { id: 202, organization_id: 2, name: 'B-dos', legal_name: 'Socio B2', phone: '34600000202', email: null, subscription: 'corral', created_at: '2026-01-04T00:00:00Z' },
  ],
  organization_members: [
    { user_id: 101, organization_id: 1, role: 'member', status: 'active', zone_id: 11 },
    { user_id: 102, organization_id: 1, role: 'agent', status: 'active', zone_id: null },
    { user_id: 201, organization_id: 2, role: 'member', status: 'active', zone_id: 21 },
    { user_id: 202, organization_id: 2, role: 'member', status: 'active', zone_id: 21 },
  ],
  organization_zones: [
    { id: 11, organization_id: 1, name: 'Zona A', color: '#111111' },
    { id: 21, organization_id: 2, name: 'Zona B', color: '#222222' },
  ],
  digests: [
    { id: 1, user_id: 101, organization_id: 1, fecha: '2026-06-15', mensaje: 'Mensaje A1', enviado: true, enviado_at: '2026-06-15T08:00:00Z', created_at: '2026-06-15T08:00:00Z', alerta_ids: [1, 2] },
    { id: 2, user_id: 102, organization_id: 1, fecha: '2026-06-16', mensaje: 'Mensaje A2', enviado: true, enviado_at: '2026-06-16T08:00:00Z', created_at: '2026-06-16T08:00:00Z', alerta_ids: [3] },
    { id: 3, user_id: 201, organization_id: 2, fecha: '2026-06-15', mensaje: 'Mensaje B1', enviado: true, enviado_at: '2026-06-15T08:00:00Z', created_at: '2026-06-15T08:00:00Z', alerta_ids: [9] },
    { id: 4, user_id: 202, organization_id: 2, fecha: '2026-06-16', mensaje: 'Mensaje B2', enviado: true, enviado_at: '2026-06-16T08:00:00Z', created_at: '2026-06-16T08:00:00Z', alerta_ids: [9, 8] },
  ],
};

// QueryBuilder falso: encadena select/eq/in/order/limit y es awaitable ({ data, error }).
function makeBuilder(table) {
  const eqFilters = [];
  let inFilter = null;

  const builder = {
    select() { return builder; },
    order() { return builder; },
    limit() { return builder; },
    gte() { return builder; },
    lte() { return builder; },
    eq(col, val) { eqFilters.push([col, val]); return builder; },
    in(col, arr) { inFilter = [col, new Set(arr.map(Number))]; return builder; },
    then(onFulfilled) {
      const rows = (DATA[table] || []).filter((row) => {
        for (const [col, val] of eqFilters) {
          if (row[col] !== val) return false;
        }
        if (inFilter && !inFilter[1].has(Number(row[inFilter[0]]))) return false;
        return true;
      });
      return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
    },
  };
  return builder;
}

const fakeSupabase = { from: (table) => makeBuilder(table) };

// `app` falso: guarda el ultimo handler de cada ruta (ignora middlewares como requireOrg).
const routes = {};
const app = {
  get: (path, ...handlers) => { routes[`GET ${path}`] = handlers[handlers.length - 1]; },
  post: (path, ...handlers) => { routes[`POST ${path}`] = handlers[handlers.length - 1]; },
  patch: (path, ...handlers) => { routes[`PATCH ${path}`] = handlers[handlers.length - 1]; },
  delete: (path, ...handlers) => { routes[`DELETE ${path}`] = handlers[handlers.length - 1]; },
};

dataRoutes(app, fakeSupabase);

// Invoca un handler con un req.org concreto y devuelve { status, body }.
function invoke(routeKey, organizationId, { query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const handler = routes[routeKey];
    if (!handler) return reject(new Error(`Ruta no registrada: ${routeKey}`));
    const req = { org: { organizationId, memberRole: 'owner' }, query, params: {}, body: {} };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    return handler(req, res);
  });
}

console.log('\n=== TESTS: partner tenant isolation ===\n');

test('GET /partner/members solo devuelve socios de la propia organizacion', async () => {
  const a = await invoke('GET /partner/members', 1);
  assert.strictEqual(a.status, 200);
  const aIds = a.body.items.map((s) => s.id).sort();
  assert.deepStrictEqual(aIds, A_IDS, 'org A debe ver exactamente sus socios');
  assert(!aIds.some((id) => B_IDS.includes(id)), 'org A no debe ver socios de B');

  const b = await invoke('GET /partner/members', 2);
  const bIds = b.body.items.map((s) => s.id).sort();
  assert.deepStrictEqual(bIds, B_IDS, 'org B debe ver exactamente sus socios');
  assert(!bIds.some((id) => A_IDS.includes(id)), 'org B no debe ver socios de A');
});

test('GET /partner/digests solo devuelve digests de socios de la propia organizacion', async () => {
  const a = await invoke('GET /partner/digests', 1);
  assert.strictEqual(a.status, 200);
  const aUserIds = a.body.items.map((d) => d.user_id);
  assert(aUserIds.length > 0, 'org A debe tener digests');
  assert(aUserIds.every((id) => A_IDS.includes(id)), 'todos los digests de A pertenecen a socios de A');
  assert(!aUserIds.some((id) => B_IDS.includes(id)), 'org A no debe ver digests de B');

  const b = await invoke('GET /partner/digests', 2);
  const bUserIds = b.body.items.map((d) => d.user_id);
  assert(bUserIds.every((id) => B_IDS.includes(id)), 'todos los digests de B pertenecen a socios de B');
  assert(!bUserIds.some((id) => A_IDS.includes(id)), 'org B no debe ver digests de A');
});

test('GET /partner/digests resuelve destinatario y mensaje sin cruzar de organizacion', async () => {
  const a = await invoke('GET /partner/digests', 1);
  // El destinatario se resuelve al nombre del socio (legal_name) de la propia org.
  const names = a.body.items.map((d) => d.recipient?.name).sort();
  assert.deepStrictEqual(names, ['Socio A1', 'Socio A2'], 'destinatarios resueltos a socios de A');
  assert(a.body.items.every((d) => typeof d.mensaje === 'string'), 'cada mensaje trae su texto');
  // Nunca debe aparecer el nombre de un socio de B.
  assert(!names.some((n) => n === 'Socio B1' || n === 'Socio B2'), 'org A no ve nombres de B');
});

test('la zona de un socio nunca cruza de organizacion', async () => {
  const a = await invoke('GET /partner/members', 1);
  // El socio 101 esta en la zona 11 (de A); ninguna fila debe referenciar la zona 21 (de B).
  const zonas = a.body.items.map((s) => s.zone_id).filter((z) => z != null);
  assert(zonas.every((z) => z === 11), 'org A solo asigna sus propias zonas');
});
