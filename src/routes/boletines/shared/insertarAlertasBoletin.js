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
      continue;
    }

    const urlKey = String(doc.url);
    if (urlsVistas.has(urlKey)) {
      duplicadas++;
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
    const filas = [];

    for (const doc of loteDocs) {
      if (urlsExistentes.has(String(doc.url))) {
        duplicadas++;
        continue;
      }

      filas.push({
        titulo: doc.titulo,
        resumen,
        estado_ia: estadoIa,
        url: doc.url,
        fecha: doc.fecha,
        region,
        fuente,
        contenido: contenido(doc),
      });
    }

    const resultado = await insertarFilasAlertas(supabase, filas, { fuente, chunkSize });
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

async function insertarFilasAlertas(supabase, filas, { fuente, chunkSize }) {
  let nuevas = 0;
  let errores = 0;

  for (const lote of chunkArray(filas, chunkSize)) {
    if (lote.length === 0) continue;

    const { error } = await supabase.from('alertas').insert(lote);
    if (!error) {
      nuevas += lote.length;
      continue;
    }

    const fallback = await insertarFilasUnaAUna(supabase, lote, fuente);
    nuevas += fallback.nuevas;
    errores += fallback.errores;
  }

  return { nuevas, errores };
}

async function insertarFilasUnaAUna(supabase, filas, fuente) {
  let nuevas = 0;
  let errores = 0;

  for (const fila of filas) {
    const { error } = await supabase.from('alertas').insert([fila]);
    if (error) {
      console.error(`[${fuente}] Error insertando:`, fila.url, error.message);
      errores++;
      continue;
    }
    nuevas++;
  }

  return { nuevas, errores };
}

module.exports = { insertarAlertasBoletin, crearContenidoBoletin };
