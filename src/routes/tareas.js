// src/routes/tareas.js
const { checkCronToken } = require('../utils/checkCronToken');

module.exports = function tareasRoutes(app, supabase) {
  app.get('/tareas/pipeline-diario', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const baseUrl =
        process.env.PUBLIC_BASE_URL || 'http://localhost:' + (process.env.PORT || 3000);
      const token = process.env.CRON_TOKEN;
      const scrapePaths = (process.env.PIPELINE_SCRAPE_PATHS || '/scrape-boe-oficial,/scrape-dogc')
        .split(',')
        .map((path) => path.trim())
        .filter(Boolean);

      async function hit(path) {
        const url = `${baseUrl}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
        const response = await fetch(url);

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

      const scrapers = [];
      for (const path of scrapePaths) {
        scrapers.push(await hit(path));
      }

      const clasificar = await hit('/alertas/clasificar');
      const resumir = await hit('/alertas/resumir');
      const revisar = await hit('/alertas/revisar');
      const deduplicar = await hit('/alertas/deduplicar');
      const prepararDigest = await hit('/alertas/preparar-digest');
      const enviarDigest = await hit('/alertas/enviar-digest');
      const generarResumenFree = await hit('/alertas/generar-resumen-free');
      const enviarResumenFree = await hit('/alertas/enviar-resumen-free');

      res.json({
        success: true,
        mensaje: 'Pipeline diario ejecutado con flujo digest actual',
        scrapers,
        clasificar: clasificar.body,
        resumir: resumir.body,
        revisar: revisar.body,
        deduplicar: deduplicar.body,
        prepararDigest: prepararDigest.body,
        enviarDigest: enviarDigest.body,
        generarResumenFree: generarResumenFree.body,
        enviarResumenFree: enviarResumenFree.body,
      });
    } catch (err) {
      console.error('Error en /tareas/pipeline-diario', err);
      res.status(500).json({ error: err.message });
    }
  });
};
