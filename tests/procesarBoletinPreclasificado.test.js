process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
  procesarBoletinPreclasificado,
} = require('../src/modules/boletines/rutas/shared/procesarBoletinPreclasificado');
const {
  obtenerDocumentosDogvConTexto,
} = require('../src/modules/boletines/scrapers/DOGV/dogvScraper');
const {
  obtenerDocumentosDogcConTexto,
} = require('../src/modules/boletines/scrapers/DOGC/dogcScraper');
const fega = require('../src/modules/boletines/rutas/estatales/fega');

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
// Supabase en memoria (mismo patrón que rawDocuments.test.js) + soporte .single().
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
      _single: false,
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
      single() {
        this._single = true;
        return this;
      },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => {
            const data = this._exec();
            if (this._single) {
              return { data: Array.isArray(data) ? data[0] || null : data, error: null };
            }
            return { data, error: null };
          })
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

// Filtro de prueba: excluye nombramientos; incluye señales agrarias.
function esRuralRelevante(texto) {
  const t = (texto || '').toLowerCase();
  if (t.includes('nombramiento') || t.includes('nomenament')) return false;
  return t.includes('agr') || t.includes('subvenc') || t.includes('ajud') || t.includes('rural');
}

console.log('\n=== TESTS: procesarBoletinPreclasificado + scrapers pre-clasificados ===\n');

