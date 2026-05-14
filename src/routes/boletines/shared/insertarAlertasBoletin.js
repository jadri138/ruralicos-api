async function insertarAlertasBoletin(supabase, documentos, opciones) {
  const {
    fuente,
    region,
    estadoIa = 'pendiente_clasificar',
    resumen = 'Procesando con IA...',
  } = opciones;

  let nuevas = 0;
  let duplicadas = 0;
  let errores = 0;

  for (const doc of documentos) {
    if (!doc?.url) {
      errores++;
      continue;
    }

    const { data: existe, error: errDup } = await supabase
      .from('alertas')
      .select('id')
      .eq('url', doc.url)
      .limit(1);

    if (errDup) {
      errores++;
      continue;
    }

    if (existe && existe.length > 0) {
      duplicadas++;
      continue;
    }

    const contenidoExtra = {
      organismo: doc.organismo || null,
      seccion: doc.seccion || null,
      boletin: doc.boletin || null,
      idOficial: doc.idOficial || null,
      urlHtml: doc.urlHtml || null,
      urlPdf: doc.urlPdf || null,
    };

    const contenido = [
      doc.texto || doc.titulo || '',
      '',
      '--- metadatos ---',
      JSON.stringify(contenidoExtra),
    ].join('\n').trim();

    const { error: errInsert } = await supabase.from('alertas').insert([{
      titulo: doc.titulo,
      resumen,
      estado_ia: estadoIa,
      url: doc.url,
      fecha: doc.fecha,
      region,
      fuente,
      contenido,
    }]);

    if (errInsert) {
      console.error(`[${fuente}] Error insertando:`, doc.url, errInsert.message);
      errores++;
      continue;
    }

    nuevas++;
  }

  return { nuevas, duplicadas, errores };
}

module.exports = { insertarAlertasBoletin };

