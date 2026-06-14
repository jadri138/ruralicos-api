process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { __testing } = require('../src/modules/usuarios/usuarios.routes');

function test(name, fn) {
  try {
    fn();
    console.log(`OK: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('\n=== TESTS: user deletion tables ===\n');

test('limpia tablas personales nuevas y legacy', () => {
  const requiredTables = [
    'digest_items',
    'digest_attempts',
    'official_list_matches',
    'mia_actions',
    'mia_decisions',
    'mia_outbox',
    'mia_agent_cases',
    'mia_structured_memory',
    'mia_inbound_messages',
    'webhook_events',
    'organization_members',
    'digests',
    'alerta_feedback',
    'user_memory',
  ];

  for (const table of requiredTables) {
    assert(
      __testing.USER_OWNED_TABLES.includes(table),
      `Debe limpiar ${table} al borrar usuario`
    );
  }
});

test('detecta ids UUID de Supabase Auth sin asumir que todos los ids lo son', () => {
  assert.strictEqual(__testing.isSupabaseAuthUuid('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.strictEqual(__testing.isSupabaseAuthUuid('123'), false);
});

test('borrado admin y borrado propio usan la misma limpieza', () => {
  // El borrado admin (gestion) y el propio (cuenta) viven en sub-rutas distintas
  // pero comparten el mismo helper deleteUserOwnedRows del contexto.
  const dir = path.join(__dirname, '..', 'src/modules/usuarios');
  const source =
    fs.readFileSync(path.join(dir, 'usuarios.gestion.routes.js'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(dir, 'usuarios.cuenta.routes.js'), 'utf8');
  assert(source.includes('const tablasLimpiadas = await deleteUserOwnedRows(id);'));
  assert(source.includes('const tablasLimpiadas = await deleteUserOwnedRows(userId);'));
});
