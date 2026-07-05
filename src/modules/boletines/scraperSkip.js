// src/modules/boletines/scraperSkip.js
//
// Cortocircuito de re-scrapeo: los boletines oficiales publican una vez por la
// mañana, pero el cron ejecuta los scrapers varias veces al día. Si una fuente
// ya tuvo hoy un run con volumen (nuevas o duplicadas > 0), las pasadas
// siguientes re-descargan y re-procesan el mismo boletín solo para descubrir
// que todo son duplicados (~92% del trabajo del BOE en jul-2026).
//
// Regla: se omite el scrape si existe un run previo de la misma fuente y
// fecha_objetivo con estado ok/warning y volumen > 0. Un run previo sin
// volumen (boletín aún no publicado) o en error NO activa la omisión.

const SKIP_ENABLED_DEFAULT = 'true';

function skipHabilitado(env = process.env) {
  return (env.SCRAPER_SKIP_ALREADY_CAPTURED || SKIP_ENABLED_DEFAULT).toLowerCase() === 'true';
}

async function buscarRunConVolumen(supabase, fuente, fechaObjetivo) {
  try {
    const { data, error } = await supabase
      .from('scraper_runs')
      .select('id, nuevas, duplicadas, status, started_at')
      .eq('fuente', fuente)
      .eq('fecha_objetivo', fechaObjetivo)
      .in('status', ['ok', 'warning'])
      .or('nuevas.gt.0,duplicadas.gt.0')
      .order('started_at', { ascending: false })
      .limit(1);

    if (error) {
      console.warn(`[scraperSkip] No se pudo consultar runs previos de ${fuente}:`, error.message);
      return null;
    }
    return (data || [])[0] || null;
  } catch (err) {
    console.warn(`[scraperSkip] Error consultando runs previos de ${fuente}:`, err.message);
    return null;
  }
}

// Devuelve null si hay que scrapear, o un resultado de omisión (ya persistido
// en scraper_runs via guardarRun) si el boletín ya fue capturado hoy.
async function omitirScraperSiCapturado(supabase, { path, fuente, fecha, force = false, guardarRun }) {
  if (force || !skipHabilitado()) return null;

  const previo = await buscarRunConVolumen(supabase, fuente, fecha);
  if (!previo) return null;

  const ahora = new Date().toISOString();
  const mensaje =
    `Omitido: ${fuente} ya capturado hoy (run ${previo.id}: nuevas=${previo.nuevas}, duplicadas=${previo.duplicadas})`;
  const quality = {
    ok: true,
    severity: 'ok',
    fuente,
    endpoint: path,
    http_status: null,
    flags: ['omitido_ya_capturado'],
    metrics: { nuevas: 0, duplicadas: 0, relevantes: null, totales: null, errores: 0 },
    recommendations: [],
  };

  if (typeof guardarRun === 'function') {
    await guardarRun(supabase, {
      fuente,
      endpoint: path,
      fecha_objetivo: fecha,
      started_at: ahora,
      finished_at: ahora,
      duration_ms: 0,
      status: 'ok',
      http_status: null,
      nuevas: 0,
      duplicadas: 0,
      errores: 0,
      relevantes: null,
      mensaje,
      error_msg: null,
      response_json: { skipped: true, run_previo_id: previo.id, quality },
    });
  }

  return {
    path,
    fuente,
    ok: true,
    skipped: true,
    status: 200,
    body: { success: true, skipped: true, run_previo_id: previo.id, mensaje },
    quality,
  };
}

module.exports = {
  buscarRunConVolumen,
  omitirScraperSiCapturado,
  skipHabilitado,
};
