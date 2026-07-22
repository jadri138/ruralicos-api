const { checkCronToken } = require('../../../../../middleware/cronToken');
const { getFechaMadridISO } = require('../../../../../shared/fechaMadrid');
const {
  BOPZ_STATE,
  clasificarErrorBopz,
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

function construirRespuestaBopz(docs = [], stats = {}, fuente = 'BOPZ') {
  const diagnostics = docs.scrape_diagnostics || {
    state: docs.length > 0 ? BOPZ_STATE.SUCCESS : BOPZ_STATE.NO_PUBLICATION,
  };
  const warningCount = Number(diagnostics.detail_errors || 0)
    + Number(diagnostics.documents_truncated || 0);
  return {
    success: true,
    ...stats,
    scrape_state: diagnostics.state,
    scrape_warning_count: warningCount,
    scrape_diagnostics: diagnostics,
    mensaje: docs.length === 0
      ? `No hay boletin ${fuente} para la fecha objetivo (sin publicacion o festivo)`
      : diagnostics.state === BOPZ_STATE.PARTIAL_RECOVERY
        ? `${fuente} procesado con recuperacion parcial de detalles`
        : `${fuente} procesado (captura bruta + filtro provincial)`,
  };
}

function construirErrorBopz(error) {
  const classified = clasificarErrorBopz(error);
  return {
    status: classified.state === BOPZ_STATE.TIMEOUT ? 504 : 502,
    body: {
      success: false,
      error: error.message,
      error_code: error.code || classified.code,
      scrape_state: classified.state,
      errores: 1,
      retryable: false,
      scrape_diagnostics: error.scrape_diagnostics || null,
    },
  };
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

      if (config.fuente === 'BOPZ') {
        return res.json({
          fecha,
          ...construirRespuestaBopz(docs, stats, config.fuente),
        });
      }

      // Mensaje explicito cuando no hay documentos: permite al evaluador de
      // calidad distinguir "sin publicacion" (normal) de "parseo roto" (warning).
      const mensaje = docs.length === 0
        ? `No hay boletín ${config.fuente} para ${fecha} (sin publicación o festivo)`
        : `${config.fuente} procesado (captura bruta + filtro provincial)`;

      return res.json({
        success: true,
        fecha,
        ...stats,
        mensaje,
      });
    } catch (err) {
      console.error(`Error en ${config.path}`, err);
      if (config.fuente === 'BOPZ') {
        const response = construirErrorBopz(err);
        return res.status(response.status).json(response.body);
      }
      return res.status(500).json({ error: err.message });
    }
  }

  app.get(config.path, handler);
}

function bopAragonRoutes(app, supabase) {
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
}

module.exports = bopAragonRoutes;
module.exports.__testing = {
  construirErrorBopz,
  construirRespuestaBopz,
};
