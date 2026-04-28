// src/routes/tareas.js
const { checkCronToken } = require('../utils/checkCronToken');

module.exports = function tareasRoutes(app, supabase) {
  app.get('/tareas/pipeline-diario', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const baseUrl =
        process.env.PUBLIC_BASE_URL || 'http://localhost:' + (process.env.PORT || 3000);
      const token = process.env.CRON_TOKEN;

      // 1) Actualizar fuentes
      await fetch(`${baseUrl}/boe/actualizar?token=${token}`);
      await fetch(`${baseUrl}/scrape-dogc?token=${token}`);
      await fetch(`${baseUrl}/scrape-dogv?token=${token}`);

      // 2) Procesar con IA (clasifica y resume, pone estado_ia = 'listo')
      await fetch(`${baseUrl}/alertas/procesar-ia?token=${token}`);

      // 3) Deduplicar (marca duplicados cross-boletín como estado_ia = 'duplicado')
      await fetch(`${baseUrl}/alertas/deduplicar?token=${token}`);

      // 4) Enviar WhatsApp a usuarios free
      await fetch(`${baseUrl}/alertas/enviar-whatsapp?token=${token}`);

      res.json({
        success: true,
        mensaje: 'Pipeline diario ejecutado (boe -> ia -> deduplicar -> whatsapp)',
      });
    } catch (err) {
      console.error('Error en /tareas/pipeline-diario', err);
      res.status(500).json({ error: err.message });
    }
  });
};
