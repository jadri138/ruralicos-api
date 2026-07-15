// Tests del digest via outbox (DIGEST_VIA_OUTBOX): encolado idempotente en
// mia_outbox y reflejo del resultado del drenador en digests/digest_attempts.

const assert = require('assert');
const {
  digestViaOutboxHabilitado,
  digestIdDeOutboxItem,
  encolarDigestsPendientes,
  procesarResultadoDigestOutbox,
} = require('../src/modules/digest/digestOutbox');

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
      console.error(err.stack || err.message);
      process.exitCode = 1;
    });
}

// Supabase falso minimo: sirve datasets por tabla y captura inserts/updates.
function fakeSupabase({ digests = [], users = [], insertError = null } = {}) {
  const inserts = [];
  const updates = [];

  function builder(table) {
    const chain = {
      _table: table,
      select() { return chain; },
      eq() { return chain; },
      in() { return chain; },
      or() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      insert(row) {
        inserts.push({ table, row });
        const error = typeof insertError === 'function' ? insertError(row) : insertError;
        return { then: (resolve) => resolve({ data: null, error }) };
      },
      update(patch) {
        updates.push({ table, patch });
        return chain;
      },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      then(resolve) {
        const data = table === 'digests'
          ? digests
          : table === 'users'
            ? users
            : table === 'digest_attempts'
              ? [{ id: 900, kind: 'daily', status: 'generated', created_at: '2026-07-08T09:00:00Z' }]
              : [];
        resolve({ data, error: null });
      },
    };
    return chain;
  }

  return { inserts, updates, from: (table) => builder(table) };
}

const DIGESTS = [
  { id: 10, user_id: 1, fecha: '2026-07-08', mensaje: 'Hola 1', organization_id: null },
  { id: 11, user_id: 2, fecha: '2026-07-08', mensaje: 'Hola 2', organization_id: 3 },
  { id: 12, user_id: 3, fecha: '2026-07-08', mensaje: 'Hola 3', organization_id: null },
];
const USERS = [
  { id: 1, phone: '34600000001' },
  { id: 2, phone: '34600000002' },
  // user 3 sin telefono
];

