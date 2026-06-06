const assert = require('assert');
const {
  insertarAlertasBoletin,
  crearContenidoBoletin,
} = require('../src/routes/boletines/shared/insertarAlertasBoletin');

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

function crearSupabaseFake({ existentes = [], batchInsertError = false, failedUrls = [] } = {}) {
  const existentesSet = new Set(existentes.map(String));
  const failedSet = new Set(failedUrls.map(String));
  const inserted = [];
  const calls = { selects: 0, inserts: 0 };

  return {
    inserted,
    calls,
    from(table) {
      assert.strictEqual(table, 'alertas');
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
        async insert(rows) {
          const list = Array.isArray(rows) ? rows : [rows];
          calls.inserts += 1;
          if (batchInsertError && list.length > 1) {
            return { error: { message: 'batch failed' } };
          }
          if (list.some((row) => failedSet.has(String(row.url)))) {
            return { error: { message: 'single failed' } };
          }
          inserted.push(...list);
          return { data: null, error: null };
        },
      };
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

  console.log(`\nResultados insertarAlertasBoletin: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
