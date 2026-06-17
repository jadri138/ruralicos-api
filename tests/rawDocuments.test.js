const assert = require('assert');
const {
  hashTexto,
  hashUrl,
  normalizarRawDocument,
  registrarRawDocuments,
} = require('../src/modules/boletines/rawDocuments/rawDocuments.service');
const boja = require('../src/modules/boletines/rutas/boja');
const boe = require('../src/modules/boletines/rutas/boe');

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

// ─────────────────────────────────────────────
// Supabase en memoria: soporta select/insert/upsert/update con eq/in/limit y la
// cadena insert(...).select(). Suficiente para raw_documents + alertas.
// ─────────────────────────────────────────────
function project(rows, cols) {
  if (!cols || cols === '*') return rows.map((r) => ({ ...r }));
  const fields = cols.split(',').map((s) => s.trim());
  return rows.map((r) => {
    const o = {};
    for (const f of fields) o[f] = r[f];
    return o;
  });
}

function crearSupabaseMemoria() {
  const stores = { raw_documents: [], alertas: [] };
  const seq = {};

  function from(table) {
    const store = stores[table] || (stores[table] = []);
    seq[table] = seq[table] || 0;

    const q = {
      _mode: 'select',
      _cols: '*',
      _rows: null,
      _patch: null,
      _conflict: [],
      _ignoreDup: false,
      _filters: [],
      _limit: null,
      select(cols) {
        this._cols = cols;
        return this;
      },
      insert(rows) {
        this._mode = 'insert';
        this._rows = Array.isArray(rows) ? rows : [rows];
        return this;
      },
      upsert(rows, opts = {}) {
        this._mode = 'upsert';
        this._rows = Array.isArray(rows) ? rows : [rows];
        this._conflict = (opts.onConflict || '').split(',').map((s) => s.trim()).filter(Boolean);
        this._ignoreDup = !!opts.ignoreDuplicates;
        return this;
      },
      update(patch) {
        this._mode = 'update';
        this._patch = patch;
        return this;
      },
      eq(col, val) {
        this._filters.push(['eq', col, val]);
        return this;
      },
      in(col, vals) {
        this._filters.push(['in', col, vals]);
        return this;
      },
      limit(n) {
        this._limit = n;
        return this;
      },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => ({ data: this._exec(), error: null }))
          .catch((e) => ({ data: null, error: { message: e.message } }))
          .then(resolve, reject);
      },
      _matches(row) {
        return this._filters.every(([op, col, val]) => {
          if (op === 'eq') return row[col] === val;
          if (op === 'in') return val.map(String).includes(String(row[col]));
          return true;
        });
      },
      _exec() {
        if (this._mode === 'insert') {
          const out = [];
          for (const r of this._rows) {
            const row = { id: ++seq[table], ...r };
            store.push(row);
            out.push(row);
          }
          return project(out, this._cols);
        }
        if (this._mode === 'upsert') {
          const out = [];
          for (const r of this._rows) {
            const conflictNull = this._conflict.some((c) => r[c] === null || r[c] === undefined);
            const dup = !conflictNull && store.find((s) => this._conflict.every((c) => s[c] === r[c]));
            if (dup) {
              if (this._ignoreDup) continue; // omitido, no se devuelve
              Object.assign(dup, r);
              out.push(dup);
              continue;
            }
            const row = { id: ++seq[table], ...r };
            store.push(row);
            out.push(row);
          }
          return project(out, this._cols);
        }
        if (this._mode === 'update') {
          const out = [];
          for (const row of store) {
            if (this._matches(row)) {
              Object.assign(row, this._patch);
              out.push(row);
            }
          }
          return project(out, this._cols);
        }
        let rows = store.filter((r) => this._matches(r));
        if (this._limit != null) rows = rows.slice(0, this._limit);
        return project(rows, this._cols);
      },
    };
    return q;
  }

  return { from, _stores: stores };
}

console.log('\n=== TESTS: raw_documents (captura bruta) ===\n');

