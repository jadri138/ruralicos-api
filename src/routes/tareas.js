// src/routes/tareas.js
const { checkCronToken } = require('../utils/checkCronToken');
const { enviarWhatsAppAdmin } = require('../whatsapp');
const { getFechaMadridISO } = require('../utils/fechaMadrid');

const SCRAPE_PATHS_DEFAULT = [
  '/scrape-boe-oficial',
  '/scrape-boa-oficial',
  '/scrape-bocan-oficial',
  '/scrape-bocant-oficial',
  '/scrape-bocm-oficial',
  '/scrape-bocyl-oficial',
  '/scrape-boib-oficial',
  '/scrape-boja-oficial',
  '/scrape-bon-oficial',
  '/scrape-bopa-oficial',
  '/scrape-bopv-oficial',
  '/scrape-bor-oficial',
  '/scrape-borm-oficial',
  '/scrape-docm-oficial',
  '/scrape-doe-oficial',
  '/scrape-dog',
  '/scrape-dogc',
  '/scrape-dogv',
  '/scrape-bome-oficial',
  '/scrape-bocce-oficial',
];

const SCRAPER_FUENTES = {
  '/scrape-boe-oficial': 'BOE',
  '/scrape-boa-oficial': 'BOA',
  '/scrape-bocan-oficial': 'BOCAN',
  '/scrape-bocant-oficial': 'BOCANT',
  '/scrape-bocm-oficial': 'BOCM',
  '/scrape-bocyl-oficial': 'BOCYL',
  '/scrape-boib-oficial': 'BOIB',
  '/scrape-boja-oficial': 'BOJA',
  '/scrape-bon-oficial': 'BON',
  '/scrape-bopa-oficial': 'BOPA',
  '/scrape-bopv-oficial': 'BOPV',
  '/scrape-bor-oficial': 'BOR',
  '/scrape-borm-oficial': 'BORM',
  '/scrape-docm-oficial': 'DOCM',
  '/scrape-doe-oficial': 'DOE',
  '/scrape-dog': 'DOG',
  '/scrape-dogc': 'DOGC',
  '/scrape-dogv': 'DOGV',
  '/scrape-bome-oficial': 'BOME',
  '/scrape-bocce-oficial': 'BOCCE',
};

function getBaseUrl() {
  return process.env.PUBLIC_BASE_URL || 'http://localhost:' + (process.env.PORT || 3000);
}

function getScrapePaths() {
  return (process.env.PIPELINE_SCRAPE_PATHS || SCRAPE_PATHS_DEFAULT.join(','))
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean);
}

function buildScrapeUrl(baseUrl, path, token, fechaISO) {
  const fecha = path.startsWith('/scrape-boe-')
    ? fechaISO.replace(/-/g, '')
    : fechaISO;
  const params = new URLSearchParams({ token, fecha });
  return `${baseUrl}${path}${path.includes('?') ? '&' : '?'}${params.toString()}`;
}

function obtenerFuenteScraper(path) {
  return SCRAPER_FUENTES[path] || path.replace(/^\/scrape-/, '').replace(/-oficial$/, '').toUpperCase();
}

