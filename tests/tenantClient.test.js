// Tests de tenantClient: el filtro de tenant se aplica SIEMPRE, en un unico
// sitio, sin depender de que cada ruta recuerde el .eq('organization_id').

const assert = require('assert');
const { crearTenantClient, orgClient, TENANT_TABLES } = require('../src/modules/partner/tenantClient');

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
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

// Builder falso: registra la cadena de llamadas para poder asegurar que el
// wrapper anade el eq del tenant y sella los inserts.
function fakeSupabase() {
  const calls = [];
  function builder() {
    const chain = {};
    for (const method of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'in', 'or', 'order', 'limit', 'maybeSingle', 'single']) {
      chain[method] = (...args) => {
        calls.push({ method, args });
        return chain;
      };
    }
    return chain;
  }
  return {
    calls,
    from(table) {
      calls.push({ method: 'from', args: [table] });
      return builder();
    },
  };
}

function eqTenant(calls) {
  return calls.filter((c) => c.method === 'eq' && (c.args[0] === 'organization_id' || c.args[0] === 'id'));
}

console.log('\n=== TESTS: tenantClient (aislamiento multi-tenant) ===\n');

test('select en tabla registrada anade eq(organization_id, orgId)', () => {
  const supabase = fakeSupabase();
  const db = crearTenantClient(supabase, 7);
  db.from('users').select('id, name');
  const eqs = eqTenant(supabase.calls);
  assert.strictEqual(eqs.length, 1);
  assert.deepStrictEqual(eqs[0].args, ['organization_id', 7]);
});

test('update y delete tambien filtran por tenant', () => {
  const supabase = fakeSupabase();
  const db = crearTenantClient(supabase, 7);
  db.from('organization_zones').update({ name: 'X' }).eq('id', 3);
  db.from('organization_zones').delete().eq('id', 3);
  const eqs = supabase.calls.filter((c) => c.method === 'eq' && c.args[0] === 'organization_id');
  assert.strictEqual(eqs.length, 2, 'update y delete deben llevar el filtro de tenant');
});

test('insert sella organization_id aunque el payload traiga otro', () => {
  const supabase = fakeSupabase();
  const db = crearTenantClient(supabase, 7);
  db.from('organization_clients').insert({ display_name: 'Paco', organization_id: 999 });
  const insert = supabase.calls.find((c) => c.method === 'insert');
  assert.strictEqual(insert.args[0].organization_id, 7, 'el tenant del token manda sobre el del payload');
});

test('insert de array sella todas las filas', () => {
  const supabase = fakeSupabase();
  const db = crearTenantClient(supabase, 7);
  db.from('organization_zones').insert([{ name: 'A' }, { name: 'B', organization_id: 999 }]);
  const insert = supabase.calls.find((c) => c.method === 'insert');
  assert(insert.args[0].every((row) => row.organization_id === 7));
});

test('upsert sella el tenant y conserva las opciones (onConflict)', () => {
  const supabase = fakeSupabase();
  const db = crearTenantClient(supabase, 7);
  db.from('organization_members').upsert({ user_id: 5, role: 'member' }, { onConflict: 'organization_id,user_id' });
  const upsert = supabase.calls.find((c) => c.method === 'upsert');
  assert.strictEqual(upsert.args[0].organization_id, 7);
  assert.deepStrictEqual(upsert.args[1], { onConflict: 'organization_id,user_id' });
});

test('organizations: select filtra por id (la org es el tenant)', () => {
  const supabase = fakeSupabase();
  const db = crearTenantClient(supabase, 7);
  db.from('organizations').select('id, name');
  const eqs = eqTenant(supabase.calls);
  assert.deepStrictEqual(eqs[0].args, ['id', 7]);
});

test('organizations: insert/upsert/delete prohibidos desde el panel', () => {
  const supabase = fakeSupabase();
  const db = crearTenantClient(supabase, 7);
  assert.throws(() => db.from('organizations').insert({ name: 'X' }), /insert no permitido/);
  assert.throws(() => db.from('organizations').upsert({ name: 'X' }), /upsert no permitido/);
  assert.throws(() => db.from('organizations').delete(), /delete no permitido/);
});

test('tabla no registrada lanza error (obliga a decidir explicitamente)', () => {
  const supabase = fakeSupabase();
  const db = crearTenantClient(supabase, 7);
  assert.throws(() => db.from('alertas'), /sin columna de tenant registrada/);
});

test('organizationId invalido lanza error', () => {
  const supabase = fakeSupabase();
  for (const invalido of [0, -1, null, undefined, 'abc', 1.5]) {
    assert.throws(() => crearTenantClient(supabase, invalido), /organizationId invalido/);
  }
});

test('sinTenant expone el cliente crudo (escape deliberado)', () => {
  const supabase = fakeSupabase();
  const db = crearTenantClient(supabase, 7);
  assert.strictEqual(db.sinTenant, supabase);
});

test('orgClient toma el orgId del req.org que deja requireOrg', () => {
  const supabase = fakeSupabase();
  const db = orgClient(supabase, { org: { organizationId: 42 } });
  assert.strictEqual(db.organizationId, 42);
  assert.throws(() => orgClient(supabase, {}), /organizationId invalido/);
});

test('el registro cubre las tablas que tocan las rutas partner', () => {
  for (const tabla of ['users', 'digests', 'organization_members', 'organization_zones', 'organization_clients', 'organizations', 'organization_panel_events', 'alerta_clicks']) {
    assert(TENANT_TABLES[tabla], `falta ${tabla} en TENANT_TABLES`);
  }
});

console.log(`\nResultados tenantClient: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
