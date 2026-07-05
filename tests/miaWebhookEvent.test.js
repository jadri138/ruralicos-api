const {
  construirWebhookEventRow,
  guardarWebhookEventSeguro,
} = require('../src/modules/mia/webhookEvent');

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

function crearReqMock() {
  return {
    path: '/webhooks/ultramsg/feedback',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'test' },
    query: { token: 'Ruralicos' },
    body: {
      event_type: 'message',
      from: '34644899647@c.us',
      body: 'Me interesa la PAC',
      id: 'wamid.TEST',
    },
  };
}

function crearSupabaseWebhookMock({ fallaExtendido = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        table,
        row: null,
        insert(row) {
          calls.push({ table, row });
          this.row = row;
          return this;
        },
        select() { return this; },
        single() {
          if (fallaExtendido && calls.length === 1 && Object.prototype.hasOwnProperty.call(this.row, 'organization_id')) {
            return Promise.resolve({ data: null, error: { code: 'PGRST204', message: 'missing column organization_id' } });
          }
          return Promise.resolve({ data: { id: calls.length }, error: null });
        },
      };
    },
  };
}

console.log('\n=== TESTS: mia webhook event ===\n');

(async () => {
  const row = construirWebhookEventRow(crearReqMock(), {
    ok: true,
    user_id: 141,
    organization_id: 12,
    mia_inbound_id: 72,
    mia_decision_id: 9,
    reason: 'feedback',
  });

  assert(row.query_json.token === '[redacted]', 'Redacta token del webhook');
  assert(row.organization_id === 12, 'Propaga organization_id si existe la columna');
  assert(row.user_id === 141, 'Propaga user_id al evento enriquecido');
  assert(row.mia_inbound_id === 72, 'Propaga mia_inbound_id');
  assert(row.mia_decision_id === 9, 'Propaga mia_decision_id');
  assert(row.from_phone === '34644899647', 'Extrae telefono normalizado');
  assert(row.text_preview === 'Me interesa la PAC', 'Guarda preview de texto');

  const supabase = crearSupabaseWebhookMock({ fallaExtendido: true });
  const id = await guardarWebhookEventSeguro(supabase, crearReqMock(), { ok: true, organization_id: 12 }, null);
  assert(id === null, 'Un error de esquema devuelve null sin lanzar');
  assert(supabase.calls.length === 1, 'Ya no reintenta con columnas legacy');

  const supabaseOk = crearSupabaseWebhookMock({ fallaExtendido: false });
  const okId = await guardarWebhookEventSeguro(supabaseOk, crearReqMock(), { ok: true, organization_id: 12 }, null);
  assert(okId === 1, 'Guarda el evento cuando la BD esta al dia');

  console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
  process.exit(failed > 0 ? 1 : 0);
})();
