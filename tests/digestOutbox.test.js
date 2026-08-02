// Tests del digest via outbox: encolado idempotente y autoridad final previa.
// Las transiciones posteriores viven y se prueban en whatsappDelivery.test.js.

const assert = require('assert');
const {
  digestIdDeOutboxItem,
  encolarDigestsPendientes,
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
function fakeSupabase({ digests = [], users = [], digestItems = null, insertError = null } = {}) {
  const inserts = [];
  const updates = [];
  const queries = [];
  const safeDigestItems = digestItems || digests.map((digest, index) => ({
    digest_id: digest.id,
    alerta_id: 1000 + index,
    selection_action: 'include',
    selection_decision: { action: 'include', incluir: true },
    tags_json: {
      final_validation_decision: { status: 'send', flags: [], reasons: [] },
      effective_send_decision: 'send',
      effective_reason: 'automatic_send_allowed',
      effective_gate_version: 'final_send_gate_v1',
      automatic_send_allowed: true,
    },
  }));

  function builder(table) {
    const chain = {
      _table: table,
      select(columns) {
        queries.push({ table, op: 'select', columns });
        return chain;
      },
      eq() { return chain; },
      in() { return chain; },
      or(expression) {
        queries.push({ table, op: 'or', expression });
        return chain;
      },
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
          : table === 'digest_items'
            ? safeDigestItems
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

  return { inserts, updates, queries, from: (table) => builder(table) };
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
    assert.strictEqual(outbox[0].row.delivery_status, 'QUEUED');
    assert(outbox[0].row.idempotency_key.startsWith('digest:10:'), 'clave idempotente estable por digest y version');
    assert(outbox[0].row.message_version, 'versiona el cuerpo enviado');
    assert.strictEqual(outbox[0].row.metadata_json.source, 'digest_diario');
    assert.strictEqual(outbox[0].row.metadata_json.digest_id, 10);
    assert.strictEqual(outbox[1].row.organization_id, 3, 'conserva la organizacion del digest');
  });

  await test('encolar reutiliza la idempotencia aprobada y excluye estados aceptados o posteriores', async () => {
    const supabase = fakeSupabase({
      digests: [{
        ...DIGESTS[0],
        delivery_status: 'APPROVED',
        idempotency_key: 'digest-approved-key',
        message_version: 'digest-approved-version',
      }],
      users: USERS,
    });
    await encolarDigestsPendientes(supabase, { fecha: '2026-07-08' });

    const outbox = supabase.inserts.find((item) => item.table === 'mia_outbox')?.row;
    assert.strictEqual(outbox.idempotency_key, 'digest-approved-key');
    assert.strictEqual(outbox.message_version, 'digest-approved-version');
    const selectDigest = supabase.queries.find((item) => item.table === 'digests' && item.op === 'select');
    assert.match(selectDigest.columns, /idempotency_key, message_version, delivery_status/);
    const deliveryFilter = supabase.queries.find((item) => item.table === 'digests' && item.op === 'or');
    assert.strictEqual(deliveryFilter.expression, 'delivery_status.is.null,delivery_status.in.(DRAFT,APPROVED)');
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

  await test('digest sin autoridad final persistida no se encola', async () => {
    const supabase = fakeSupabase({
      digests: DIGESTS.slice(0, 1),
      users: USERS,
      digestItems: [],
    });
    const r = await encolarDigestsPendientes(supabase, { fecha: '2026-07-08' });
    assert.strictEqual(r.encolados, 0);
    assert.strictEqual(r.bloqueados_validacion_final, 1);
    assert.strictEqual(supabase.inserts.filter((item) => item.table === 'mia_outbox').length, 0);
  });

  await test('digest con item blocked no se encola aunque la seleccion fuese include', async () => {
    const supabase = fakeSupabase({
      digests: DIGESTS.slice(0, 1),
      users: USERS,
      digestItems: [{
        digest_id: 10,
        alerta_id: 1000,
        selection_action: 'include',
        selection_decision: { action: 'include', incluir: true },
        tags_json: {
          final_validation_decision: { status: 'blocked' },
          effective_send_decision: 'blocked',
          effective_gate_version: 'final_send_gate_v1',
          automatic_send_allowed: false,
        },
      }],
    });
    const r = await encolarDigestsPendientes(supabase, { fecha: '2026-07-08' });
    assert.strictEqual(r.encolados, 0);
    assert.strictEqual(r.bloqueados_validacion_final, 1);
  });

  await test('digestIdDeOutboxItem: solo reconoce items del digest', () => {
    assert.strictEqual(digestIdDeOutboxItem({ metadata_json: { digest_id: 42 } }), 42);
    assert.strictEqual(digestIdDeOutboxItem({ metadata_json: { digest_id: '42' } }), 42);
    assert.strictEqual(digestIdDeOutboxItem({ metadata_json: { intent: 'reply' } }), null);
    assert.strictEqual(digestIdDeOutboxItem({}), null);
    assert.strictEqual(digestIdDeOutboxItem(null), null);
  });

  console.log(`\nResultados digestOutbox: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}

main();
