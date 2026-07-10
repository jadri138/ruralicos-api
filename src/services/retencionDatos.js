// src/services/retencionDatos.js
//
// Purga por politica de retencion (cumplimiento RGPD: limitacion del plazo de
// conservacion). SOLO tablas operativas sin dependientes por FK y sin valor de
// producto pasado el plazo: logs tecnicos, ejecuciones de scrapers/pipeline y
// eventos de webhook.
//
// Fuera de la politica v1, a proposito:
//   - mia_inbound_messages (conversaciones): mia_agent_cases.inbound_id la
//     referencia SIN on delete set null; purgarla requiere tratar antes los
//     casos. Pendiente de una v2 consciente de FKs.
//   - datos de aprendizaje (user_memory, alerta_clicks, feedback): tienen valor
//     de producto mientras la cuenta existe; se borran con el derecho al olvido
//     (DELETE /me), no por antiguedad.
//
// Doble seguro en el endpoint: RETENTION_ENABLED=true en el env Y
// dry_run=false explicito; si no, solo informa de lo que purgaria.

const POLITICA_RETENCION = [
  { tabla: 'webhook_events', dias: 90 },
  { tabla: 'logs', dias: 180 },
  { tabla: 'whatsapp_logs', dias: 180 },
  { tabla: 'ia_runs', dias: 180 },
  { tabla: 'scraper_runs', dias: 365 },
  { tabla: 'pipeline_runs', dias: 365 },
];

async function purgarPorRetencion(supabase, {
  dryRun = true,
  batchSize = 500,
  maxBatchesPorTabla = 20,
  ahora = () => new Date(),
  politica = POLITICA_RETENCION,
} = {}) {
  const resultados = [];

  for (const regla of politica) {
    const cutoff = new Date(ahora().getTime() - regla.dias * 24 * 60 * 60 * 1000).toISOString();

    const { count, error: countError } = await supabase
      .from(regla.tabla)
      .select('id', { count: 'exact', head: true })
      .lt('created_at', cutoff);

    if (countError) {
      resultados.push({ tabla: regla.tabla, dias: regla.dias, error: countError.message });
      continue;
    }

    const purgables = count || 0;

    if (dryRun || purgables === 0) {
      resultados.push({ tabla: regla.tabla, dias: regla.dias, cutoff, purgables, borradas: 0 });
      continue;
    }

    // Borrado por lotes (select ids + delete in): acota cada delete y permite
    // parar sin dejar la tabla a medias si algo falla.
    let borradas = 0;
    let errorMsg = null;
    for (let lote = 0; lote < maxBatchesPorTabla; lote++) {
      const { data: filas, error: selError } = await supabase
        .from(regla.tabla)
        .select('id')
        .lt('created_at', cutoff)
        .order('id', { ascending: true })
        .limit(batchSize);
      if (selError) { errorMsg = selError.message; break; }
      if (!filas || filas.length === 0) break;

      const ids = filas.map((f) => f.id);
      const { error: delError } = await supabase
        .from(regla.tabla)
        .delete()
        .in('id', ids);
      if (delError) { errorMsg = delError.message; break; }

      borradas += ids.length;
      if (filas.length < batchSize) break;
    }

    resultados.push({
      tabla: regla.tabla,
      dias: regla.dias,
      cutoff,
      purgables,
      borradas,
      ...(errorMsg ? { error: errorMsg } : {}),
      ...(borradas < purgables && !errorMsg ? { pendientes: purgables - borradas } : {}),
    });
  }

  return { dry_run: dryRun, resultados };
}

module.exports = { POLITICA_RETENCION, purgarPorRetencion };
