const { checkCronToken } = require('../../../../../middleware/cronToken');
const { getFechaMadridISO } = require('../../../../../shared/fechaMadrid');
const {
  obtenerDocumentosBopzConTexto,
  obtenerDocumentosBophConTexto,
  obtenerDocumentosBoptConTexto,
} = require('../../../scrapers/provinciales/aragon/scraper');
const { procesarBoletinPreclasificado } = require('../../shared/procesarBoletinPreclasificado');

function fechaObjetivo(req) {
  return /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
    ? req.query.fecha
    : getFechaMadridISO();
}

function registrarScraper(app, supabase, config) {
  async function handler(req, res) {
    if (!checkCronToken(req, res)) return;

    const fecha = fechaObjetivo(req);
    try {
      // docs incluye TODOS los detectados, anotados con `_relevante` (captura bruta).
      const docs = await config.obtener(fecha);
      const stats = await procesarBoletinPreclasificado(supabase, docs, {
        fuente: config.fuente,
        region: config.region,
      });

      return res.json({
        success: true,
        fecha,
        ...stats,
        mensaje: `${config.fuente} procesado (captura bruta + filtro provincial)`,
      });
    } catch (err) {
      console.error(`Error en ${config.path}`, err);
      return res.status(500).json({ error: err.message });
    }
  }

  app.get(config.path, handler);
}

module.exports = function bopAragonRoutes(app, supabase) {
  registrarScraper(app, supabase, {
    path: '/scrape-bopz-oficial',
    fuente: 'BOPZ',
    region: 'Zaragoza',
    obtener: obtenerDocumentosBopzConTexto,
  });

  registrarScraper(app, supabase, {
    path: '/scrape-boph-oficial',
    fuente: 'BOPH',
    region: 'Huesca',
    obtener: obtenerDocumentosBophConTexto,
  });

  registrarScraper(app, supabase, {
    path: '/scrape-bopt-oficial',
    fuente: 'BOPT',
    region: 'Teruel',
    obtener: obtenerDocumentosBoptConTexto,
  });
};
