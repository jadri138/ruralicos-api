// Capa de captura bruta/auditable de documentos detectados por los scrapers.
//
// Registra TODO documento devuelto por una fuente oficial en la tabla
// `raw_documents` ANTES de aplicar filtros o de insertar en `alertas`, para que
// ningun documento desaparezca en silencio (sin URL, duplicado o descartado por
// una regla). No usa IA. No toca el flujo de alertas/digest/WhatsApp.

const crypto = require('crypto');

const CAPTURE_STATUS = {
  DETECTED: 'detected',
  INSERTED: 'inserted',
  DUPLICATE: 'duplicate',
  MISSING_URL: 'missing_url',
  SKIPPED: 'skipped_by_rule',
  ERROR: 'error',
};

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Hash de contenido: normaliza de forma agresiva (trim + colapso de espacios +
// minusculas) para que titulos equivalentes compartan huella.
function hashTexto(value) {
  if (value === null || value === undefined) return null;
  const normalizado = String(value).trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalizado) return null;
  return sha256Hex(normalizado);
}

// Hash de URL: NO pasa toda la URL a minusculas (las rutas son case-sensitive).
// Solo trim + limpieza basica de espacios.
function hashUrl(value) {
  if (value === null || value === undefined) return null;
  const limpio = String(value).trim().replace(/\s+/g, '');
  if (!limpio) return null;
  return sha256Hex(limpio);
}

function primerValor(...valores) {
  for (const v of valores) {
    if (v !== null && v !== undefined && String(v).trim() !== '') return v;
  }
  return null;
}

function claveRaw(fuente, urlHash) {
  return `${fuente ?? ''}::${urlHash ?? ''}`;
}

// Mapea un documento de scraper (en cualquiera de las convenciones de nombres del
// repo) a una fila de `raw_documents` con su huella de url y de contenido.
function normalizarRawDocument(doc, opciones = {}) {
  const d = doc || {};
  const url = primerValor(d.url, d.urlHtml, d.url_html, d.urlPdf, d.url_pdf);
  const urlHtml = primerValor(d.urlHtml, d.url_html);
  const urlPdf = primerValor(d.urlPdf, d.url_pdf);
  const titulo = primerValor(d.titulo, d.title);
  const textoRaw = primerValor(d.texto_raw, d.texto, d.contenido);

  return {
    fuente: primerValor(opciones.fuente, d.fuente),
    region: primerValor(d.region, opciones.region),
    fecha: primerValor(d.fecha, opciones.fecha),
    titulo,
    url,
    url_html: urlHtml,
    url_pdf: urlPdf,
    organismo: primerValor(d.organismo, d.organism),
    seccion: primerValor(d.seccion, d.section),
    boletin: primerValor(d.boletin, d.boletín),
    id_oficial: primerValor(d.id_oficial, d.idOficial),
    texto_raw: textoRaw,
    contenido_hash: hashTexto(primerValor(textoRaw, titulo)),
    url_hash: hashUrl(url),
    scraper_run_id: primerValor(d.scraper_run_id, opciones.scraperRunId),
    capture_status: CAPTURE_STATUS.DETECTED,
    capture_reason: null,
    metadata_json:
      d.metadata_json && typeof d.metadata_json === 'object' ? d.metadata_json : {},
  };
}

