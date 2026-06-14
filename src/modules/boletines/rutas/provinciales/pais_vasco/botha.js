const { checkCronToken } = require('../../../../../middleware/cronToken');
const { esRuralRelevante } = require('../../../scrapers/shared/ruralFilter');
const {
  getFechaHoyISO,
  obtenerDocumentosBothaConTexto,
} = require('../../../scrapers/provinciales/pais_vasco/botha/scraper');
const { insertarAlertasBoletin } = require('../../shared/insertarAlertasBoletin');

module.exports = function bothaRoutes(app, supabase) {
  async function scrapeBotha(req, res) {
    if (!checkCronToken(req, res)) return;

    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaHoyISO();

      const docs = await obtenerDocumentosBothaConTexto(fecha, esRuralRelevante);
      const insertadas = await insertarAlertasBoletin(supabase, docs, {
        fuente: 'BOTHA',
        region: 'Álava',
      });

      return res.json({
        success: true,
        fecha,
        relevantes: docs.length,
        ...insertadas,
        mensaje: 'BOTHA procesado',
      });
    } catch (err) {
      console.error('Error en /scrape-botha-oficial', err);
      return res.status(500).json({ error: err.message });
    }
  }

  app.get('/scrape-botha-oficial', scrapeBotha);
  app.get('/scrape-botha', scrapeBotha);
};