async function main() {
  // ── Helper: el flag `_relevante` decide inserción vs skipped_by_rule ──
  await test('helper registra TODO; _relevante:false -> skipped_by_rule, true -> inserted+enlazado', async () => {
    const supabase = crearSupabaseMemoria();
    const docs = [
      { titulo: 'Ayudas agrarias', url: 'u-rural', texto: 'subvenciones', _relevante: true },
      { titulo: 'Nombramiento', url: 'u-norural', texto: 'x', _relevante: false },
      { titulo: 'Sin url relevante', url: null, texto: 'ayuda', _relevante: true },
    ];

    const stats = await silenciarConsoleError(() =>
      procesarBoletinPreclasificado(supabase, docs, {
        fuente: 'TEST',
        region: 'Testland',
        contenido: (d) => d.texto,
      })
    );

    assert.strictEqual(stats.totales, 3);
    assert.strictEqual(stats.nuevas, 1);
    assert.strictEqual(stats.saltadasFiltro, 1);

    const raws = supabase._stores.raw_documents;
    assert.strictEqual(raws.length, 3, 'todos los detectados quedan registrados');

    const rural = raws.find((r) => r.url === 'u-rural');
    assert.strictEqual(rural.capture_status, 'inserted');
    assert.ok(rural.inserted_alerta_id, 'el insertado enlaza con su alerta');

    const noRural = raws.find((r) => r.url === 'u-norural');
    assert.strictEqual(noRural.capture_status, 'skipped_by_rule');
    assert.strictEqual(noRural.capture_reason, 'rural_filter_no_match');

    const sinUrl = raws.find((r) => r.titulo === 'Sin url relevante');
    assert.strictEqual(sinUrl.capture_status, 'missing_url');
  });

  await test('helper compat: documento sin `_relevante` se considera insertable', async () => {
    const supabase = crearSupabaseMemoria();
    const stats = await silenciarConsoleError(() =>
      procesarBoletinPreclasificado(supabase, [{ titulo: 'T', url: 'u', texto: 't' }], {
        fuente: 'TEST',
        region: 'R',
        contenido: (d) => d.texto,
      })
    );
    assert.strictEqual(stats.nuevas, 1);
    assert.strictEqual(stats.saltadasFiltro, 0);
    assert.strictEqual(supabase._stores.raw_documents[0].capture_status, 'inserted');
  });

  // ── DOGV: todos los detectados quedan registrados ANTES de filtrar ──
  await test('DOGV: registra todos los detectados; el descartado por filtro queda skipped_by_rule', async () => {
    const supabase = crearSupabaseMemoria();
    const docs = await obtenerDocumentosDogvConTexto('2026-06-18', esRuralRelevante, {
      obtenerDocumentosHoy: async () => [
        { id: '1', titulo: 'Ayudas a la agricultura ecológica', urlPdf: '/dogv/1.pdf' },
        { id: '2', titulo: 'Nombramiento de personal', urlPdf: '/dogv/2.pdf' },
      ],
      obtenerTextoDisposicion: async () => 'texto completo de la disposición',
    });

    assert.strictEqual(docs.length, 2, 'el scraper devuelve TODOS los detectados');
    assert.strictEqual(docs.filter((d) => d._relevante === false).length, 1);

    const stats = await silenciarConsoleError(() =>
      procesarBoletinPreclasificado(supabase, docs, {
        fuente: 'DOGV',
        region: 'Comunitat Valenciana',
        contenido: (d) => d.texto,
      })
    );

    assert.strictEqual(stats.totales, 2);
    assert.strictEqual(stats.nuevas, 1);
    assert.strictEqual(stats.saltadasFiltro, 1);

    const raws = supabase._stores.raw_documents;
    assert.strictEqual(raws.length, 2, 'ningún documento DOGV desaparece sin registro');
    const noRural = raws.find((r) => r.titulo.includes('Nombramiento'));
    assert.strictEqual(noRural.capture_status, 'skipped_by_rule');
    assert.strictEqual(noRural.capture_reason, 'rural_filter_no_match');
  });

  // ── DOGC: todos los detectados quedan registrados (incluido el que no tiene URL) ──
  await test('DOGC: registra todos los detectados antes de filtrar; sin URL -> missing_url', async () => {
    const supabase = crearSupabaseMemoria();
    const docs = await obtenerDocumentosDogcConTexto('2026-06-18', esRuralRelevante, {
      obtenerNumDogcHoy: async () => '9999',
      obtenerDocumentosDogcPorNumero: async () => [
        { titulo: 'Ajudes agràries', url: 'https://dogc/1', urlPdf: 'https://dogc/1.pdf', _urlHtml: 'https://dogc/1' },
        { titulo: 'Nomenament de personal', url: 'https://dogc/2', urlPdf: 'https://dogc/2.pdf', _urlHtml: 'https://dogc/2' },
        { titulo: 'Subvenció agrícola sense enllaç', url: '', _urlHtml: null },
      ],
      fetchTextoHtml: async () => 'x'.repeat(200),
    });

    assert.strictEqual(docs.length, 3, 'el scraper devuelve TODOS los detectados (incluido el sin URL)');

    const stats = await silenciarConsoleError(() =>
      procesarBoletinPreclasificado(supabase, docs, {
        fuente: 'DOGC',
        region: 'Catalunya',
        contenido: (d) => d.texto,
      })
    );

    assert.strictEqual(stats.totales, 3);
    assert.strictEqual(stats.nuevas, 1);
    assert.strictEqual(stats.saltadasFiltro, 1);

    const raws = supabase._stores.raw_documents;
    assert.strictEqual(raws.length, 3, 'ningún documento DOGC desaparece sin registro');

    const sinUrl = raws.find((r) => r.titulo.includes('sense enllaç'));
    assert.strictEqual(sinUrl.capture_status, 'missing_url', 'el relevante sin URL queda auditado');

    const nomenament = raws.find((r) => r.titulo.includes('Nomenament'));
    assert.strictEqual(nomenament.capture_status, 'skipped_by_rule');
  });

  // ── FEGA: la publicación detectada queda en raw_documents ──
  await test('FEGA: la publicación detectada queda en raw_documents (inserted + enlazada)', async () => {
    const supabase = crearSupabaseMemoria();
    const fichero = { ejercicio: 2024, paginaDetalle: 'https://fega/2024', urlDescarga: 'https://fega/2024.zip' };

    const r = await silenciarConsoleError(() => fega.insertarAlertaFega(supabase, fichero));
    assert.strictEqual(r.inserted, true);

    const raws = supabase._stores.raw_documents;
    assert.strictEqual(raws.length, 1, 'la publicación FEGA detectada queda registrada');
    assert.strictEqual(raws[0].fuente, 'FEGA');
    assert.strictEqual(raws[0].capture_status, 'inserted');
    assert.strictEqual(raws[0].inserted_alerta_id, r.id);
    assert.strictEqual(supabase._stores.alertas.length, 1);
  });

  await test('FEGA: publicación ya existente -> raw_document marcado duplicate, sin alerta nueva', async () => {
    const supabase = crearSupabaseMemoria();
    supabase._stores.alertas.push({ id: 555, url: 'https://fega/2023' });
    const fichero = { ejercicio: 2023, paginaDetalle: 'https://fega/2023', urlDescarga: 'https://fega/2023.zip' };

    const r = await silenciarConsoleError(() => fega.insertarAlertaFega(supabase, fichero));
    assert.strictEqual(r.inserted, false);
    assert.strictEqual(r.id, 555);

    const raws = supabase._stores.raw_documents;
    assert.strictEqual(raws.length, 1, 'la publicación duplicada también queda registrada');
    assert.strictEqual(raws[0].capture_status, 'duplicate');
    assert.strictEqual(supabase._stores.alertas.length, 1, 'no se crea alerta nueva');
  });

  console.log(`\nResultados procesarBoletinPreclasificado: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
