const assert = require('assert');
const {
  procesarConFiltroRural,
} = require('../src/modules/boletines/rutas/shared/procesarConFiltroRural');
const {
  insertarAlertasBoletin,
} = require('../src/modules/boletines/rutas/shared/insertarAlertasBoletin');
const {
  registrarRawDocuments,
  marcarRawDocumentSaltado,
} = require('../src/modules/boletines/rawDocuments/rawDocuments.service');

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

async function silenciarConsoleError(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

// ─────────────────────────────────────────────
// Supabase en memoria (mismo patrón que rawDocuments.test.js): soporta
// select/insert/upsert/update con eq/in/limit y la cadena insert(...).select().
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
              if (this._ignoreDup) continue;
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

// Filtro rural de prueba: excluye 'ayuntamiento'; incluye señales rurales.
function esRuralRelevante(texto) {
  const t = (texto || '').toLowerCase();
  if (t.includes('ayuntamiento')) return false;
  return t.includes('agr') || t.includes('subvenc') || t.includes('rural');
}

console.log('\n=== TESTS: procesarConFiltroRural (captura bruta bloque) ===\n');

async function main() {
  await test('lote mixto: detected -> inserted/skipped_by_rule/duplicate/missing_url', async () => {
    const supabase = crearSupabaseMemoria();
    // Pre-sembrar una alerta existente para forzar el duplicado por URL.
    supabase._stores.alertas.push({ id: 999, url: 'u-dup' });

    const docs = [
      { titulo: 'Ayudas agricultura', url: 'u-rural', texto: 'subvenciones agrícolas', seccion: '', organismo: '' },
      { titulo: 'Pleno municipal', url: 'u-noural', texto: 'sesión del ayuntamiento', seccion: '', organismo: '' },
      { titulo: 'Subvención agraria', url: 'u-dup', texto: 'subvención agraria', seccion: '', organismo: '' },
      { titulo: 'Sin url', url: null, texto: 'ayuda agrícola', seccion: '', organismo: '' },
    ];

    const stats = await silenciarConsoleError(() =>
      procesarConFiltroRural(supabase, docs, {
        fuente: 'TEST',
        region: 'Testland',
        esRuralRelevante,
        contenido: (doc) => doc.texto,
      })
    );

    assert.strictEqual(stats.totales, 4);
    assert.strictEqual(stats.nuevas, 1);
    assert.strictEqual(stats.duplicadas, 1);
    assert.strictEqual(stats.errores, 1); // el doc sin url
    assert.strictEqual(stats.saltadasFiltro, 1);

    const raws = supabase._stores.raw_documents;
    assert.strictEqual(raws.length, 4, 'todos los documentos quedan registrados (detected)');

    const rural = raws.find((r) => r.url === 'u-rural');
    assert.strictEqual(rural.capture_status, 'inserted');
    assert.ok(rural.inserted_alerta_id, 'el insertado enlaza con su alerta');

    const noRural = raws.find((r) => r.url === 'u-noural');
    assert.strictEqual(noRural.capture_status, 'skipped_by_rule');
    assert.strictEqual(noRural.capture_reason, 'rural_filter_no_match');

    const dup = raws.find((r) => r.url === 'u-dup');
    assert.strictEqual(dup.capture_status, 'duplicate');

    const sinUrl = raws.find((r) => r.titulo === 'Sin url');
    assert.strictEqual(sinUrl.capture_status, 'missing_url');

    assert.strictEqual(supabase._stores.alertas.length, 2, 'solo se inserta 1 alerta nueva');
  });

  await test('sin PDF (BOA/DOE): registrado y marcado skipped_by_rule / sin_pdf', async () => {
    const supabase = crearSupabaseMemoria();
    const docsSinPdf = [{ titulo: null, url: 'u-nopdf', fecha: '2026-06-18' }];

    const conRaw = await registrarRawDocuments(supabase, docsSinPdf, {
      fuente: 'BOA',
      region: 'Aragón',
    });
    for (const d of conRaw) {
      await marcarRawDocumentSaltado(supabase, d.raw_document_id, 'sin_pdf');
    }

    const raw = supabase._stores.raw_documents.find((r) => r.url === 'u-nopdf');
    assert.ok(raw, 'el documento sin PDF queda registrado');
    assert.strictEqual(raw.capture_status, 'skipped_by_rule');
    assert.strictEqual(raw.capture_reason, 'sin_pdf');
  });

  await test('insertarAlertasBoletin sin raw_document_id no toca raw_documents', async () => {
    const supabase = crearSupabaseMemoria();
    const r = await insertarAlertasBoletin(
      supabase,
      [{ url: 'x', titulo: 'T', fecha: '2026-06-18', texto: 't' }],
      { fuente: 'X', region: 'R', contenido: (d) => d.texto }
    );
    assert.deepStrictEqual(r, { nuevas: 1, duplicadas: 0, errores: 0 });
    assert.strictEqual(supabase._stores.raw_documents.length, 0, 'compatibilidad: no escribe en raw_documents');
    assert.strictEqual(supabase._stores.alertas.length, 1);
  });

  console.log(`\nResultados procesarConFiltroRural: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
