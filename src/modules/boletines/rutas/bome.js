// src/routes/bome.js
//
// Scraper del BOME (Boletin Oficial de la Ciudad Autonoma de Melilla).

const { checkCronToken } = require('../../../middleware/cronToken');
const { obtenerDocumentosBomeConTexto, getFechaHoyISO } = require('../scrapers/BOME/bomeScraper');
const { procesarBoletinPreclasificado } = require('./shared/procesarBoletinPreclasificado');

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'administracion publica', 'presidencia e igualdad',
  'oposicion', 'concurso', 'provision de un puesto', 'aspirantes',
  'relacion provisional', 'relacion definitiva', 'nombramiento', 'cese',
  'funcionario', 'personal directivo', 'tribunal', 'juzgado',
  'presupuesto', 'modificacion de credito', 'contratacion',
  'vehiculo', 'matrimonio civil',
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

module.exports = function bomeRoutes(app, supabase) {
  async function scrapeBome(req, res) {
    if (!checkCronToken(req, res)) return;

    try {
      const fecha = req.query.fecha ? String(req.query.fecha).slice(0, 10) : getFechaHoyISO();
      const docs = await obtenerDocumentosBomeConTexto(fecha, esRuralRelevante);

      if (!docs.length) {
        return res.json({
          success: true,
          fecha,
          totales: 0,
          documentos_insertables: 0,
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          saltadasFiltro: 0,
          mensaje: 'No hay disposiciones BOME en esta fecha',
        });
      }

      const stats = await procesarBoletinPreclasificado(supabase, docs, {
        fuente: 'BOME',
        region: 'Melilla',
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        fecha,
        ...stats,
        mensaje: 'BOME procesado (captura bruta + filtro rural)',
      });
    } catch (e) {
      console.error('Error en /scrape-bome', e);
      return res.status(500).json({ error: e.message });
    }
  }

  app.get('/scrape-bome-oficial', scrapeBome);
  app.get('/scrape-bome', scrapeBome);
};
