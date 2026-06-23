process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { esTextoErrorPortal } = require('../src/modules/boletines/scrapers/shared/portalErrorText');
const {
  obtenerDocumentosBopaConTexto,
  obtenerTextoDocumento,
} = require('../src/modules/boletines/scrapers/BOPA/bopaScraper');
const {
  procesarBoletinPreclasificado,
} = require('../src/modules/boletines/rutas/shared/procesarBoletinPreclasificado');

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

async function silenciarConsole(fn) {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

// Texto EXACTO observado en alertas BOPA del 2026-06-21.
const BOPA_ERROR = 'No se ha podido obtener la disposición solicitada. Inténtelo más tarde o vuelva a realizar la búsqueda';

// Filtro rural mínimo de prueba (excluye nombramientos, incluye señales agrarias).
function esRuralRelevante(texto) {
  const t = (texto || '').toLowerCase();
  if (t.includes('nombramiento')) return false;
  return t.includes('agr') || t.includes('subvenc') || t.includes('regad') || t.includes('ganad');
}

// ── Mock de Supabase en memoria (mismo patrón que procesarBoletinPreclasificado.test.js) ──
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
      _mode: 'select', _cols: '*', _rows: null, _patch: null, _conflict: [], _ignoreDup: false,
      _filters: [], _limit: null, _single: false,
      select(cols) { this._cols = cols; return this; },
      insert(rows) { this._mode = 'insert'; this._rows = Array.isArray(rows) ? rows : [rows]; return this; },
      upsert(rows, opts = {}) {
        this._mode = 'upsert'; this._rows = Array.isArray(rows) ? rows : [rows];
        this._conflict = (opts.onConflict || '').split(',').map((s) => s.trim()).filter(Boolean);
        this._ignoreDup = !!opts.ignoreDuplicates; return this;
      },
      update(patch) { this._mode = 'update'; this._patch = patch; return this; },
      eq(col, val) { this._filters.push(['eq', col, val]); return this; },
      in(col, vals) { this._filters.push(['in', col, vals]); return this; },
      limit(n) { this._limit = n; return this; },
      single() { this._single = true; return this; },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => {
            const data = this._exec();
            if (this._single) return { data: Array.isArray(data) ? data[0] || null : data, error: null };
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
          for (const r of this._rows) { const row = { id: ++seq[table], ...r }; store.push(row); out.push(row); }
          return project(out, this._cols);
        }
        if (this._mode === 'upsert') {
          const out = [];
          for (const r of this._rows) {
            const conflictNull = this._conflict.some((c) => r[c] === null || r[c] === undefined);
            const dup = !conflictNull && store.find((s) => this._conflict.every((c) => s[c] === r[c]));
            if (dup) { if (this._ignoreDup) continue; Object.assign(dup, r); out.push(dup); continue; }
            const row = { id: ++seq[table], ...r }; store.push(row); out.push(row);
          }
          return project(out, this._cols);
        }
        if (this._mode === 'update') {
          const out = [];
          for (const row of store) { if (this._matches(row)) { Object.assign(row, this._patch); out.push(row); } }
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

console.log('\n=== TESTS: BOPA evidence guard (portal error) ===\n');

async function main() {
  await test('detecta el texto EXACTO de error del portal BOPA', () => {
    assert.strictEqual(esTextoErrorPortal(BOPA_ERROR), true);
  });

  await test('no marca como error una disposición oficial real', () => {
    assert.strictEqual(
      esTextoErrorPortal('Resolución por la que se convocan ayudas para explotaciones agrarias de regadío.'),
      false
    );
  });

  await test('obtenerTextoDocumento: HTML con error del portal -> evidencia=false (portal_error)', async () => {
    const r = await obtenerTextoDocumento('https://bopa/err', {
      getHtml: async () => `<html><body><div id="main-content">${BOPA_ERROR}</div></body></html>`,
      obtenerTextoPdfAlternativo: async () => null,
    });
    assert.strictEqual(r.evidencia, false);
    assert.strictEqual(r.motivo, 'portal_error');
    assert.strictEqual(r.texto, '');
    assert.ok(esTextoErrorPortal(r.texto_original), 'conserva el texto del portal para auditoría');
  });

  await test('obtenerTextoDocumento: si hay PDF oficial alternativo, lo usa (evidencia=true)', async () => {
    const r = await obtenerTextoDocumento('https://bopa/err', {
      getHtml: async () => `<html><body><div id="main-content">${BOPA_ERROR}</div></body></html>`,
      obtenerTextoPdfAlternativo: async () => ({
        texto: 'Resolución por la que se convocan ayudas para modernización de explotaciones agrarias de regadío en Asturias con plazo de solicitud.',
        url: 'https://bopa/err.pdf',
      }),
    });
    assert.strictEqual(r.evidencia, true);
    assert.ok(r.texto.includes('ayudas'));
    assert.strictEqual(r.urlPdf, 'https://bopa/err.pdf');
  });

  await test('obtenerTextoDocumento: HTML oficial válido -> evidencia=true', async () => {
    const oficial = 'Resolución por la que se aprueban las bases reguladoras de ayudas a explotaciones agrarias de regadío en Asturias.';
    const r = await obtenerTextoDocumento('https://bopa/ok', {
      getHtml: async () => `<html><body><div id="main-content">${oficial}</div></body></html>`,
    });
    assert.strictEqual(r.evidencia, true);
    assert.strictEqual(r.texto, oficial);
  });

  await test('obtenerDocumentosBopaConTexto: el doc con error se marca needs_evidence y no arrastra boilerplate', async () => {
    const docs = await silenciarConsole(() =>
      obtenerDocumentosBopaConTexto('2026-06-21', esRuralRelevante, {
        obtenerBoletinObjetivo: async () => ({ fecha: '2026-06-21', url: 'sumario' }),
        obtenerDocumentosSumario: async () => ([
          { titulo: 'Ayudas agrarias de regadío en Asturias', url: 'https://bopa/ok', fecha: '2026-06-21' },
          { titulo: 'Subvenciones para ganadería', url: 'https://bopa/err', fecha: '2026-06-21' },
          { titulo: 'Nombramiento de personal', url: 'https://bopa/x', fecha: '2026-06-21' },
        ]),
        obtenerTextoDocumento: async (url) => (url.endsWith('/ok')
          ? { texto: 'Resolución de ayudas para explotaciones agrarias de regadío en Asturias con plazo de solicitud.', evidencia: true }
          : { texto: '', evidencia: false, motivo: 'portal_error', texto_original: BOPA_ERROR }),
      })
    );

    const ok = docs.find((d) => d.url === 'https://bopa/ok');
    assert.strictEqual(ok._relevante, true);
    assert.ok(!ok._estado_ia, 'el doc válido no se bloquea');
    assert.ok(ok.texto.includes('ayudas'));

    const err = docs.find((d) => d.url === 'https://bopa/err');
    assert.strictEqual(err._relevante, true);
    assert.strictEqual(err._estado_ia, 'needs_evidence');
    assert.strictEqual(err.texto, '', 'no pasa el boilerplate como contenido');
    assert.strictEqual(err.texto_raw, BOPA_ERROR, 'conserva el error para el raw_document');

    const nom = docs.find((d) => d.url === 'https://bopa/x');
    assert.strictEqual(nom._relevante, false);
  });

  await test('pipeline: la alerta con error entra como needs_evidence y el raw_document queda guardado', async () => {
    const supabase = crearSupabaseMemoria();
    const docs = await silenciarConsole(() =>
      obtenerDocumentosBopaConTexto('2026-06-21', esRuralRelevante, {
        obtenerBoletinObjetivo: async () => ({ fecha: '2026-06-21', url: 'sumario' }),
        obtenerDocumentosSumario: async () => ([
          { titulo: 'Subvenciones agrarias para ganadería', url: 'https://bopa/err', fecha: '2026-06-21' },
        ]),
        obtenerTextoDocumento: async () => ({ texto: '', evidencia: false, motivo: 'portal_error', texto_original: BOPA_ERROR }),
      })
    );

    const stats = await silenciarConsole(() =>
      procesarBoletinPreclasificado(supabase, docs, {
        fuente: 'BOPA',
        region: 'Asturias',
        contenido: (d) => d.texto,
      })
    );

    assert.strictEqual(stats.nuevas, 1);

    const alerta = supabase._stores.alertas[0];
    assert.strictEqual(alerta.estado_ia, 'needs_evidence', 'NO llega como pendiente_clasificar/listo');
    assert.strictEqual(alerta.contenido, '', 'el contenido no arrastra el boilerplate');

    const raw = supabase._stores.raw_documents[0];
    assert.strictEqual(raw.capture_status, 'inserted', 'el raw_document se guarda igualmente');
    assert.ok(esTextoErrorPortal(raw.texto_raw), 'el raw_document conserva el texto de error para auditoría');
  });

  console.log(`\nResultados bopaEvidence: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