async function main() {
  // ── Hashing ──────────────────────────────────
  await test('hashTexto normaliza espacios y mayusculas; vacio -> null', () => {
    assert.strictEqual(hashTexto('Hola   Mundo'), hashTexto('hola mundo'));
    assert.strictEqual(hashTexto(''), null);
    assert.strictEqual(hashTexto(null), null);
    assert.notStrictEqual(hashTexto('a'), hashTexto('b'));
  });

  await test('hashUrl respeta mayusculas de la ruta; solo trim/limpieza', () => {
    assert.notStrictEqual(hashUrl('https://x/AbC'), hashUrl('https://x/abc'));
    assert.strictEqual(hashUrl('  https://x/a  '), hashUrl('https://x/a'));
    assert.strictEqual(hashUrl(''), null);
    assert.strictEqual(hashUrl(undefined), null);
  });

  await test('normalizarRawDocument mapea convenciones y calcula huellas', () => {
    const fila = normalizarRawDocument(
      { titulo: 'T', urlHtml: 'https://h', urlPdf: 'https://p', texto: 'cuerpo', organismo: 'O', idOficial: 'X1' },
      { fuente: 'BOJA', region: 'Andalucía' }
    );
    assert.strictEqual(fila.fuente, 'BOJA');
    assert.strictEqual(fila.region, 'Andalucía');
    assert.strictEqual(fila.url, 'https://h'); // sin doc.url -> primer fallback urlHtml
    assert.strictEqual(fila.url_html, 'https://h');
    assert.strictEqual(fila.url_pdf, 'https://p');
    assert.strictEqual(fila.id_oficial, 'X1');
    assert.strictEqual(fila.capture_status, 'detected');
    assert.ok(fila.url_hash);
    assert.ok(fila.contenido_hash);
  });

  // ── registrarRawDocuments: idempotente con URL, multiple sin URL ──
  await test('registrarRawDocuments es idempotente por (fuente,url_hash) y nunca pierde docs sin URL', async () => {
    const supabase = crearSupabaseMemoria();
    const docs = [
      { titulo: 'Con url', url: 'https://boja/1', texto: 't' },
      { titulo: 'Sin url', texto: 'sin url' },
    ];

    const r1 = await registrarRawDocuments(supabase, docs, { fuente: 'BOJA', region: 'A' });
    assert.strictEqual(r1.length, 2);
    assert.ok(r1[0].raw_document_id);
    assert.ok(r1[1].raw_document_id, 'el doc sin URL tambien se registra');
    assert.strictEqual(supabase._stores.raw_documents.length, 2);

    const r2 = await registrarRawDocuments(supabase, docs, { fuente: 'BOJA', region: 'A' });
    // El doc con URL reutiliza la fila existente (no duplica).
    assert.strictEqual(r2[0].raw_document_id, r1[0].raw_document_id);
    // El doc sin URL (url_hash NULL) se vuelve a insertar -> +1 fila.
    assert.strictEqual(supabase._stores.raw_documents.length, 3);
  });

  // ── Escenario 2: BOJA descarta por filtro -> skipped_by_rule ──
  await test('BOJA registra todo: insertado enlazado, descartado como skipped_by_rule', async () => {
    const supabase = crearSupabaseMemoria();
    const docs = [
      {
        titulo: 'Ayudas a la agricultura',
        url: 'https://boja/rural',
        texto: 'bases reguladoras de subvenciones agrarias',
        seccion: 'Disposiciones',
        organismo: 'Consejería de Agricultura',
      },
      {
        titulo: 'Nombramiento de personal',
        url: 'https://boja/no-rural',
        texto: 'nombramiento de funcionario',
        seccion: 'Personal',
        organismo: 'Función Pública',
      },
    ];

    const stats = await boja.procesarDocumentosBoja(supabase, docs);
    assert.strictEqual(stats.nuevas, 1);
    assert.strictEqual(stats.saltadasFiltro, 1);

    const raws = supabase._stores.raw_documents;
    assert.strictEqual(raws.length, 2, 'todos los documentos quedan registrados');

    const rural = raws.find((r) => r.url === 'https://boja/rural');
    assert.strictEqual(rural.capture_status, 'inserted');
    assert.ok(rural.inserted_alerta_id, 'el insertado enlaza con su alerta');

    const noRural = raws.find((r) => r.url === 'https://boja/no-rural');
    assert.strictEqual(noRural.capture_status, 'skipped_by_rule');
    assert.strictEqual(noRural.capture_reason, 'rural_filter_no_match');

    assert.strictEqual(supabase._stores.alertas.length, 1);
  });

  // ── Escenario 5: BOE no pierde docs por filtro de departamento ──
  await test('extraerItemsSumario recolecta items de departamentos NO relevantes', () => {
    const sumario = {
      diario: {
        seccion: {
          departamento: [
            { '@_nombre': 'MINISTERIO DE AGRICULTURA, PESCA Y ALIMENTACIÓN', item: { titulo: 'A', url_pdf: 'https://boe/a' } },
            { '@_nombre': 'MINISTERIO DE HACIENDA', item: { titulo: 'H', url_pdf: 'https://boe/h' } },
          ],
        },
      },
    };
    const items = boe.extraerItemsSumario(sumario, '2026-06-17');
    assert.strictEqual(items.length, 2);
    assert.ok(items.find((i) => i.region.includes('HACIENDA')), 'incluye el departamento no relevante');
  });

  await test('BOE registra todos los items; departamento no relevante -> skipped_by_rule (no se pierde)', async () => {
    const supabase = crearSupabaseMemoria();
    const items = [
      { titulo: 'Orden ayudas PAC', url: 'https://boe/1', url_pdf: 'https://boe/1', url_html: null, fecha: '2026-06-17', region: 'MINISTERIO DE AGRICULTURA, PESCA Y ALIMENTACIÓN' },
      { titulo: 'Resolución tributaria', url: 'https://boe/2', url_pdf: 'https://boe/2', url_html: null, fecha: '2026-06-17', region: 'MINISTERIO DE HACIENDA' },
      { titulo: 'Anuncio agrícola solo HTML', url: 'https://boe/3', url_pdf: null, url_html: 'https://boe/3', fecha: '2026-06-17', region: 'MINISTERIO DE AGRICULTURA, PESCA Y ALIMENTACIÓN' },
    ];

    const stats = await boe.procesarItemsBoe(supabase, items, {
      fechaISO: '2026-06-17',
      fetchHtml: async () => null, // sin red
    });

    assert.strictEqual(stats.nuevas, 1);
    assert.strictEqual(stats.saltadasFiltro, 1);

    const raws = supabase._stores.raw_documents;
    assert.strictEqual(raws.length, 3, 'todos los items quedan registrados');

    const pac = raws.find((r) => r.url === 'https://boe/1');
    assert.strictEqual(pac.capture_status, 'inserted');
    assert.ok(pac.inserted_alerta_id);

    const hacienda = raws.find((r) => r.url === 'https://boe/2');
    assert.strictEqual(hacienda.capture_status, 'skipped_by_rule');
    assert.strictEqual(hacienda.capture_reason, 'departamento_no_relevante');

    const soloHtml = raws.find((r) => r.url === 'https://boe/3');
    assert.strictEqual(soloHtml.capture_status, 'skipped_by_rule');
    assert.strictEqual(soloHtml.capture_reason, 'sin_url_pdf');

    assert.strictEqual(supabase._stores.alertas.length, 1);
  });

  console.log(`\nResultados raw_documents: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
