const assert = require('assert');
const {
  TRACE_RELATION,
  crearTraceDesdeRawDocument,
  resolverDocumentTrace,
} = require('../src/modules/alertas/intelligence/documentTrace');

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

function fakeSupabase(rows = [], error = null) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push({ op: 'from', table });
      const query = {
        select(columns) {
          calls.push({ op: 'select', table, columns });
          return this;
        },
        eq(column, value) {
          calls.push({ op: 'eq', table, column, value });
          this._column = column;
          this._value = value;
          return this;
        },
        order(column, options) {
          calls.push({ op: 'order', table, column, options });
          return this;
        },
        limit(value) {
          calls.push({ op: 'limit', table, value });
          return this;
        },
        then(resolve, reject) {
          if (error) return Promise.resolve({ data: null, error }).then(resolve, reject);
          const data = rows.filter((row) => Number(row.inserted_alerta_id) === Number(this._value));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

console.log('\n=== TESTS: document trace ===\n');

test('documento encontrado devuelve resumen de trazabilidad documental', () => {
  const rawDocument = {
    id: 7,
    inserted_alerta_id: 42,
    organization_id: 3,
    url_pdf: 'https://boletin.example/doc.pdf',
    id_oficial: 'DOCM-42',
    contenido_hash: 'abc123',
    texto_raw: 'Texto oficial capturado desde el boletin con detalle suficiente para evidencia.',
  };
  const trace = crearTraceDesdeRawDocument({
    alerta: { id: 42, raw_document_id: 999, organization_id: 3 },
    rawDocument,
  });

  assert.strictEqual(trace.ok, true);
  assert.strictEqual(trace.found, true);
  assert.strictEqual(trace.status, 'linked');
  assert.strictEqual(trace.reason, 'linked');
  assert.strictEqual(trace.relation, TRACE_RELATION);
  assert.strictEqual(trace.uses_alerta_raw_document_id, false);
  assert.strictEqual(trace.raw_document_id, 7);
  assert.strictEqual(trace.source_url, 'https://boletin.example/doc.pdf');
  assert.strictEqual(trace.official_id, 'DOCM-42');
  assert.strictEqual(trace.content_hash, 'abc123');
  assert.strictEqual(trace.evidence_available, true);
  assert(trace.text_excerpt.includes('Texto oficial capturado'));
});

test('resuelve desde Supabase y elige candidato insertado mas completo', async () => {
  const supabase = fakeSupabase([
    { id: 1, inserted_alerta_id: 42, organization_id: 3, capture_status: 'inserted', url: 'u' },
    { id: 2, inserted_alerta_id: 42, organization_id: 3, capture_status: 'inserted', texto_raw: 'texto', url_pdf: 'pdf' },
    { id: 3, inserted_alerta_id: 77, organization_id: 3, capture_status: 'inserted', texto_raw: 'otro' },
  ]);

  const trace = await resolverDocumentTrace(supabase, { alerta: { id: 42, organization_id: 3 } });

  assert.strictEqual(trace.ok, true);
  assert.strictEqual(trace.found, true);
  assert.strictEqual(trace.status, 'linked');
  assert.strictEqual(trace.raw_document_id, 2);
  assert.strictEqual(trace.candidates.length, 2);
  assert(trace.warnings.some((warning) => warning.code === 'multiple_raw_documents'));
  assert(
    supabase.calls.some((call) => call.op === 'eq' && call.column === 'inserted_alerta_id' && call.value === 42),
    'Debe consultar raw_documents por inserted_alerta_id'
  );
});

test('devuelve not_found cuando no hay raw_documents enlazados', async () => {
  const trace = await resolverDocumentTrace(fakeSupabase([]), { alerta: { id: 42 } });

  assert.strictEqual(trace.ok, true);
  assert.strictEqual(trace.found, false);
  assert.strictEqual(trace.status, 'not_found');
  assert.strictEqual(trace.reason, 'not_found');
  assert.strictEqual(trace.rawDocument, null);
});

test('respeta organization_id y no cruza documentos de otra organizacion', async () => {
  const trace = await resolverDocumentTrace(fakeSupabase([
    { id: 4, inserted_alerta_id: 42, organization_id: 99, capture_status: 'inserted', texto_raw: 'texto' },
  ]), { alerta: { id: 42, organization_id: 3 } });

  assert.strictEqual(trace.ok, true);
  assert.strictEqual(trace.found, false);
  assert.strictEqual(trace.status, 'organization_mismatch');
  assert.strictEqual(trace.reason, 'organization_mismatch');
  assert(trace.warnings.some((warning) => warning.code === 'organization_mismatch'));
});

test('Supabase ausente devuelve fallback seguro', async () => {
  const trace = await resolverDocumentTrace(null, { alerta: { id: 42 } });

  assert.strictEqual(trace.ok, true);
  assert.strictEqual(trace.available, false);
  assert.strictEqual(trace.found, false);
  assert.strictEqual(trace.status, 'missing_supabase_client');
});

test('degrada tabla ausente sin lanzar', async () => {
  const trace = await resolverDocumentTrace(fakeSupabase([], { code: '42P01', message: 'missing table' }), {
    alerta: { id: 42 },
  });

  assert.strictEqual(trace.ok, true);
  assert.strictEqual(trace.available, false);
  assert.strictEqual(trace.found, false);
  assert.strictEqual(trace.status, 'raw_documents_no_disponible');
});

process.on('beforeExit', () => {
  console.log(`\nResultados documentTrace: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exitCode = 1;
});
