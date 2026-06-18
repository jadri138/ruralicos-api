// src/routes/boib.js
//
// Scraper del BOIB (Boletin Oficial de las Illes Balears).
// Cron recomendado: dias laborables a partir de las 08:30h.

const { checkCronToken } = require('../../../middleware/cronToken');
const { obtenerDocumentosBoibConTexto, getFechaHoyISO } = require('../scrapers/BOIB/boibScraper');
const { procesarBoletinPreclasificado } = require('./shared/procesarBoletinPreclasificado');

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'ajuntament', 'consell insular',
  'presupuesto', 'pressupost', 'modificacion de credito', 'modificacio de credit',
  'recurso contencioso', 'tribunal superior',
  'oposicion', 'concurs', 'bolsa', 'borsa',
  'nombramiento', 'nomenament', 'funcionario', 'funcionari', 'interino', 'interi', 'cese',
  'ordenanza fiscal', 'taxi', 'turismo', 'hotel',
];

const INCLUIR_RURAL = [
  'agricultur', 'ramader', 'ganader', 'agrari', 'agroalimentari', 'rural',
  'forest', 'monte', 'mont', 'medio natural', 'medi natural',
  'politica agricola comun', 'pac', 'fega', 'feaga', 'feader',
  'solicitud unica', 'sol.licitud unica', 'subvenciones agrarias', 'ajudes agraries',
  'regadio', 'regadiu', 'regad', 'riego', 'aigua agricola',
  'fitosanit', 'zoosanit', 'sanidad animal', 'sanitat animal', 'plaga',
  'vitivinicol', 'vino', 'vinedo', 'vinya', 'olivar', 'ametller', 'garrover',
  'cereal', 'forraje', 'farratge', 'pasto', 'pastura', 'explotaci',
  'denominacion de origen', 'denominacio d origen', 'indicacion geografica',
  'calidad alimentaria', 'qualitat alimentaria',
  'industria agroalimentaria',
  'conselleria de agricultura', 'conselleria d agricultura',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some((k) => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some((k) => t.includes(normalizar(k)));
}

module.exports = function boibRoutes(app, supabase) {
  async function scrapeBoib(req, res) {
    if (!checkCronToken(req, res)) return;

    try {
      const fecha = req.query.fecha ? String(req.query.fecha).slice(0, 10) : null;
      const docs = await obtenerDocumentosBoibConTexto(fecha, esRuralRelevante);

      if (!docs.length) {
        return res.json({
          success: true,
          fecha: fecha || getFechaHoyISO(),
          totales: 0,
          documentos_insertables: 0,
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          saltadasFiltro: 0,
          mensaje: 'No hay disposiciones BOIB en el ultimo boletin',
        });
      }

      const stats = await procesarBoletinPreclasificado(supabase, docs, {
        fuente: 'BOIB',
        region: 'Illes Balears',
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        fecha: docs[0]?.fecha || fecha,
        ...stats,
        mensaje: 'BOIB procesado (captura bruta + filtro rural)',
      });
    } catch (e) {
      console.error('Error en /scrape-boib', e);
      return res.status(500).json({ error: e.message });
    }
  }

  app.get('/scrape-boib-oficial', scrapeBoib);
  app.get('/scrape-boib', scrapeBoib);
};
