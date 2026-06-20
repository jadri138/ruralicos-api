const assert = require('assert');
const {
  construirFactSheetAlertaSync,
} = require('../src/modules/alertas/intelligence/factSheetBuilder');
const {
  construirFactSheetRow,
  guardarFactSheetShadow,
  cargarFactSheetActual,
} = require('../src/modules/alertas/intelligence/factSheetStore');

let passed = 0;
let failed = 0;

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`OK: ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`FAIL: ${name}`);
      console.error(err.message);
    });
}

function alerta() {
  return {
    id: 77,
    organization_id: 12,
    titulo: 'Convocatoria de ayudas para explotaciones agrarias en Huesca',
    url: 'https://example.com/77',
    resumen_final: 'FICHA_IA\nTIPO: ayudas_subvenciones\nRESUMEN_DIGEST: Convocatoria de ayudas para explotaciones agrarias.\nBENEFICIARIOS: explotaciones agrarias\nPLAZO: 30 dias\nACCION: presentar solicitud.',
    contenido: 'Convocatoria de ayudas para explotaciones agrarias de Huesca. Beneficiarios: explotaciones agrarias. Plazo: 30 dias.',
    provincias: ['Huesca'],
    sectores: ['agricultura'],
    subsectores: ['cereal'],
    tipos_alerta: ['ayudas_subvenciones'],
  };
}

function fakeSupabase({ error = null, rows = [] } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push({ op: 'from', table });
      return {
        select(columns) {
          calls.push({ op: 'select', table, columns });
          return this;
        },
        eq(column, value) {
          calls.push({ op: 'eq', table, column, value });
          return this;
        },
        order(column, options) {
          calls.push({ op: 'order', table, column, options });
          return this;
        },
        limit(value) {
          calls.push({ op: 'limit', table, value });
          if (error) return Promise.resolve({ data: null, error });
          return Promise.resolve({ data: rows, error: null });
        },
        upsert(row, options) {
          calls.push({ op: 'upsert', table, row, options });
          if (error) return Promise.resolve({ data: null, error });
          return Promise.resolve({ data: [row], error: null });
        },
      };
    },
  };
}

console.log('\n=== TESTS: fact sheet store ===\n');

test('construye fila persistible con auditoria shadow', () => {
  const factSheet = construirFactSheetAlertaSync(alerta());
  const row = construirFactSheetRow({
    factSheet,
    organizationId: 12,
    shadowDecision: { current: 'include', future: factSheet.status },
  });

  assert.strictEqual(row.alerta_id, 77);
  assert.strictEqual(row.organization_id, 12);
  assert.strictEqual(row.status, factSheet.status);
  assert.strictEqual(row.fact_sheet.alerta_id, 77);
  assert.strictEqual(row.shadow_decision.current, 'include');
  assert(Array.isArray(row.flags));
  assert(Array.isArray(row.reasons));
});

test('guarda con upsert por alerta y versiones', async () => {
  const factSheet = construirFactSheetAlertaSync(alerta());
  const supabase = fakeSupabase();
  const result = await guardarFactSheetShadow(supabase, {
    factSheet,
    organizationId: 12,
    shadowDecision: { current: 'include', future: factSheet.status },
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.stored, true);
  const upsert = supabase.calls.find((call) => call.op === 'upsert');
  assert(upsert);
  assert.strictEqual(upsert.table, 'alert_fact_sheets');
  assert.strictEqual(upsert.options.onConflict, 'alerta_id,schema_version,builder_version');
});

test('degrada si la tabla no existe', async () => {
  const factSheet = construirFactSheetAlertaSync(alerta());
  const result = await guardarFactSheetShadow(fakeSupabase({
    error: { code: '42P01', message: 'missing table' },
  }), { factSheet });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.stored, false);
  assert.strictEqual(result.reason, 'alert_fact_sheets_no_disponible');
});

test('rechaza entrada invalida sin escribir', async () => {
  const result = await guardarFactSheetShadow(fakeSupabase(), {});

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'invalid_fact_sheet_store_input');
});

test('carga fact sheet actual si existe', async () => {
  const factSheet = construirFactSheetAlertaSync(alerta());
  const supabase = fakeSupabase({ rows: [{ fact_sheet: factSheet }] });
  const loaded = await cargarFactSheetActual(supabase, { alertaId: 77 });

  assert.strictEqual(loaded.alerta_id, 77);
  assert(supabase.calls.some((call) => call.op === 'eq' && call.column === 'alerta_id' && call.value === 77));
});

process.on('beforeExit', () => {
  console.log(`\nResultados factSheetStore: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exitCode = 1;
});

