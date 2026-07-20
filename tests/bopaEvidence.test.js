process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { esTextoErrorPortal } = require('../src/modules/boletines/scrapers/shared/portalErrorText');
const {
  evaluarCalidadEvidencia,
  obtenerDocumentosBopaConTexto,
  obtenerDocumentosSumario,
  obtenerTextoDocumento,
  obtenerTextoPdfUrl,
} = require('../src/modules/boletines/scrapers/BOPA/bopaScraper');
const {
  recuperarAlertasBopaSinEvidencia,
} = require('../src/modules/boletines/scrapers/BOPA/bopaEvidenceRecovery');
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
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(error.stack || error.message);
  }
}

async function silenciarConsole(fn) {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

const BOPA_ERROR = 'No se ha podido obtener la disposición solicitada. Inténtelo más tarde o vuelva a realizar la búsqueda';
const TEXTO_OFICIAL = [
  'Resolución de 25 de junio de 2026, de la Consejería de Medio Rural y Política Agraria,',
  'por la que se aprueba la convocatoria de ayudas destinadas a explotaciones ganaderas del Principado de Asturias.',
  'De conformidad con la Ley General de Subvenciones, podrán ser beneficiarias las personas titulares que cumplan los requisitos.',
  'El plazo de presentación será de veinte días naturales desde la publicación en el Boletín Oficial del Principado de Asturias.',
].join(' ');

function esRuralRelevante(texto) {
  const normalizado = String(texto || '').toLowerCase();
  if (normalizado.includes('nombramiento')) return false;
  return normalizado.includes('agr') || normalizado.includes('subvenc')
    || normalizado.includes('regad') || normalizado.includes('ganad');
}

function project(rows, cols) {
  if (!cols || cols === '*') return rows.map((row) => ({ ...row }));
  const fields = cols.split(',').map((field) => field.trim());
  return rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]])));
}

function crearSupabaseMemoria() {
  const stores = { raw_documents: [], alertas: [] };
  const seq = {};
  function from(table) {
    const store = stores[table] || (stores[table] = []);
    seq[table] = seq[table] || 0;
    const query = {
      _mode: 'select',
      _cols: '*',
      _rows: null,
      _patch: null,
      _conflict: [],
      _ignoreDup: false,
      _filters: [],
      _limit: null,
      _single: false,
      select(cols) { this._cols = cols; return this; },
      insert(rows) { this._mode = 'insert'; this._rows = Array.isArray(rows) ? rows : [rows]; return this; },
      upsert(rows, opts = {}) {
        this._mode = 'upsert';
        this._rows = Array.isArray(rows) ? rows : [rows];
        this._conflict = (opts.onConflict || '').split(',').map((value) => value.trim()).filter(Boolean);
        this._ignoreDup = Boolean(opts.ignoreDuplicates);
        return this;
      },
      update(patch) { this._mode = 'update'; this._patch = patch; return this; },
      eq(col, value) { this._filters.push(['eq', col, value]); return this; },
      in(col, values) { this._filters.push(['in', col, values]); return this; },
      limit(value) { this._limit = value; return this; },
      single() { this._single = true; return this; },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => {
            const data = this._exec();
            return { data: this._single ? data[0] || null : data, error: null };
          })
          .catch((error) => ({ data: null, error: { message: error.message } }))
          .then(resolve, reject);
      },
      _matches(row) {
        return this._filters.every(([op, col, value]) => {
          if (op === 'eq') return row[col] === value;
          if (op === 'in') return value.map(String).includes(String(row[col]));
          return true;
        });
      },
      _exec() {
        if (this._mode === 'insert') {
          return project(this._rows.map((input) => {
            const row = { id: ++seq[table], ...input };
            store.push(row);
            return row;
          }), this._cols);
        }
        if (this._mode === 'upsert') {
          const output = [];
          for (const input of this._rows) {
            const nullConflict = this._conflict.some((col) => input[col] === null || input[col] === undefined);
            const duplicate = !nullConflict
              && store.find((row) => this._conflict.every((col) => row[col] === input[col]));
            if (duplicate) {
              if (!this._ignoreDup) {
                Object.assign(duplicate, input);
                output.push(duplicate);
              }
              continue;
            }
            const row = { id: ++seq[table], ...input };
            store.push(row);
            output.push(row);
          }
          return project(output, this._cols);
        }
        if (this._mode === 'update') {
          const output = [];
          for (const row of store) {
            if (this._matches(row)) {
              Object.assign(row, this._patch);
              output.push(row);
            }
          }
          return project(output, this._cols);
        }
        let rows = store.filter((row) => this._matches(row));
        if (this._limit !== null) rows = rows.slice(0, this._limit);
        return project(rows, this._cols);
      },
    };
    return query;
  }
  return { from, _stores: stores };
}

