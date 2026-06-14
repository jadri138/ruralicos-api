// src/routes/bocce.js
//
// Scraper del BOCCE (Boletin Oficial de la Ciudad Autonoma de Ceuta).

const { checkCronToken } = require('../../../middleware/cronToken');
const { obtenerDocumentosBocceConTexto, getFechaHoyISO } = require('../scrapers/BOCCE/bocceScraper');
const { insertarAlertasBoletin } = require('./shared/insertarAlertasBoletin');

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'administracion publica', 'presidencia',
  'oposicion', 'concurso', 'proceso selectivo', 'bolsa de empleo',
  'aspirantes', 'relacion provisional', 'relacion definitiva',
  'nombramiento', 'cese', 'funcionario', 'personal laboral',
  'tribunal', 'juzgado', 'notaria', 'registro civil',
  'presupuesto', 'modificacion presupuestaria', 'modificacion de credito',
  'contratacion', 'licitacion', 'vehiculo', 'matrimonio civil',
  'padron', 'urbanismo',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'rural',
  'forest', 'monte', 'medio natural',
  'politica agricola comun', 'fega', 'feaga', 'feader',
  'regadio', 'regad', 'riego', 'agua',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'explotaci', 'pasto', 'pastos', 'forraje',
  'pesca', 'acuicultura',
  'industria agroalimentaria', 'agroalimentari',
  'medio ambiente', 'desarrollo rural',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some((k) => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some((k) => t.includes(normalizar(k)));
}

module.exports = function bocceRoutes(app, supabase) {
  async function scrapeBocce(req, res) {
    if (!checkCronToken(req, res)) return;

    try {
      const fecha = req.query.fecha ? String(req.query.fecha).slice(0, 10) : getFechaHoyISO();
      const docs = await obtenerDocumentosBocceConTexto(fecha, esRuralRelevante);

      if (!docs.length) {
        return res.json({
          success: true,
          fecha,
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          mensaje: 'No hay boletines BOCCE relevantes en esta fecha',
        });
      }

      const { nuevas, duplicadas, errores } = await insertarAlertasBoletin(supabase, docs, {
        fuente: 'BOCCE',
        region: 'Ceuta',
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        fecha,
        relevantes: docs.length,
        nuevas,
        duplicadas,
        errores,
        mensaje: 'BOCCE procesado',
      });
    } catch (e) {
      console.error('Error en /scrape-bocce', e);
      return res.status(500).json({ error: e.message });
    }
  }

  app.get('/scrape-bocce-oficial', scrapeBocce);
  app.get('/scrape-bocce', scrapeBocce);
};
