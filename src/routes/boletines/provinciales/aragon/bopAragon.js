const { checkCronToken } = require('../../../../utils/checkCronToken');
const { getFechaMadridISO } = require('../../../../utils/fechaMadrid');
const {
  obtenerDocumentosBopzConTexto,
  obtenerDocumentosBophConTexto,
  obtenerDocumentosBoptConTexto,
} = require('../../../../boletines/provinciales/aragon/scraper');
const { insertarAlertasBoletin } = require('../../shared/insertarAlertasBoletin');

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
      const docs = await config.obtener(fecha);
      const insertadas = await insertarAlertasBoletin(supabase, docs, {
        fuente: config.fuente,
        region: config.region,
      });

      return res.json({
        success: true,
        fecha,
        relevantes: docs.length,
        ...insertadas,
        mensaje: `${config.fuente} procesado`,
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