console.log('\n=== TESTS: BOPA evidence recovery ===\n');

async function main() {
  await test('detecta el texto exacto de error del portal BOPA', () => {
    assert.strictEqual(esTextoErrorPortal(BOPA_ERROR), true);
  });

  await test('la validación acepta una disposición oficial sin aplicar relevancia rural', () => {
    const textoNoRural = TEXTO_OFICIAL.replace(/explotaciones ganaderas/, 'procedimientos administrativos');
    assert.strictEqual(evaluarCalidadEvidencia(textoNoRural).valida, true);
  });

  await test('sumario realista conserva detalle, PDF relativo e identificador oficial', async () => {
    const sumarioUrl = 'https://miprincipado.asturias.es/bopa-sumario?fecha=14-07-2026';
    const docs = await obtenerDocumentosSumario({ fecha: '2026-07-14', url: sumarioUrl }, {
      getHtml: async () => `
        <dl><dt>${TEXTO_OFICIAL} [Cód. 2026-05859]</dt><dd>
          <a title="Texto de la disposición" href="https://miprincipado.asturias.es/bopa/disposiciones?ref=2026-05859">Texto de la disposición</a>
          <a title="PDF de la disposición" href="/bopa/2026/07/14/2026-05859.pdf">PDF de la disposición</a>
        </dd></dl>`,
    });

    assert.strictEqual(docs.length, 1);
    assert.strictEqual(docs[0].url, 'https://miprincipado.asturias.es/bopa/disposiciones?ref=2026-05859');
    assert.strictEqual(docs[0].urlPdf, 'https://miprincipado.asturias.es/bopa/2026/07/14/2026-05859.pdf');
    assert.strictEqual(docs[0].idOficial, '2026-05859');
    assert.strictEqual(docs[0].metadata_json.bopa.sumario_url, sumarioUrl);
  });

  await test('HTML oficial útil produce evidencia desde html', async () => {
    const result = await obtenerTextoDocumento('https://miprincipado.asturias.es/bopa/ok', {
      getHtml: async () => `<div id="bopa-articulo">${TEXTO_OFICIAL}</div>`,
      now: () => '2026-07-20T10:00:00.000Z',
    });
    assert.strictEqual(result.evidencia, true);
    assert.strictEqual(result.fuente_evidencia, 'html');
    assert.strictEqual(result.texto, TEXTO_OFICIAL);
  });

  await test('HTML con error usa primero el PDF oficial capturado en el sumario', async () => {
    let detailPdfCalls = 0;
    const result = await obtenerTextoDocumento({
      url: 'https://miprincipado.asturias.es/bopa/error',
      urlHtml: 'https://miprincipado.asturias.es/bopa/error',
      urlPdf: 'https://miprincipado.asturias.es/bopa/2026/07/14/2026-05859.pdf',
    }, {
      getHtml: async () => `<div id="main-content">${BOPA_ERROR}</div>`,
      obtenerTextoPdfUrl: async (url) => ({ texto: TEXTO_OFICIAL, evidencia: true, url }),
      obtenerTextoPdfAlternativo: async () => { detailPdfCalls += 1; return null; },
    });

    assert.strictEqual(result.evidencia, true);
    assert.strictEqual(result.fuente_evidencia, 'summary_pdf');
    assert.strictEqual(detailPdfCalls, 0, 'la cadena se detiene al recuperar el PDF del sumario');
  });

  await test('HTML con error usa un PDF oficial encontrado en el detalle', async () => {
    const result = await obtenerTextoDocumento('https://miprincipado.asturias.es/bopa/error', {
      getHtml: async () => `<div id="main-content">${BOPA_ERROR}<a href="/bopa/detail.pdf">PDF</a></div>`,
      obtenerTextoPdfAlternativo: async () => ({ texto: TEXTO_OFICIAL, evidencia: true, url: 'https://miprincipado.asturias.es/bopa/detail.pdf' }),
    });

    assert.strictEqual(result.evidencia, true);
    assert.strictEqual(result.fuente_evidencia, 'detail_pdf');
    assert.strictEqual(result.urlPdf, 'https://miprincipado.asturias.es/bopa/detail.pdf');
  });

  await test('HTML con Cargando se rechaza como placeholder', async () => {
    const result = await obtenerTextoDocumento('https://miprincipado.asturias.es/bopa/loading', {
      getHtml: async () => '<div id="main-content">Cargando...</div>',
      obtenerTextoPdfAlternativo: async () => null,
    });
    assert.strictEqual(result.evidencia, false);
    assert.strictEqual(result.motivo, 'loading_placeholder');
  });

  await test('un PDF que contiene HTML se rechaza antes de parsearlo', async () => {
    let parseCalls = 0;
    const result = await obtenerTextoPdfUrl('https://miprincipado.asturias.es/bopa/falso.pdf', {
      fetchPdfBuffer: async () => Buffer.from('<html><body>Error</body></html>'),
      extraerTextoPdf: async () => { parseCalls += 1; return TEXTO_OFICIAL; },
    });
    assert.strictEqual(result.evidencia, false);
    assert.strictEqual(result.motivo, 'pdf_invalid');
    assert.strictEqual(parseCalls, 0);
  });

  await test('un PDF con cabecera válida pero ilegible no aporta evidencia', async () => {
    const result = await obtenerTextoPdfUrl('https://miprincipado.asturias.es/bopa/ilegible.pdf', {
      fetchPdfBuffer: async () => Buffer.from('%PDF-contenido-corrupto'),
      extraerTextoPdf: async () => { throw new Error('corrupto'); },
    });
    assert.strictEqual(result.evidencia, false);
    assert.strictEqual(result.motivo, 'pdf_ilegible');
  });

  await test('error sin enlace alternativo conserva portal_error y queda sin evidencia', async () => {
    const result = await obtenerTextoDocumento('https://miprincipado.asturias.es/bopa/error', {
      getHtml: async () => `<div id="main-content">${BOPA_ERROR}</div>`,
      obtenerTextoPdfAlternativo: async () => null,
    });
    assert.strictEqual(result.evidencia, false);
    assert.strictEqual(result.motivo, 'portal_error');
    assert.strictEqual(result.texto, '');
    assert.ok(esTextoErrorPortal(result.texto_original));
  });

  await test('documentos BOPA: boilerplate queda needs_evidence y discard no descarga', async () => {
    const downloaded = [];
    const docs = await silenciarConsole(() => obtenerDocumentosBopaConTexto('2026-07-14', esRuralRelevante, {
      sleep: async () => {},
      obtenerBoletinObjetivo: async () => ({ fecha: '2026-07-14', url: 'sumario' }),
      obtenerDocumentosSumario: async () => ([
        { titulo: 'Ayudas agrarias de regadío en Asturias', url: 'https://bopa/ok', fecha: '2026-07-14' },
        { titulo: 'Subvenciones para ganadería', url: 'https://bopa/error', fecha: '2026-07-14' },
        { titulo: 'Nombramiento de personal', url: 'https://bopa/discard', fecha: '2026-07-14' },
      ]),
      obtenerTextoDocumento: async (doc) => {
        downloaded.push(doc.url);
        return doc.url.endsWith('/ok')
          ? { texto: TEXTO_OFICIAL, evidencia: true, fuente_evidencia: 'html', attempts: [], recovered_at: '2026-07-20T10:00:00.000Z' }
          : { texto: '', evidencia: false, motivo: 'portal_error', texto_original: BOPA_ERROR, attempts: [], attempted_at: '2026-07-20T10:00:00.000Z' };
      },
    }));

    assert.deepStrictEqual(downloaded, ['https://bopa/ok', 'https://bopa/error']);
    const ok = docs.find((doc) => doc.url.endsWith('/ok'));
    assert.strictEqual(ok.metadata_json.evidence.status, 'recovered');
    assert.strictEqual(ok.metadata_json.evidence.source, 'html');
    const error = docs.find((doc) => doc.url.endsWith('/error'));
    assert.strictEqual(error._estado_ia, 'needs_evidence');
    assert.strictEqual(error.texto, '');
    assert.strictEqual(error.texto_raw, BOPA_ERROR);
    assert.strictEqual(error.metadata_json.evidence.status, 'missing');
    assert.strictEqual(docs.find((doc) => doc.url.endsWith('/discard'))._relevante, false);
  });

  await test('pipeline guarda auditoría y nunca convierte boilerplate en contenido o listo', async () => {
    const supabase = crearSupabaseMemoria();
    const docs = await silenciarConsole(() => obtenerDocumentosBopaConTexto('2026-07-14', esRuralRelevante, {
      sleep: async () => {},
      obtenerBoletinObjetivo: async () => ({ fecha: '2026-07-14', url: 'sumario' }),
      obtenerDocumentosSumario: async () => ([
        { titulo: 'Subvenciones agrarias para ganadería', url: 'https://bopa/error', fecha: '2026-07-14' },
      ]),
      obtenerTextoDocumento: async () => ({
        texto: '', evidencia: false, motivo: 'portal_error', texto_original: BOPA_ERROR,
        attempts: [{ source: 'html', status: 'failed', reason: 'portal_error' }],
        attempted_at: '2026-07-20T10:00:00.000Z',
      }),
    }));
    const stats = await silenciarConsole(() => procesarBoletinPreclasificado(supabase, docs, {
      fuente: 'BOPA',
      region: 'Asturias',
      contenido: (doc) => doc.texto,
    }));

    assert.strictEqual(stats.nuevas, 1);
    const alerta = supabase._stores.alertas[0];
    assert.strictEqual(alerta.estado_ia, 'needs_evidence');
    assert.notStrictEqual(alerta.estado_ia, 'listo');
    assert.strictEqual(alerta.contenido, '');
    const raw = supabase._stores.raw_documents[0];
    assert.strictEqual(raw.capture_status, 'inserted');
    assert.ok(esTextoErrorPortal(raw.texto_raw));
    assert.strictEqual(raw.metadata_json.evidence.status, 'missing');
    assert.strictEqual(raw.metadata_json.evidence.attempts[0].reason, 'portal_error');
  });

  await test('recuperador es dry-run por defecto, actualiza la misma alerta e idempotiza el rerun', async () => {
    const supabase = crearSupabaseMemoria();
    supabase._stores.alertas.push({
      id: 501, url: 'https://bopa/501', fecha: '2026-07-19', fuente: 'BOPA',
      estado_ia: 'needs_evidence', contenido: '', resumen: 'SIN EVIDENCIA: portal_error',
    });
    supabase._stores.raw_documents.push({
      id: 901, inserted_alerta_id: 501, fuente: 'BOPA', url: 'https://bopa/501',
      url_html: 'https://bopa/501', url_pdf: 'https://bopa/501.pdf', texto_raw: BOPA_ERROR,
      metadata_json: { bopa: { official_id: '2026-00001' }, evidence: { status: 'missing', attempts: [] } },
    });
    const extract = async () => ({
      texto: TEXTO_OFICIAL,
      evidencia: true,
      fuente_evidencia: 'summary_pdf',
      urlPdf: 'https://bopa/501.pdf',
      attempts: [{ source: 'summary_pdf', status: 'success', reason: null }],
      recovered_at: '2026-07-20T11:00:00.000Z',
    });

    const dryRun = await recuperarAlertasBopaSinEvidencia(supabase, {
      fecha: '2026-07-19', limit: 5, obtenerTextoDocumento: extract,
      now: () => '2026-07-20T11:00:00.000Z',
    });
    assert.strictEqual(dryRun.dry_run, true);
    assert.strictEqual(dryRun.would_recover, 1);
    assert.strictEqual(supabase._stores.alertas[0].estado_ia, 'needs_evidence');
    assert.strictEqual(supabase._stores.raw_documents[0].texto_raw, BOPA_ERROR);

    const applied = await recuperarAlertasBopaSinEvidencia(supabase, {
      fecha: '2026-07-19', limit: 5, dryRun: false, obtenerTextoDocumento: extract,
      now: () => '2026-07-20T11:00:00.000Z',
    });
    assert.strictEqual(applied.recovered, 1);
    assert.strictEqual(supabase._stores.alertas.length, 1, 'no crea otra alerta');
    assert.strictEqual(supabase._stores.alertas[0].estado_ia, 'pendiente_clasificar');
    assert.strictEqual(supabase._stores.alertas[0].contenido, TEXTO_OFICIAL);
    assert.strictEqual(supabase._stores.alertas[0].resumen, 'Procesando con IA...');
    const raw = supabase._stores.raw_documents[0];
    assert.strictEqual(raw.metadata_json.bopa.official_id, '2026-00001');
    assert.strictEqual(raw.metadata_json.evidence.status, 'recovered');
    assert.strictEqual(raw.metadata_json.evidence.source, 'summary_pdf');
    assert.strictEqual(raw.metadata_json.evidence.recovery_runs.length, 1);

    const rerun = await recuperarAlertasBopaSinEvidencia(supabase, {
      fecha: '2026-07-19', limit: 5, dryRun: false, obtenerTextoDocumento: extract,
    });
    assert.strictEqual(rerun.total, 0);
    assert.strictEqual(supabase._stores.alertas.length, 1);
    assert.strictEqual(supabase._stores.raw_documents.length, 1);
    assert.strictEqual(raw.metadata_json.evidence.recovery_runs.length, 1);
  });

  await test('recuperación fallida conserva needs_evidence, contenido y motivo previo, y audita', async () => {
    const supabase = crearSupabaseMemoria();
    supabase._stores.alertas.push({
      id: 502, url: 'https://bopa/502', fecha: '2026-07-19', fuente: 'BOPA',
      estado_ia: 'needs_evidence', contenido: '', resumen: 'SIN EVIDENCIA: portal_error',
    });
    supabase._stores.raw_documents.push({
      id: 902, inserted_alerta_id: 502, fuente: 'BOPA', url: 'https://bopa/502',
      texto_raw: BOPA_ERROR,
      metadata_json: {
        otro_campo: 'se conserva',
        evidence: { status: 'missing', reason: 'portal_error', attempts: [{ source: 'html', status: 'failed' }] },
      },
    });

    const result = await recuperarAlertasBopaSinEvidencia(supabase, {
      dryRun: false,
      obtenerTextoDocumento: async () => ({
        texto: '', evidencia: false, motivo: 'pdf_ilegible',
        attempts: [{ source: 'summary_pdf', status: 'failed', reason: 'pdf_ilegible' }],
      }),
      now: () => '2026-07-20T12:00:00.000Z',
    });

    assert.strictEqual(result.missing, 1);
    const alerta = supabase._stores.alertas[0];
    assert.strictEqual(alerta.estado_ia, 'needs_evidence');
    assert.strictEqual(alerta.contenido, '');
    assert.strictEqual(alerta.resumen, 'SIN EVIDENCIA: portal_error');
    const raw = supabase._stores.raw_documents[0];
    assert.strictEqual(raw.texto_raw, BOPA_ERROR);
    assert.strictEqual(raw.metadata_json.otro_campo, 'se conserva');
    assert.strictEqual(raw.metadata_json.evidence.reason, 'pdf_ilegible');
    assert.strictEqual(raw.metadata_json.evidence.attempts.length, 2);
    assert.strictEqual(raw.metadata_json.evidence.recovery_runs.length, 1);
  });

  console.log(`\nResultados bopaEvidence: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