// Registra el lote en `raw_documents` (idempotente en re-runs por (fuente,url_hash))
// y devuelve los documentos originales con `raw_document_id` para encadenar con el
// filtro del scraper y con insertarAlertasBoletin. Nunca lanza: si algo falla,
// devuelve los docs sin raw_document_id para no bloquear el scraping.
async function registrarRawDocuments(supabase, documentos, opciones = {}) {
  const lista = Array.isArray(documentos) ? documentos : [];
  if (lista.length === 0) return [];

  const filas = lista.map((doc) => normalizarRawDocument(doc, opciones));
  const rawIds = new Array(lista.length).fill(null);

  const conHash = [];
  const sinHash = [];
  filas.forEach((fila, idx) => {
    if (fila.url_hash) conHash.push({ fila, idx });
    else sinHash.push({ fila, idx });
  });

  // Filas con URL: upsert idempotente. En re-runs no duplica la fila existente.
  if (conHash.length) {
    const { data, error } = await supabase
      .from('raw_documents')
      .upsert(
        conHash.map((x) => x.fila),
        { onConflict: 'fuente,url_hash', ignoreDuplicates: true }
      )
      .select('id, fuente, url_hash');

    if (error) {
      console.error('[raw_documents] Error registrando (con url):', error.message);
    } else {
      const mapa = new Map();
      for (const row of data || []) mapa.set(claveRaw(row.fuente, row.url_hash), row.id);

      // ignoreDuplicates omite los conflictos: resolver sus ids existentes.
      const faltan = conHash.filter(
        (x) => !mapa.has(claveRaw(x.fila.fuente, x.fila.url_hash))
      );
      if (faltan.length) {
        const hashesFaltan = [...new Set(faltan.map((x) => x.fila.url_hash))];
        const { data: existentes, error: errSel } = await supabase
          .from('raw_documents')
          .select('id, fuente, url_hash')
          .in('url_hash', hashesFaltan);
        if (errSel) {
          console.error('[raw_documents] Error resolviendo ids existentes:', errSel.message);
        } else {
          for (const row of existentes || []) {
            const k = claveRaw(row.fuente, row.url_hash);
            if (!mapa.has(k)) mapa.set(k, row.id);
          }
        }
      }

      for (const x of conHash) {
        rawIds[x.idx] = mapa.get(claveRaw(x.fila.fuente, x.fila.url_hash)) ?? null;
      }
    }
  }

  // Filas sin URL: nunca entran en conflicto (NULL distinto en Postgres) -> siempre
  // se insertan. Se mapean por orden de insercion.
  if (sinHash.length) {
    const { data, error } = await supabase
      .from('raw_documents')
      .insert(sinHash.map((x) => x.fila))
      .select('id');
    if (error) {
      console.error('[raw_documents] Error registrando (sin url):', error.message);
    } else {
      (data || []).forEach((row, i) => {
        if (sinHash[i]) rawIds[sinHash[i].idx] = row.id;
      });
    }
  }

  return lista.map((doc, idx) => ({ ...doc, raw_document_id: rawIds[idx] }));
}

async function marcarRawDocumentInsertado(supabase, rawDocumentId, alertaId) {
  if (!rawDocumentId) return;
  const { error } = await supabase
    .from('raw_documents')
    .update({
      capture_status: CAPTURE_STATUS.INSERTED,
      inserted_alerta_id: alertaId ?? null,
      capture_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', rawDocumentId);
  if (error) {
    console.error('[raw_documents] Error marcando insertado:', rawDocumentId, error.message);
  }
}

async function actualizarRawDocumentContenido(supabase, rawDocumentId, textoRaw) {
  const texto = String(textoRaw || '').replace(/\s+/g, ' ').trim();
  if (!rawDocumentId || !texto) return { updated: false };

  const { error } = await supabase
    .from('raw_documents')
    .update({
      texto_raw: texto,
      contenido_hash: hashTexto(texto),
      updated_at: new Date().toISOString(),
    })
    .eq('id', rawDocumentId);

  if (error) {
    console.error('[raw_documents] Error actualizando contenido:', rawDocumentId, error.message);
    return { updated: false, error: error.message };
  }
  return { updated: true };
}

// Marca un raw document como no insertado. Por defecto 'skipped_by_rule'; con
// `opciones.status` se reutiliza para 'duplicate', 'missing_url' o 'error'.
//
// Salvaguarda de auditoría: si el documento YA originó una alerta en una ejecución
// previa (inserted_alerta_id != null), NO lo degradamos a 'duplicate'. En reruns la
// alerta existe en BD y se detectaría como duplicada, pero eso no debe borrar la
// constancia de que ese documento creó la alerta -> conservamos 'inserted' y su
// enlace. (Evita el estado contradictorio inserted_alerta_id + capture_status=duplicate.)
async function marcarRawDocumentSaltado(supabase, rawDocumentId, reason, opciones = {}) {
  if (!rawDocumentId) return;
  const status = opciones.status || CAPTURE_STATUS.SKIPPED;

  if (status === CAPTURE_STATUS.DUPLICATE) {
    const { data: actual, error: errSel } = await supabase
      .from('raw_documents')
      .select('inserted_alerta_id')
      .eq('id', rawDocumentId)
      .limit(1);
    if (!errSel && Array.isArray(actual) && actual[0] && actual[0].inserted_alerta_id) {
      // Ya insertado antes: mantener 'inserted' + enlace; no sobreescribir con duplicate.
      return;
    }
  }

  const { error } = await supabase
    .from('raw_documents')
    .update({
      capture_status: status,
      capture_reason: reason ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', rawDocumentId);
  if (error) {
    console.error('[raw_documents] Error marcando saltado:', rawDocumentId, error.message);
  }
}

module.exports = {
  CAPTURE_STATUS,
  hashTexto,
  hashUrl,
  normalizarRawDocument,
  registrarRawDocuments,
  actualizarRawDocumentContenido,
  marcarRawDocumentInsertado,
  marcarRawDocumentSaltado,
};
