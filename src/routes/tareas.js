// src/routes/tareas.js
const { checkCronToken } = require('../utils/checkCronToken');
const { enviarWhatsAppAdmin } = require('../whatsapp');

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

function getBaseUrl() {
  return process.env.PUBLIC_BASE_URL || 'http://localhost:' + (process.env.PORT || 3000);
}

function getScrapePaths() {
  return (process.env.PIPELINE_SCRAPE_PATHS || SCRAPE_PATHS_DEFAULT.join(','))
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean);
}

function getFechaMadridISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function buildScrapeUrl(baseUrl, path, token, fechaISO) {
  const fecha = path.startsWith('/scrape-boe-')
    ? fechaISO.replace(/-/g, '')
    : fechaISO;
  const params = new URLSearchParams({ token, fecha });
  return `${baseUrl}${path}${path.includes('?') ? '&' : '?'}${params.toString()}`;
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
      const url = buildScrapeUrl(baseUrl, path, token, fecha);
      const response = await fetch(url);

      let body = null;
      try {
        body = await response.json();
      } catch {
        body = { raw: await response.text() };
      }

      return {
        path,
        ok: response.ok,
        status: response.status,
        body,
      };
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

      async function hit(path, method = 'GET') {
        const url = scrapePaths.includes(path)
          ? buildScrapeUrl(baseUrl, path, token, fecha)
          : `${baseUrl}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
        const response = await fetch(url, { method });

        let body = null;
        try {
          body = await response.json();
        } catch {
          body = { raw: await response.text() };
        }

        if (!response.ok) {
          throw new Error(`${path} devolvio ${response.status}: ${JSON.stringify(body)}`);
        }

        return { path, body };
      }

      async function runBatchedStep(name, path) {
        let loops = 0;
        let total = 0;
        let colaVacia = false;
        const vueltas = [];

        while (loops < maxLoops) {
          loops++;
          const result = await hit(path);
          const procesadas = Number(result.body?.procesadas ?? 0);
          total += procesadas;
          vueltas.push(result.body);

          console.log(`[pipeline] ${name} vuelta ${loops}: procesadas=${procesadas}`);

          if (procesadas === 0) {
            colaVacia = true;
            break;
          }
          await sleep(stepDelayMs);
        }

        return {
          loops,
          total,
          colaVacia,
          maxLoopsAlcanzado: !colaVacia && loops >= maxLoops,
          ultimaRespuesta: vueltas[vueltas.length - 1] || null,
        };
      }

      async function abortIfLimited(stageName, result) {
        if (!result.maxLoopsAlcanzado) return false;

        const estadoActual = await hit('/alertas/estado-pipeline');
        const avisoAdmin = await enviarWhatsAppAdmin(
          [
            '*Ruralicos: pipeline diario detenido*',
            '',
            `Fase: ${stageName}`,
            `Limite: ${maxLoops} vueltas`,
            `Procesadas en esta fase: ${result.total}`,
            '',
            'No se ha preparado ni enviado el digest para evitar un envio incompleto.',
          ].join('\n')
        );

        res.status(409).json({
          success: false,
          mensaje: `Pipeline detenido: ${stageName} llego al limite de ${maxLoops} vueltas antes de vaciar la cola. No se prepara ni se envia el digest para evitar un envio incompleto.`,
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

      const repararPendientes = await hit('/alertas/reparar-pendientes-ia', 'POST');
      const clasificar = await runBatchedStep('clasificar', '/alertas/clasificar');
      if (await abortIfLimited('clasificar', clasificar)) return;
      const resumir = await runBatchedStep('resumir', '/alertas/resumir');
      if (await abortIfLimited('resumir', resumir)) return;
      const revisar = await runBatchedStep('revisar', '/alertas/revisar');
      if (await abortIfLimited('revisar', revisar)) return;
      const deduplicar = await hit('/alertas/deduplicar');
      const prepararDigest = await hit('/alertas/preparar-digest');
      const enviarDigest = await hit('/alertas/enviar-digest');
      const generarResumenFree = await hit('/alertas/generar-resumen-free');
      const enviarResumenFree = await hit('/alertas/enviar-resumen-free');
      const estadoFinal = await hit('/alertas/estado-pipeline');

      res.json({
        success: true,
        mensaje: 'Pipeline diario ejecutado con fases IA por lotes hasta vaciar cola',
        scrapers,
        repararPendientes: repararPendientes.body,
        clasificar,
        resumir,
        revisar,
        deduplicar: deduplicar.body,
        prepararDigest: prepararDigest.body,
        enviarDigest: enviarDigest.body,
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
