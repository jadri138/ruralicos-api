const {
  CAPTURE_STATUS,
  marcarRawDocumentInsertado,
  marcarRawDocumentSaltado,
} = require('../../rawDocuments/rawDocuments.service');

async function insertarAlertasBoletin(supabase, documentos, opciones) {
  const {
    fuente,
    region,
    estadoIa = 'pendiente_clasificar',
    resumen = 'Procesando con IA...',
    contenido = crearContenidoBoletin,
    chunkSize = 100,
  } = opciones;

  let nuevas = 0;
  let duplicadas = 0;
  let errores = 0;
  const docsValidos = [];
  const urlsVistas = new Set();

  for (const doc of documentos) {
    if (!doc?.url) {
      errores++;
      // No se pierde: queda registrado como missing_url (no-op si no trae raw id).
      await marcarRawDocumentSaltado(supabase, doc?.raw_document_id, 'missing_url', {
        status: CAPTURE_STATUS.MISSING_URL,
      });
      continue;
    }

    const urlKey = String(doc.url);
    if (urlsVistas.has(urlKey)) {
      duplicadas++;
      await marcarRawDocumentSaltado(supabase, doc.raw_document_id, 'duplicate_url', {
        status: CAPTURE_STATUS.DUPLICATE,
      });
      continue;
    }

    urlsVistas.add(urlKey);
    docsValidos.push(doc);
  }

  for (const loteDocs of chunkArray(docsValidos, chunkSize)) {
    const urls = loteDocs.map((doc) => doc.url);
    const { data: existentes, error: errDup } = await supabase
      .from('alertas')
      .select('url')
      .in('url', urls);

    if (errDup) {
      errores += loteDocs.length;
      continue;
    }

    const urlsExistentes = new Set((existentes || []).map((row) => String(row.url)));
    const items = [];

    for (const doc of loteDocs) {
      if (urlsExistentes.has(String(doc.url))) {
        duplicadas++;
        await marcarRawDocumentSaltado(supabase, doc.raw_document_id, 'duplicate_url', {
          status: CAPTURE_STATUS.DUPLICATE,
        });
        continue;
      }

      // Override por-documento: un scraper puede marcar una alerta como bloqueada de
      // entrada (p. ej. BOPA cuando el portal devuelve error/boilerplate -> needs_evidence),
      // para que NO entre al pipeline IA ni llegue a 'listo'. Compat: si el doc no trae
      // `_estado_ia`, se usa el estado por defecto y el comportamiento no cambia.
      const estadoFila = doc._estado_ia || estadoIa;
      const resumenFila = doc._estado_ia
        ? `SIN EVIDENCIA: ${doc._evidence_reason || 'documento no disponible en el portal'}`
        : resumen;

      items.push({
        rawDocumentId: doc.raw_document_id ?? null,
        fila: {
          titulo: doc.titulo,
          resumen: resumenFila,
          estado_ia: estadoFila,
          url: doc.url,
          fecha: doc.fecha,
          region,
          fuente,
          contenido: contenido(doc),
        },
      });
    }

    const resultado = await insertarFilasAlertas(supabase, items, { fuente, chunkSize });
    nuevas += resultado.nuevas;
    errores += resultado.errores;
  }

  return { nuevas, duplicadas, errores };
}

function crearContenidoBoletin(doc) {
  const contenidoExtra = {
    organismo: doc.organismo || null,
    seccion: doc.seccion || null,
    boletin: doc.boletin || null,
    idOficial: doc.idOficial || null,
    urlHtml: doc.urlHtml || null,
    urlPdf: doc.urlPdf || null,
  };

  return [
    doc.texto || doc.titulo || '',
    '',
    '--- metadatos ---',
    JSON.stringify(contenidoExtra),
  ].join('\n').trim();
}

function chunkArray(items, size) {
  const chunkSize = Math.max(1, Number(size) || 100);
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

async function insertarFilasAlertas(supabase, items, { fuente, chunkSize }) {
  let nuevas = 0;
  let errores = 0;

  for (const lote of chunkArray(items, chunkSize)) {
    if (lote.length === 0) continue;

    const filas = lote.map((it) => it.fila);
    const { data, error } = await supabase.from('alertas').insert(filas).select('id, url');
    if (!error) {
      nuevas += lote.length;
      await enlazarRawInsertados(supabase, lote, data);
      continue;
    }

    const fallback = await insertarFilasUnaAUna(supabase, lote, fuente);
    nuevas += fallback.nuevas;
    errores += fallback.errores;
  }

  return { nuevas, errores };
}

// Enlaza cada raw document con la alerta recien creada (por URL). No-op si ningun
// item del lote arrastra raw_document_id (scrapers que no usan la capa de captura).
async function enlazarRawInsertados(supabase, lote, dataInsertada) {
  const conRaw = lote.filter((it) => it.rawDocumentId);
  if (conRaw.length === 0) return;

  const urlAId = new Map((dataInsertada || []).map((row) => [String(row.url), row.id]));
  await Promise.all(
    conRaw.map((it) =>
      marcarRawDocumentInsertado(supabase, it.rawDocumentId, urlAId.get(String(it.fila.url)) ?? null)
    )
  );
}

async function insertarFilasUnaAUna(supabase, lote, fuente) {
  let nuevas = 0;
  let errores = 0;

  for (const it of lote) {
    const { data, error } = await supabase.from('alertas').insert([it.fila]).select('id, url');
    if (error) {
      console.error(`[${fuente}] Error insertando:`, it.fila.url, error.message);
      errores++;
      await marcarRawDocumentSaltado(supabase, it.rawDocumentId, error.message || 'insert_error', {
        status: CAPTURE_STATUS.ERROR,
      });
      continue;
    }
    nuevas++;
    const alertaId = Array.isArray(data) && data[0] ? data[0].id : null;
    await marcarRawDocumentInsertado(supabase, it.rawDocumentId, alertaId);
  }

  return { nuevas, errores };
}

module.exports = { insertarAlertasBoletin, crearContenidoBoletin };
