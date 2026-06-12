process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const { __testing } = require('../src/routes/feedback');

const {
  buscarConversacionActiva,
  cargarDigestYAlertas,
  esConversacionMIADelDia,
  fechaMadridConversacionMIA,
  getExpiracionFinDiaMadridISO,
} = __testing;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FALLO: ${message}`);
    failed += 1;
    return;
  }
  console.log(`OK: ${message}`);
  passed += 1;
}

function crearSupabaseMock(tablas = {}) {
  const calls = [];

  function filtrar(table, filters) {
    let rows = tablas[table] || [];
    for (const filter of filters) {
      if (filter.op === 'eq') {
        rows = rows.filter((row) => row[filter.column] === filter.value);
      }
      if (filter.op === 'in') {
        const values = new Set(filter.values);
        rows = rows.filter((row) => values.has(row[filter.column]));
      }
    }
    return rows;
  }

  return {
    calls,
    from(table) {
      const query = {
        table,
        op: 'select',
        filters: [],
        patch: null,
        select(columns) {
          calls.push({ table, op: 'select', columns });
          return this;
        },
        eq(column, value) {
          this.filters.push({ op: 'eq', column, value });
          calls.push({ table, op: 'eq', column, value });
          return this;
        },
        gt(column, value) {
          calls.push({ table, op: 'gt', column, value });
          return this;
        },
        or() {
          throw new Error('No deberia consultar digests antiguos con .or()');
        },
        in(column, values) {
          if (this.op === 'update') {
            calls.push({ table, op: 'update_in', column, values, patch: this.patch });
            return Promise.resolve({ error: null });
          }
          this.filters.push({ op: 'in', column, values });
          calls.push({ table, op: 'in', column, values });
          return this;
        },
        order() {
          return this;
        },
        limit() {
          return this;
        },
        update(patch) {
          this.op = 'update';
          this.patch = patch;
          calls.push({ table, op: 'update', patch });
          return this;
        },
        maybeSingle() {
          const rows = filtrar(table, this.filters);
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        then(resolve, reject) {
          return Promise.resolve({ data: filtrar(table, this.filters), error: null }).then(resolve, reject);
        },
      };

      return query;
    },
  };
}

console.log('\n=== TESTS: mia conversation daily reset ===\n');

assert(
  fechaMadridConversacionMIA({ contexto_json: { fecha: '2026-06-05-prueba-123' } }) === '2026-06-05',
  'Extrae fecha diaria aunque el contexto sea de prueba'
);

assert(
  esConversacionMIADelDia({ contexto_json: { fecha: '2026-06-04' } }, '2026-06-05') === false,
  'No considera activa una conversacion de otro dia'
);

assert(
  getExpiracionFinDiaMadridISO('2026-06-05') === '2026-06-05T22:00:00.000Z',
  'Caduca al final del dia Madrid en horario de verano'
);

(async () => {
  const supabaseConversaciones = crearSupabaseMock({
    user_conversations: [
      {
        id: 10,
        user_id: 141,
        estado: 'activa',
        tipo: 'feedback_digest',
        contexto_json: { fecha: '2026-06-04', digest_id: 1 },
        abierta_at: '2026-06-04T18:00:00.000Z',
        expira_at: '2026-06-05T22:00:00.000Z',
      },
      {
        id: 11,
        user_id: 141,
        estado: 'activa',
        tipo: 'feedback_digest',
        contexto_json: { fecha: '2026-06-05', digest_id: 2 },
        abierta_at: '2026-06-05T08:00:00.000Z',
        expira_at: '2026-06-05T22:00:00.000Z',
      },
    ],
  });

  const activa = await buscarConversacionActiva(supabaseConversaciones, 141, { fechaHoy: '2026-06-05' });
  assert(activa?.id === 11, 'Devuelve solo la conversacion activa del dia actual');
  assert(
    supabaseConversaciones.calls.some((call) =>
      call.table === 'user_conversations' &&
      call.op === 'select' &&
      !String(call.columns || '').includes('created_at')
    ),
    'No pide user_conversations.created_at porque no existe en la BD real'
  );
  assert(
    supabaseConversaciones.calls.some((call) =>
      call.table === 'user_conversations' &&
      call.op === 'update_in' &&
      call.values.includes(10) &&
      call.patch.estado === 'expirada'
    ),
    'Expira conversaciones activas de dias anteriores'
  );

  const supabaseDigest = crearSupabaseMock({
    digests: [
      {
        id: 20,
        user_id: 141,
        fecha: '2026-06-04',
        alerta_ids: [100],
        enviado: true,
        organization_id: null,
      },
      {
        id: 21,
        user_id: 141,
        fecha: '2026-06-05',
        alerta_ids: [101],
        enviado: true,
        organization_id: null,
      },
    ],
    digest_items: [
      { digest_id: 21, item_numero: 1, alerta_id: 101 },
    ],
    alertas: [
      {
        id: 101,
        titulo: 'Ayuda PAC actual',
        resumen: 'Convocatoria vigente',
        provincias: ['nacional'],
        sectores: ['agricultura'],
        subsectores: ['pac'],
        tipos_alerta: ['ayudas_subvenciones'],
        fuente: 'BOE',
        organization_id: null,
      },
    ],
  });

  const digestHoy = await cargarDigestYAlertas(supabaseDigest, 141, null, null, { fechaHoy: '2026-06-05' });
  assert(digestHoy.digest?.id === 21, 'Carga solo el digest enviado del dia actual');
  assert(digestHoy.alertasOrdenadas.length === 1 && digestHoy.alertasOrdenadas[0].id === 101, 'Ordena alertas del digest actual');
  assert(
    supabaseDigest.calls.some((call) => call.table === 'digests' && call.op === 'eq' && call.column === 'fecha' && call.value === '2026-06-05'),
    'Filtra digests por fecha de hoy'
  );

  console.log(`\nResultados miaConversationDailyReset: ${passed} aprobados, ${failed} fallidos`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