async function main() {
  console.log('\n=== TESTS: digestOutbox (envio del digest via cola) ===\n');

  await test('flag DIGEST_VIA_OUTBOX: apagado por defecto, se activa con true', () => {
    assert.strictEqual(digestViaOutboxHabilitado({}), false);
    assert.strictEqual(digestViaOutboxHabilitado({ DIGEST_VIA_OUTBOX: 'false' }), false);
    assert.strictEqual(digestViaOutboxHabilitado({ DIGEST_VIA_OUTBOX: 'true' }), true);
    assert.strictEqual(digestViaOutboxHabilitado({ DIGEST_VIA_OUTBOX: 'TRUE' }), true);
  });

  await test('encolar: crea un item por digest con telefono y sella metadata digest_id', async () => {
    const supabase = fakeSupabase({ digests: DIGESTS, users: USERS });
    const r = await encolarDigestsPendientes(supabase, { fecha: '2026-07-08' });

    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.encolados, 2);
    assert.strictEqual(r.sin_telefono, 1);
    assert.strictEqual(r.errores.length, 0);

    const outbox = supabase.inserts.filter((i) => i.table === 'mia_outbox');
    assert.strictEqual(outbox.length, 2);
    assert.strictEqual(outbox[0].row.to_phone, '34600000001');
    assert.strictEqual(outbox[0].row.status, 'queued');
    assert.strictEqual(outbox[0].row.metadata_json.source, 'digest_diario');
    assert.strictEqual(outbox[0].row.metadata_json.digest_id, 10);
    assert.strictEqual(outbox[1].row.organization_id, 3, 'conserva la organizacion del digest');
  });

  await test('encolar es idempotente: el unique 23505 cuenta como ya_encolado', async () => {
    const supabase = fakeSupabase({
      digests: DIGESTS.slice(0, 2),
      users: USERS,
      insertError: { code: '23505', message: 'duplicate key uq_mia_outbox_digest' },
    });
    const r = await encolarDigestsPendientes(supabase, { fecha: '2026-07-08' });

    assert.strictEqual(r.encolados, 0);
    assert.strictEqual(r.ya_encolados, 2);
    assert.strictEqual(r.errores.length, 0, 'un duplicado no es un error');
  });

  await test('un error real de insert se reporta en errores', async () => {
    const supabase = fakeSupabase({
      digests: DIGESTS.slice(0, 1),
      users: USERS,
      insertError: { code: '23502', message: 'null value in column' },
    });
    const r = await encolarDigestsPendientes(supabase, { fecha: '2026-07-08' });
    assert.strictEqual(r.errores.length, 1);
    assert.strictEqual(r.errores[0].digestId, 10);
  });

  await test('digestIdDeOutboxItem: solo reconoce items del digest', () => {
    assert.strictEqual(digestIdDeOutboxItem({ metadata_json: { digest_id: 42 } }), 42);
    assert.strictEqual(digestIdDeOutboxItem({ metadata_json: { digest_id: '42' } }), 42);
    assert.strictEqual(digestIdDeOutboxItem({ metadata_json: { intent: 'reply' } }), null);
    assert.strictEqual(digestIdDeOutboxItem({}), null);
    assert.strictEqual(digestIdDeOutboxItem(null), null);
  });

  await test('resultado sent: marca digests.enviado y attempt sent', async () => {
    const supabase = fakeSupabase({});
    const item = { id: 1, metadata_json: { digest_id: 10 } };
    const r = await procesarResultadoDigestOutbox(supabase, item, { status: 'sent' });

    assert.deepStrictEqual({ digest: r.digest, marcado: r.marcado }, { digest: true, marcado: 'sent' });
    const updDigest = supabase.updates.find((u) => u.table === 'digests');
    assert.strictEqual(updDigest.patch.enviado, true);
    assert(updDigest.patch.enviado_at, 'sella enviado_at');
    const updAttempt = supabase.updates.find((u) => u.table === 'digest_attempts');
    assert.strictEqual(updAttempt.patch.status, 'sent');
  });

  await test('fallo con reintentos pendientes: anota error pero NO cierra el attempt', async () => {
    const supabase = fakeSupabase({});
    const item = { id: 1, metadata_json: { digest_id: 10 } };
    const r = await procesarResultadoDigestOutbox(supabase, item, {
      status: 'failed', retryable: true, error: 'timeout ultramsg',
    });

    assert.strictEqual(r.marcado, 'failed_retryable');
    const updDigest = supabase.updates.find((u) => u.table === 'digests');
    assert.strictEqual(updDigest.patch.error_msg, 'timeout ultramsg');
    assert.strictEqual(updDigest.patch.enviado, undefined, 'no toca enviado');
    const updAttempt = supabase.updates.find((u) => u.table === 'digest_attempts');
    assert.strictEqual(updAttempt, undefined, 'el attempt sigue abierto mientras haya reintentos');
  });

  await test('fallo definitivo (sin reintentos): cierra el attempt como failed', async () => {
    const supabase = fakeSupabase({});
    const item = { id: 1, metadata_json: { digest_id: 10 } };
    const r = await procesarResultadoDigestOutbox(supabase, item, {
      status: 'failed', retryable: false, error: 'numero bloqueado',
    });
    assert.strictEqual(r.marcado, 'failed_final');
    const updAttempt = supabase.updates.find((u) => u.table === 'digest_attempts');
    assert.strictEqual(updAttempt.patch.status, 'failed');
  });

  await test('item ajeno al digest: no toca nada', async () => {
    const supabase = fakeSupabase({});
    const r = await procesarResultadoDigestOutbox(supabase, { id: 1, metadata_json: { intent: 'reply' } }, { status: 'sent' });
    assert.strictEqual(r.digest, false);
    assert.strictEqual(supabase.updates.length, 0);
  });

  console.log(`\nResultados digestOutbox: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}

main();
