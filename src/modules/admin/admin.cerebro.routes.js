// src/modules/admin/admin.cerebro.routes.js
//
// Proxy admin-autenticado hacia el motor de aprendizaje determinista (/cerebro/*),
// que vive detras de checkCronToken. El panel solo tiene token de admin; aqui
// reenviamos al endpoint cron con el CRON_TOKEN del servidor (hitCronPath), sin
// exponer ese secreto al cliente. Los /cerebro/* aceptan GET, asi que el GET de
// hitCronPath basta tambien para las acciones (params por query string).

const { requireAdmin } = require('../../middleware/requireAdmin');
const { hitCronPath } = require('./admin.helpers');

function parseUserId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function proxyCron(res, path) {
  try {
    const body = await hitCronPath(path);
    return res.json(body);
  } catch (err) {
    console.error(`Error en proxy admin->${path}:`, err.message);
    return res.status(err.status || 500).json(err.body || { error: err.message });
  }
}

module.exports = (app, supabase) => {
  // Diagnostico de aprendizaje de un socio: perfil de intereses, memoria acumulada,
  // conversaciones/digests recientes y, si se pasa fecha, el radar semantico con
  // por que cada alerta pasa o no los filtros duros.
  app.get('/admin/cerebro/diagnostico/:userId', requireAdmin, async (req, res) => {
    const userId = parseUserId(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'userId invalido' });

    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
      ? `?fecha=${encodeURIComponent(req.query.fecha)}`
      : '';
    return proxyCron(res, `/cerebro/diagnostico/usuario/${userId}${fecha}`);
  });

  // Recalcula el perfil de intereses (embedding) del socio.
  app.post('/admin/cerebro/perfil/actualizar/:userId', requireAdmin, async (req, res) => {
    const userId = parseUserId(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'userId invalido' });
    return proxyCron(res, `/cerebro/perfil/actualizar/${userId}`);
  });

  // Genera (o solo previsualiza, por defecto) una pregunta de exploracion para el socio.
  app.post('/admin/cerebro/explorar/:userId', requireAdmin, async (req, res) => {
    const userId = parseUserId(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'userId invalido' });

    const dryRun = req.body?.dryRun !== false; // por seguridad, no envia WhatsApp salvo dryRun:false explicito
    const force = req.body?.force === true;
    return proxyCron(res, `/cerebro/explorar/${userId}?dryRun=${dryRun}&force=${force}`);
  });
};