function numeroBody(body, keys) {
  for (const key of keys) {
    const value = Number(body?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function statusRun(responseOk, body) {
  if (!responseOk) return 'error';
  const errores = numeroBody(body, ['errores']);
  if (errores > 0) return 'warning';
  return 'ok';
}

async function readResponseBody(response) {
  const raw = await response.text();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return { raw: raw.slice(0, 2000) };
  }
}

async function guardarScraperRun(supabase, run) {
  const { error } = await supabase.from('scraper_runs').insert([run]);
  if (error) {
    console.warn('[scraper_runs] No se pudo guardar ejecucion:', error.message);
  }
}

async function guardarPipelineRun(supabase, run) {
  const { error } = await supabase.from('pipeline_runs').insert([run]);
  if (error) {
    console.warn('[pipeline_runs] No se pudo guardar ejecucion:', error.message);
  }
}

module.exports = function tareasRoutes(app, supabase) {
  app.get('/tareas/scrapers-diario', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const baseUrl = getBaseUrl();
    const token = process.env.CRON_TOKEN;
    const scrapePaths = getScrapePaths();
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
      ? req.query.fecha
      : getFechaMadridISO();

    async function hit(path) {
      const startedAt = new Date();
      const url = buildScrapeUrl(baseUrl, path, token, fecha);
      const response = await fetch(url);
      const finishedAt = new Date();

      const body = await readResponseBody(response);

      const result = {
        path,
        fuente: obtenerFuenteScraper(path),
        ok: response.ok,
        status: response.status,
        body,
      };

      await guardarScraperRun(supabase, {
        fuente: result.fuente,
        endpoint: path,
        fecha_objetivo: fecha,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        status: statusRun(response.ok, body),
        http_status: response.status,
        nuevas: numeroBody(body, ['nuevas']),
        duplicadas: numeroBody(body, ['duplicadas']),
        errores: numeroBody(body, ['errores']),
        relevantes: numeroBody(body, ['relevantes', 'documentos_insertables', 'totales']) || null,
        mensaje: body?.mensaje || null,
        error_msg: response.ok ? null : (body?.error || `HTTP ${response.status}`),
        response_json: body,
      });

      return result;
    }

    const resultados = [];
    for (const path of scrapePaths) {
      const result = await hit(path);
      resultados.push(result);

      if (!result.ok) {
        console.error(`[scrapers-diario] ${path} devolvio ${result.status}`, result.body);
      }
    }

    const fallidos = resultados.filter((result) => !result.ok);

    res.status(fallidos.length ? 207 : 200).json({
      success: fallidos.length === 0,
      fecha,
      mensaje: fallidos.length
        ? `Scrapers ejecutados con ${fallidos.length} fallo(s)`
        : 'Scrapers diarios ejecutados correctamente',
      total: resultados.length,
      correctos: resultados.length - fallidos.length,
      fallidos: fallidos.length,
      resultados,
    });
  });

  app.get('/tareas/scraper', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const path = String(req.query.path || '').trim();
    if (!SCRAPE_PATHS_DEFAULT.includes(path)) {
      return res.status(400).json({ error: 'Scraper no permitido', permitidos: SCRAPE_PATHS_DEFAULT });
    }

    const baseUrl = getBaseUrl();
    const token = process.env.CRON_TOKEN;
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
      ? req.query.fecha
      : getFechaMadridISO();

    const startedAt = new Date();
    const url = buildScrapeUrl(baseUrl, path, token, fecha);
    const response = await fetch(url);
    const finishedAt = new Date();

    const body = await readResponseBody(response);

    const result = {
      path,
      fuente: obtenerFuenteScraper(path),
      ok: response.ok,
      status: response.status,
      body,
    };

    await guardarScraperRun(supabase, {
      fuente: result.fuente,
      endpoint: path,
      fecha_objetivo: fecha,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      status: statusRun(response.ok, body),
      http_status: response.status,
      nuevas: numeroBody(body, ['nuevas']),
      duplicadas: numeroBody(body, ['duplicadas']),
      errores: numeroBody(body, ['errores']),
      relevantes: numeroBody(body, ['relevantes', 'documentos_insertables', 'totales']) || null,
      mensaje: body?.mensaje || null,
      error_msg: response.ok ? null : (body?.error || `HTTP ${response.status}`),
      response_json: body,
    });

    return res.status(response.ok ? 200 : 207).json(result);
  });

  app.get('/tareas/pipeline-diario', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const baseUrl = getBaseUrl();
      const token = process.env.CRON_TOKEN;
      const maxLoops = Number(process.env.PIPELINE_MAX_LOOPS || 40);
      const stepDelayMs = Number(process.env.PIPELINE_STEP_DELAY_MS || 800);
      const scrapePaths = getScrapePaths();
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      function buildPipelineUrl(path) {
        if (scrapePaths.includes(path)) return buildScrapeUrl(baseUrl, path, token, fecha);
        const params = new URLSearchParams({ token, fecha });
        return `${baseUrl}${path}${path.includes('?') ? '&' : '?'}${params.toString()}`;
      }

      async function hit(path, method = 'GET') {
        const url = buildPipelineUrl(path);
        const response = await fetch(url, { method });

        const body = await readResponseBody(response);

        if (!response.ok) {
          throw new Error(`${path} devolvio ${response.status}: ${JSON.stringify(body)}`);
        }

        return { path, body };
      }

      async function runSimpleStage(stage, path, method = 'GET') {
        const startedAt = new Date();
        try {
          const result = await hit(path, method);
          const finishedAt = new Date();
          await guardarPipelineRun(supabase, {
            stage,
            endpoint: path,
            fecha_objetivo: fecha,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() - startedAt.getTime(),
            status: 'ok',
            procesadas: numeroBody(result.body, ['procesadas', 'reparadas', 'deduplicadas', 'digests_generados', 'enviados']),
            errores: Array.isArray(result.body?.errores) ? result.body.errores.length : numeroBody(result.body, ['errores']),
            response_json: result.body,
          });
          return result;
        } catch (err) {
          const finishedAt = new Date();
          await guardarPipelineRun(supabase, {
            stage,
            endpoint: path,
            fecha_objetivo: fecha,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() - startedAt.getTime(),
            status: 'error',
            error_msg: err.message,
          });
          throw err;
        }
      }

      async function runOptionalStage(stage, path, method = 'GET') {
        try {
          return await runSimpleStage(stage, path, method);
        } catch (err) {
          console.warn(`[pipeline] Fase opcional ${stage} omitida:`, err.message);
          return {
            path,
            body: {
              success: true,
              optional: true,
              skipped: true,
              mensaje: `Fase opcional omitida: ${err.message}`,
            },
          };
        }
      }

      async function runBatchedStep(name, path) {
        const startedAt = new Date();
        let loops = 0;
        let total = 0;
        let totalProgress = 0;
        let colaVacia = false;
        let bloqueado = false;
        const vueltas = [];

        try {
          while (loops < maxLoops) {
            loops++;
            const result = await hit(path);
            const procesadas = Number(result.body?.procesadas ?? 0);
            const progress = Number(
              result.body?.actualizadas ??
              result.body?.aprobadas ??
              ((Number(result.body?.clasificadas ?? 0) + Number(result.body?.descartadas ?? 0)) || 0)
            );
            total += procesadas;
            totalProgress += progress;
            vueltas.push(result.body);

            console.log(`[pipeline] ${name} vuelta ${loops}: procesadas=${procesadas}, actualizadas=${progress}`);

            if (procesadas === 0) {
              colaVacia = true;
              break;
            }
            if (progress === 0) {
              bloqueado = true;
              break;
            }
            await sleep(stepDelayMs);
          }

          const result = {
            loops,
            total,
            totalProgress,
            colaVacia,
            bloqueado,
            maxLoopsAlcanzado: !colaVacia && loops >= maxLoops,
            ultimaRespuesta: vueltas[vueltas.length - 1] || null,
          };
          const finishedAt = new Date();
          await guardarPipelineRun(supabase, {
            stage: name,
            endpoint: path,
            fecha_objetivo: fecha,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() - startedAt.getTime(),
            status: result.maxLoopsAlcanzado || result.bloqueado ? 'warning' : 'ok',
            loops,
            procesadas: total,
            response_json: result,
          });
          return result;
        } catch (err) {
          const finishedAt = new Date();
          await guardarPipelineRun(supabase, {
            stage: name,
            endpoint: path,
            fecha_objetivo: fecha,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() - startedAt.getTime(),
            status: 'error',
            loops,
            procesadas: total,
            error_msg: err.message,
            response_json: { vueltas },
          });
          throw err;
        }
      }

      async function abortIfLimited(stageName, result) {
        if (!result.maxLoopsAlcanzado && !result.bloqueado) return false;

        const estadoActual = await runSimpleStage('estado_pipeline_abort', '/alertas/estado-pipeline');
        const motivo = result.bloqueado
          ? 'lote bloqueado sin actualizaciones'
          : `limite de ${maxLoops} vueltas`;
        const avisoAdmin = await enviarWhatsAppAdmin(
          [
            '*Ruralicos: pipeline diario detenido*',
            '',
            `Fase: ${stageName}`,
            `Motivo: ${motivo}`,
            `Procesadas en esta fase: ${result.total}`,
            `Actualizadas en esta fase: ${result.totalProgress}`,
            '',
            'No se ha preparado ni enviado el digest para evitar un envio incompleto.',
          ].join('\n')
        );

        res.status(409).json({
          success: false,
          mensaje: `Pipeline detenido en ${stageName}: ${motivo}. No se prepara ni se envia el digest para evitar un envio incompleto.`,
          stageName,
          result,
          avisoAdmin,
          estadoActual: estadoActual.body,
        });
        return true;
      }

      const scrapers = [];
      for (const path of scrapePaths) {
        scrapers.push(await hit(path));
      }

      const repararPendientes = await runSimpleStage('reparar_pendientes_ia', '/alertas/reparar-pendientes-ia', 'POST');
      const clasificar = await runBatchedStep('clasificar', '/alertas/clasificar');
      if (await abortIfLimited('clasificar', clasificar)) return;
      const resumir = await runBatchedStep('resumir', '/alertas/resumir');
      if (await abortIfLimited('resumir', resumir)) return;
      const revisar = await runBatchedStep('revisar', '/alertas/revisar');
      if (await abortIfLimited('revisar', revisar)) return;
      const deduplicar = await runSimpleStage('deduplicar', '/alertas/deduplicar');
      const miaEmbeddings = await runOptionalStage(
        'mia_embeddings_inicializar',
        '/cerebro/embeddings/inicializar?limit=100&maxLoops=10'
      );
      const miaCicloPreDigest = await runOptionalStage(
        'mia_ciclo_pre_digest',
        '/cerebro/ciclo-diario?explorar=false&limit=100&maxLoops=1'
      );
      const prepararDigest = await runSimpleStage('preparar_digest', '/alertas/preparar-digest');
      const enviarDigest = await runSimpleStage('enviar_digest', '/alertas/enviar-digest');
      const miaCicloPostDigest = await runOptionalStage(
        'mia_ciclo_post_digest',
        '/cerebro/ciclo-diario?explorar=false&limit=100&maxLoops=1'
      );
      const generarResumenFree = await runSimpleStage('generar_resumen_free', '/alertas/generar-resumen-free');
      const enviarResumenFree = await runSimpleStage('enviar_resumen_free', '/alertas/enviar-resumen-free');
      const estadoFinal = await runSimpleStage('estado_pipeline_final', '/alertas/estado-pipeline');

      res.json({
        success: true,
        mensaje: 'Pipeline diario ejecutado con fases IA por lotes hasta vaciar cola',
        scrapers,
        repararPendientes: repararPendientes.body,
        clasificar,
        resumir,
        revisar,
        deduplicar: deduplicar.body,
        miaEmbeddings: miaEmbeddings.body,
        miaCicloPreDigest: miaCicloPreDigest.body,
        prepararDigest: prepararDigest.body,
        enviarDigest: enviarDigest.body,
        miaCicloPostDigest: miaCicloPostDigest.body,
        generarResumenFree: generarResumenFree.body,
        enviarResumenFree: enviarResumenFree.body,
        estadoFinal: estadoFinal.body,
      });
    } catch (err) {
      console.error('Error en /tareas/pipeline-diario', err);
      res.status(500).json({ error: err.message });
    }
  });
};
