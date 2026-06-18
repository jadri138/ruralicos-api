const { checkCronToken } = require('../../../../../middleware/cronToken');
const {
  getFechaMadridISO,
  obtenerDocumentosBogConTexto,
} = require('../../../scrapers/provinciales/pais_vasco/bog/scraper');
const { procesarBoletinPreclasificado } = require('../../shared/procesarBoletinPreclasificado');

module.exports = function bogRoutes(app, supabase) {
  app.get('/scrape-bog-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
      ? req.query.fecha
      : getFechaMadridISO();

    try {
      // docs incluye TODOS los detectados, anotados con `_relevante` (captura bruta).
      const docs = await obtenerDocumentosBogConTexto(fecha);
      const stats = await procesarBoletinPreclasificado(supabase, docs, {
        fuente: 'BOG',
        region: 'Gipuzkoa',
      });

      return res.json({
        success: true,
        fecha,
        ...stats,
        mensaje: 'BOG procesado (captura bruta + filtro provincial)',
      });
    } catch (err) {
      console.error('Error en /scrape-bog-oficial', err);
      return res.status(500).json({ error: err.message });
    }
  });
};
