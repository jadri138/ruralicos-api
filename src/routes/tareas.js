// src/routes/tareas.js
const { checkCronToken } = require('../utils/checkCronToken');

module.exports = function tareasRoutes(app, supabase) {
  app.get('/tareas/pipeline-diario', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const baseUrl =
        process.env.PUBLIC_BASE_URL || 'http://localhost:' + (process.env.PORT || 3000);
      const token = process.env.CRON_TOKEN;

      // 1) Actualizar BOE
      await fetch(`${baseUrl}/boe/actualizar?token=${token}`);

      // 2) Procesar con IA
      await fetch(`${baseUrl}/alertas/procesar-ia?token=${token}`);

      // 3) Enviar WhatsApp
      await fetch(`${baseUrl}/alertas/enviar-whatsapp?token=${token}`);

      res.json({
        success: true,
        mensaje: 'Pipeline diario ejecutado (boe -> ia -> whatsapp)',
      });
    } catch (err) {
      console.error('Error en /tareas/pipeline-diario', err);
      res.status(500).json({ error: err.message });
    }
  });
};
