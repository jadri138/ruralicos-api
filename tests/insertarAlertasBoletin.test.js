const assert = require('assert');
const {
  insertarAlertasBoletin,
  crearContenidoBoletin,
} = require('../src/modules/boletines/rutas/shared/insertarAlertasBoletin');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err.message);
  }
}

// thenable que ademas soporta .select(): replica `insert(rows).select('id, url')`
// y `await insert(rows)` de supabase-js.
function resultadoEscritura(result) {
  return {
    select() {
      return Promise.resolve(result);
    },
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
}

function crearSupabaseFake({ existentes = [], batchInsertError = false, failedUrls = [] } = {}) {
  const existentesSet = new Set(existentes.map(String));
  const failedSet = new Set(failedUrls.map(String));
  const inserted = [];
  const rawUpdates = [];
  const calls = { selects: 0, inserts: 0, rawUpdates: 0 };
  let nextAlertaId = 1;

  function alertas() {
    return {
      select(columns) {
        assert.strictEqual(columns, 'url');
        return {
          async in(column, urls) {
            assert.strictEqual(column, 'url');
            calls.selects += 1;
            return {
              data: urls
                .filter((url) => existentesSet.has(String(url)))
                .map((url) => ({ url })),
              error: null,
            };
          },
        };
      },
      insert(rows) {
        const list = Array.isArray(rows) ? rows : [rows];
        calls.inserts += 1;
        if (batchInsertError && list.length > 1) {
          return resultadoEscritura({ data: null, error: { message: 'batch failed' } });
        }
        if (list.some((row) => failedSet.has(String(row.url)))) {
          return resultadoEscritura({ data: null, error: { message: 'single failed' } });
        }
        inserted.push(...list);
        return resultadoEscritura({
          data: list.map((row) => ({ id: nextAlertaId++, url: row.url })),
          error: null,
        });
      },
    };
  }

  function rawDocuments() {
    return {
      // Lectura usada por la salvaguarda de marcarRawDocumentSaltado(duplicate):
      // estos raw son frescos (nunca insertados) -> inserted_alerta_id null, así que
      // el guard procede a marcarlos duplicate como espera el test.
      select() {
        return {
          eq() {
            return {
              async limit() {
                return { data: [{ inserted_alerta_id: null }], error: null };
              },
            };
          },
        };
      },
      update(patch) {
        return {
          async eq(column, value) {
            assert.strictEqual(column, 'id');
            calls.rawUpdates += 1;
            rawUpdates.push({ id: value, patch });
            return { data: null, error: null };
          },
        };
      },
    };
  }

  return {
    inserted,
    rawUpdates,
    calls,
    from(table) {
      if (table === 'alertas') return alertas();
      if (table === 'raw_documents') return rawDocuments();
      throw new Error(`tabla inesperada en el fake: ${table}`);
    },
  };
}

async function silenciarConsoleError(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

console.log('\n=== TESTS: insertar alertas boletin ===\n');

async function main() {
  await test('deduplica existentes y repetidas antes de insertar en lote', async () => {
    const supabase = crearSupabaseFake({ existentes: ['u-existente'] });
    const result = await insertarAlertasBoletin(supabase, [
      { url: 'u-existente', titulo: 'Existente', fecha: '2026-06-06', texto: 'A' },
      { titulo: 'Sin URL', fecha: '2026-06-06', texto: 'B' },
      { url: 'u-nueva', titulo: 'Nueva', fecha: '2026-06-06', texto: 'Texto nuevo' },
      { url: 'u-nueva', titulo: 'Nueva duplicada', fecha: '2026-06-06', texto: 'Texto repetido' },
      { url: 'u-nueva-2', titulo: 'Nueva 2', fecha: '2026-06-06', texto: 'Texto nuevo 2' },
    ], {
      fuente: 'TEST',
      region: 'Testland',
      contenido: (doc) => doc.texto,
    });

    assert.deepStrictEqual(result, { nuevas: 2, duplicadas: 2, errores: 1 });
    assert.deepStrictEqual(supabase.inserted.map((row) => row.url), ['u-nueva', 'u-nueva-2']);
    assert.strictEqual(supabase.inserted[0].contenido, 'Texto nuevo');
    assert.strictEqual(supabase.calls.selects, 1);
    assert.strictEqual(supabase.calls.inserts, 1);
    // Sin raw_document_id no se toca raw_documents (compatibilidad con scrapers actuales).
    assert.strictEqual(supabase.calls.rawUpdates, 0);
  });

  await test('recupera inserciones validas si falla el batch', async () => {
    const supabase = crearSupabaseFake({ batchInsertError: true, failedUrls: ['u-mala'] });
    const result = await silenciarConsoleError(() => insertarAlertasBoletin(supabase, [
      { url: 'u-buena', titulo: 'Buena', fecha: '2026-06-06', texto: 'A' },
      { url: 'u-mala', titulo: 'Mala', fecha: '2026-06-06', texto: 'B' },
    ], {
      fuente: 'TEST',
      region: 'Testland',
      contenido: (doc) => doc.texto,
    }));

    assert.deepStrictEqual(result, { nuevas: 1, duplicadas: 0, errores: 1 });
    assert.deepStrictEqual(supabase.inserted.map((row) => row.url), ['u-buena']);
    assert.strictEqual(supabase.calls.inserts, 3);
  });

  await test('mantiene el contenido con metadatos por defecto', () => {
    const contenido = crearContenidoBoletin({
      titulo: 'Titulo',
      texto: 'Texto base',
      organismo: 'Organismo',
      seccion: 'Seccion',
      urlPdf: 'https://example.com/doc.pdf',
    });

    assert.ok(contenido.includes('Texto base'));
    assert.ok(contenido.includes('--- metadatos ---'));
    assert.ok(contenido.includes('"organismo":"Organismo"'));
    assert.ok(contenido.includes('"urlPdf":"https://example.com/doc.pdf"'));
  });

  await test('documento sin URL con raw_document_id queda como missing_url', async () => {
    const supabase = crearSupabaseFake();
    const result = await insertarAlertasBoletin(supabase, [
      { raw_document_id: 10, titulo: 'Sin URL', fecha: '2026-06-17', texto: 'X' },
    ], { fuente: 'TEST', region: 'T', contenido: (doc) => doc.texto });

    assert.deepStrictEqual(result, { nuevas: 0, duplicadas: 0, errores: 1 });
    assert.strictEqual(supabase.inserted.length, 0);
    const upd = supabase.rawUpdates.find((u) => u.id === 10);
    assert.ok(upd, 'se actualizo el raw document');
    assert.strictEqual(upd.patch.capture_status, 'missing_url');
  });

  await test('documento duplicado en BD con raw_document_id queda como duplicate', async () => {
    const supabase = crearSupabaseFake({ existentes: ['u-dup'] });
    const result = await insertarAlertasBoletin(supabase, [
      { raw_document_id: 20, url: 'u-dup', titulo: 'Dup', fecha: '2026-06-17', texto: 'X' },
    ], { fuente: 'TEST', region: 'T', contenido: (doc) => doc.texto });

    assert.deepStrictEqual(result, { nuevas: 0, duplicadas: 1, errores: 0 });
    assert.strictEqual(supabase.inserted.length, 0);
    const upd = supabase.rawUpdates.find((u) => u.id === 20);
    assert.ok(upd);
    assert.strictEqual(upd.patch.capture_status, 'duplicate');
  });

  await test('duplicado interno marca el segundo raw como duplicate y enlaza el primero', async () => {
    const supabase = crearSupabaseFake();
    const result = await insertarAlertasBoletin(supabase, [
      { raw_document_id: 30, url: 'u-x', titulo: 'A', fecha: '2026-06-17', texto: 'A' },
      { raw_document_id: 31, url: 'u-x', titulo: 'A bis', fecha: '2026-06-17', texto: 'A' },
    ], { fuente: 'TEST', region: 'T', contenido: (doc) => doc.texto });

    assert.deepStrictEqual(result, { nuevas: 1, duplicadas: 1, errores: 0 });
    const u31 = supabase.rawUpdates.find((u) => u.id === 31);
    assert.strictEqual(u31.patch.capture_status, 'duplicate');
    const u30 = supabase.rawUpdates.find((u) => u.id === 30);
    assert.strictEqual(u30.patch.capture_status, 'inserted');
  });

  await test('documento insertado enlaza inserted_alerta_id con la alerta creada', async () => {
    const supabase = crearSupabaseFake();
    const result = await insertarAlertasBoletin(supabase, [
      { raw_document_id: 40, url: 'u-ok', titulo: 'OK', fecha: '2026-06-17', texto: 'T' },
    ], { fuente: 'TEST', region: 'T', contenido: (doc) => doc.texto });

    assert.deepStrictEqual(result, { nuevas: 1, duplicadas: 0, errores: 0 });
    assert.strictEqual(supabase.inserted[0].url, 'u-ok');
    const upd = supabase.rawUpdates.find((u) => u.id === 40);
    assert.ok(upd);
    assert.strictEqual(upd.patch.capture_status, 'inserted');
    assert.strictEqual(typeof upd.patch.inserted_alerta_id, 'number');
  });

  console.log(`\nResultados insertarAlertasBoletin: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
