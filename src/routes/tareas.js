// src/routes/tareas.js
const { checkCronToken } = require('../utils/checkCronToken');
const { enviarWhatsAppAdmin } = require('../whatsapp');

module.exports = function tareasRoutes(app, supabase) {
  app.get('/tareas/pipeline-diario', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const baseUrl =
        process.env.PUBLIC_BASE_URL || 'http://localhost:' + (process.env.PORT || 3000);
      const token = process.env.CRON_TOKEN;
      const maxLoops = Number(process.env.PIPELINE_MAX_LOOPS || 40);
      const stepDelayMs = Number(process.env.PIPELINE_STEP_DELAY_MS || 800);
      const scrapePaths = (
        process.env.PIPELINE_SCRAPE_PATHS ||
        [
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
        ].join(',')
      )
        .split(',')
        .map((path) => path.trim())
        .filter(Boolean);

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      async function hit(path, method = 'GET') {
        const url = `${baseUrl}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
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
