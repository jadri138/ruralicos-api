process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
  ejecutarExploracionDiariaAcotada,
  cargarUltimoDigestEntregadoParaExploracion,
  cargarUltimoControlExploracion,
  digestYaExplorado,
} = require('../src/modules/aprendizaje/cerebro.routes');

function fakeSupabase(users, onQuery = () => {}) {
  const chain = {
    select() { return chain; },
    in() { return chain; },
    not() { return chain; },
    neq() { return chain; },
    or() { return chain; },
    order() { return chain; },
    limit(value) {
      onQuery(value);
      return Promise.resolve({ data: users, error: null });
    },
  };
  return {
    from(table) {
      assert.strictEqual(table, 'users');
      return chain;
    },
  };
}

function fakeElegibilidad(seed = {}) {
  const tables = Object.fromEntries(
    Object.entries(seed).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))])
  );

  return {
    tables,
    from(table) {
      const filters = [];
      let order = null;
      let limit = null;
      const query = {
        select() { return query; },
        eq(column, value) { filters.push((row) => row[column] === value); return query; },
        in(column, values) { filters.push((row) => values.includes(row[column])); return query; },
        gte(column, value) { filters.push((row) => String(row[column]) >= String(value)); return query; },
        lte(column, value) { filters.push((row) => String(row[column]) <= String(value)); return query; },
        contains(column, expected) {
          filters.push((row) => Object.entries(expected).every(([key, value]) => row[column]?.[key] === value));
          return query;
        },
        order(column, options = {}) { order = { column, ascending: options.ascending !== false }; return query; },
        limit(value) { limit = Number(value); return query; },
        async maybeSingle() {
          let rows = (tables[table] || []).filter((row) => filters.every((filter) => filter(row)));
          if (order) {
            const direction = order.ascending ? 1 : -1;
            rows = [...rows].sort(
              (left, right) => String(left[order.column] || '').localeCompare(String(right[order.column] || '')) * direction
            );
          }
          if (Number.isFinite(limit)) rows = rows.slice(0, limit);
          return { data: rows[0] || null, error: null };
        },
      };
      return query;
    },
  };
}

async function main() {
  const lateAckDb = fakeElegibilidad({
    digests: [
      {
        id: 502,
        user_id: 7,
        fecha: '2026-08-02',
        delivery_status: 'SENT_TO_WHATSAPP',
        created_at: '2026-08-02T08:00:00Z',
      },
      {
        id: 501,
        user_id: 7,
        fecha: '2026-08-01',
        delivery_status: 'DELIVERED',
        delivered_at: '2026-08-02T09:00:00Z',
        created_at: '2026-08-01T08:00:00Z',
      },
      {
        id: 490,
        user_id: 7,
        fecha: '2026-07-20',
        delivery_status: 'READ',
        read_at: '2026-07-21T09:00:00Z',
      },
    ],
    mia_outbox: [],
  });
  const digestTrasAckTardio = await cargarUltimoDigestEntregadoParaExploracion(lateAckDb, 7, {
    now: new Date('2026-08-02T10:00:00Z'),
    windowDays: 7,
  });
  assert.strictEqual(digestTrasAckTardio.id, 501, 'el ACK del día siguiente mantiene el digest elegible');
  assert.strictEqual(await digestYaExplorado(lateAckDb, 7, 501), false);
  lateAckDb.tables.mia_outbox.push({
    id: 900,
    user_id: 7,
    metadata_json: { intent: 'learning_question', digest_id: 501 },
  });
  assert.strictEqual(
    await digestYaExplorado(lateAckDb, 7, 501),
    true,
    'un digest ya vinculado a una pregunta no vuelve a preguntarse'
  );

  const memoriaRuidosa = Array.from({ length: 60 }, (_, index) => ({
    id: index + 10,
    user_id: 7,
    status: 'active',
    contenido: `señal débil ${index + 1}`,
    last_seen_at: `2026-07-${String((index % 28) + 1).padStart(2, '0')}T12:00:00Z`,
  }));
  const controlDb = fakeElegibilidad({
    user_memory: [{
      id: 1,
      user_id: 7,
      status: 'active',
      contenido: 'MIA_EXPLORATION_CONTROL:paused',
      last_seen_at: '2026-01-01T12:00:00Z',
    }, ...memoriaRuidosa],
  });
  const pausaFueraDeVentana = await cargarUltimoControlExploracion(controlDb, 7);
  assert.strictEqual(
    pausaFueraDeVentana.contenido,
    'MIA_EXPLORATION_CONTROL:paused',
    'la pausa sigue visible aunque existan más de 50 memorias posteriores'
  );
  controlDb.tables.user_memory.push({
    id: 1000,
    user_id: 7,
    status: 'active',
    contenido: 'MIA_EXPLORATION_CONTROL:active',
    last_seen_at: '2026-08-02T12:00:00Z',
  });
  const reactivado = await cargarUltimoControlExploracion(controlDb, 7);
  assert.strictEqual(
    reactivado.contenido,
    'MIA_EXPLORATION_CONTROL:active',
    'una reactivación explícita posterior prevalece sobre la pausa'
  );

  let consultas = 0;
  let exploraciones = 0;
  const sinCupo = await ejecutarExploracionDiariaAcotada({
    supabase: fakeSupabase([], () => { consultas += 1; }),
    contarPreguntasFn: async () => 20,
    explorarUsuarioFn: async () => { exploraciones += 1; },
    maxDaily: 20,
  });
  assert.strictEqual(sinCupo.disponibles, 0);
  assert.strictEqual(sinCupo.encoladas, 0);
  assert.strictEqual(consultas, 0, 'no consulta usuarios si ya se alcanzó el límite');
  assert.strictEqual(exploraciones, 0, 'no explora usuarios si ya se alcanzó el límite');

  let queryLimit = null;
  const llamadas = [];
  const acotada = await ejecutarExploracionDiariaAcotada({
    supabase: fakeSupabase(
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
      (value) => { queryLimit = value; }
    ),
    contarPreguntasFn: async () => 18,
    explorarUsuarioFn: async (userId, options) => {
      llamadas.push({ userId, options });
      if (userId === 1) return { ok: true, skipped: true, reason: 'sin_incertidumbre' };
      if (userId === 2) return { ok: true, user_id: userId, encolada: true };
      if (userId === 3) throw new Error('fallo aislado de prueba');
      return { ok: true, user_id: userId, encolada: true };
    },
    maxDaily: 20,
    limit: 100,
  });

  assert.strictEqual(queryLimit, 10, 'solo revisa un grupo pequeño para cubrir el cupo');
  assert.strictEqual(acotada.evaluados, 4);
  assert.strictEqual(acotada.seleccionados, 2);
  assert.strictEqual(acotada.encoladas, 2);
  assert.strictEqual(acotada.errores, 1, 'un usuario con error no bloquea a los demás');
  assert.strictEqual(acotada.ok, false);
  assert(llamadas.every((item) => item.options.force === false));

  const simulada = await ejecutarExploracionDiariaAcotada({
    supabase: fakeSupabase([{ id: 7 }]),
    contarPreguntasFn: async () => 19,
    explorarUsuarioFn: async (userId, options) => ({
      ok: true,
      user_id: userId,
      dry_run: options.dryRun,
    }),
    dryRun: true,
    maxDaily: 20,
  });
  assert.strictEqual(simulada.seleccionados, 1);
  assert.strictEqual(simulada.encoladas, 0, 'la simulación no encola ni envía mensajes');

  console.log('OK: la exploración diaria es selectiva, acotada y solo usa la cola');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
