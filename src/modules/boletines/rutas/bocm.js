// src/routes/bocm.js
//
// Scraper del BOCM (Boletín Oficial de la Comunidad de Madrid).
// Cron recomendado: días laborables a partir de las 08:30h.

const { checkCronToken } = require('../../../middleware/cronToken');
const { obtenerDocumentosBocmConTexto, getFechaHoyISO } = require('../scrapers/BOCM/bocmScraper');
const { procesarBoletinPreclasificado } = require('./shared/procesarBoletinPreclasificado');

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'mancomunidad', 'municipio',
  'presupuesto municipal', 'modificacion presupuestaria',
  'recurso contencioso', 'tribunal superior',
  'edicto', 'notificacion', 'recaudacion ejecutiva', 'providencia de apremio',
  'padron municipal', 'empadronamiento',
  'oposicion', 'convocatoria de pruebas selectivas', 'lista definitiva', 'lista provisional',
  'nombramiento', 'funcionario', 'interino', 'cese',
  'vehiculos', 'taxi', 'metro', 'urbanismo',
  'instalacion electrica', 'instalacion fotovoltaica', 'alta tension',
  'transicion energetica', 'economia circular',
  'canal de isabel ii',
  'modificacion presupuestaria',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'agroalimentari', 'rural',
  'forest', 'monte', 'sierra', 'medio natural',
  'politica agricola comun', 'pac', 'feader', 'fega', 'feaga',
  'regadio', 'regad', 'riego', 'canal',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'vino', 'viticultur', 'vinedo', 'olivar', 'cereal',
  'pasto', 'praderia', 'explotaci',
  'denominacion de origen', 'calidad alimentaria',
  'industria agroalimentaria',
  'consejeria de medio ambiente, agricultura',
  'medio ambiente, agricultura',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some((k) => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some((k) => t.includes(normalizar(k)));
}

module.exports = function bocmRoutes(app, supabase) {
  async function scrapeBocm(req, res) {
    if (!checkCronToken(req, res)) return;

    try {
      const fecha = req.query.fecha ? String(req.query.fecha).slice(0, 10) : null;
      const docs = await obtenerDocumentosBocmConTexto(fecha, esRuralRelevante);

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
          mensaje: 'No hay disposiciones BOCM en el último boletín',
        });
      }

      const stats = await procesarBoletinPreclasificado(supabase, docs, {
        fuente: 'BOCM',
        region: 'Comunidad de Madrid',
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        fecha: docs[0]?.fecha || fecha,
        ...stats,
        mensaje: 'BOCM procesado (captura bruta + filtro rural)',
      });
    } catch (e) {
      console.error('Error en /scrape-bocm', e);
      return res.status(500).json({ error: e.message });
    }
  }

  app.get('/scrape-bocm-oficial', scrapeBocm);
  app.get('/scrape-bocm', scrapeBocm);
};
