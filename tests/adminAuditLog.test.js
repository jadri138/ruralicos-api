const {
  construirAdminAuditRow,
  registrarAdminAuditLog,
  getAdminActor,
} = require('../src/modules/admin/auditLog');

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
    admin: { sub: 7, username: 'admin' },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'test-agent' },
  };
}

function crearSupabaseAuditMock({ missing = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        insert(row) {
          calls.push({ table, row });
          return this;
        },
        select() { return this; },
        single() {
          if (missing) return Promise.resolve({ data: null, error: { code: '42P01', message: 'missing table' } });
          return Promise.resolve({ data: { id: 22 }, error: null });
        },
      };
    },
  };
}

console.log('\n=== TESTS: admin audit log ===\n');

(async () => {
  const actor = getAdminActor(crearReqMock());
  assert(actor.admin_user_id === 7, 'Extrae admin_user_id desde JWT');
  assert(actor.username === 'admin', 'Extrae username desde JWT');

  const row = construirAdminAuditRow({
    req: crearReqMock(),
    action: 'mia_agent_case.reply',
    resourceType: 'mia_agent_case',
    resourceId: 55,
    organizationId: 12,
    metadata: { sent: true },
  });

  assert(row.admin_user_id === 7, 'Construye fila con admin_user_id');
  assert(row.organization_id === 12, 'Construye fila con organization_id');
  assert(row.action === 'mia_agent_case.reply', 'Conserva accion auditada');
  assert(row.resource_id === '55', 'Normaliza resource_id a texto');
  assert(Boolean(row.ip_hash), 'Hash de IP sin guardar IP en claro');

  const supabase = crearSupabaseAuditMock();
  const result = await registrarAdminAuditLog(supabase, {
    req: crearReqMock(),
    action: 'user.update',
    resourceType: 'user',
    resourceId: 141,
    organizationId: 12,
  });
  assert(result.ok === true && result.inserted === true && result.id === 22, 'Inserta auditoria cuando la tabla existe');

  const missing = await registrarAdminAuditLog(crearSupabaseAuditMock({ missing: true }), {
    req: crearReqMock(),
    action: 'user.update',
    resourceType: 'user',
    resourceId: 141,
  });
  assert(missing.ok === true && missing.available === false, 'No rompe si admin_audit_log no existe aun');

  console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
  process.exit(failed > 0 ? 1 : 0);
})();
