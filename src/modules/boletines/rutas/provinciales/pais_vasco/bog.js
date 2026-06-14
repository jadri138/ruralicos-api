const { checkCronToken } = require('../../../../../middleware/cronToken');
const {
  getFechaMadridISO,
  obtenerDocumentosBogConTexto,
} = require('../../../scrapers/provinciales/pais_vasco/bog/scraper');
const { insertarAlertasBoletin } = require('../../shared/insertarAlertasBoletin');

module.exports = function bogRoutes(app, supabase) {
  app.get('/scrape-bog-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
      ? req.query.fecha
      : getFechaMadridISO();

    try {
      const docs = await obtenerDocumentosBogConTexto(fecha);
      const insertadas = await insertarAlertasBoletin(supabase, docs, {
        fuente: 'BOG',
        region: 'Gipuzkoa',
      });

      return res.json({
        success: true,
        fecha,
        relevantes: docs.length,
        ...insertadas,
        mensaje: 'BOG procesado',
      });
    } catch (err) {
      console.error('Error en /scrape-bog-oficial', err);
      return res.status(500).json({ error: err.message });
    }
  });
};
