// src/routes/dogv.js
//
// Scraper del DOGV (Diari Oficial de la Generalitat Valenciana).
// Cron recomendado: días laborables a las 11:00–12:00h.

const { checkCronToken } = require('../../../middleware/cronToken');
const { obtenerDocumentosDogvConTexto, getFechaHoyISO } = require('../scrapers/DOGV/dogvScraper');
const { procesarBoletinPreclasificado } = require('./shared/procesarBoletinPreclasificado');

// ─────────────────────────────────────────────
// Filtro de relevancia rural
// ─────────────────────────────────────────────
function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'ajuntament', 'diputacio', 'diputacion',
  'pressupost', 'presupuesto', 'modificacio de credits',
  'recurso contencioso', 'tribunal superior',
  'edicto', 'edicte', 'oposicion', 'oposicio',
  'universidad', 'universitat', 'escola', 'escuela',
  'nombramiento', 'cese',
];

const INCLUIR_RURAL = [
  'agricultur', 'ramader', 'ganader', 'agrari', 'rural',
  'forest', 'pac', 'fega',
  'ayuda', 'ajuda', 'subvenci', 'bases reguladoras',
  'regadiu', 'regad', 'riego', 'agua', 'regant',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'caza', 'caca', 'mont', 'aprofitament', 'aprovechamiento',
  'vitivinicol', 'vinya', 'viñedo', 'olivar', 'fruiter', 'frutal',
  'cereal', 'forraje', 'farratge', 'bestiar', 'explotaci',
  'produccion agricola', 'produccio agricola',
  'denominacion de origen', 'denominacio d\'origen',
  'pesca', 'acuicultura',
  'conselleria de agricultura',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some(k => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some(k => t.includes(normalizar(k)));
}

// ─────────────────────────────────────────────
// Ruta
// ─────────────────────────────────────────────
module.exports = function dogvRoutes(app, supabase) {
  app.get('/scrape-dogv', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const fechaHoy = getFechaHoyISO();
      const docs     = await obtenerDocumentosDogvConTexto(fechaHoy, esRuralRelevante);

      if (!docs.length) {
        return res.json({
          success: true,
          fecha: fechaHoy,
          totales: 0, documentos_insertables: 0,
          nuevas: 0, duplicadas: 0, errores: 0, saltadasFiltro: 0,
          mensaje: 'No hay disposiciones DOGV hoy (festivo o fin de semana)',
        });
      }

      const stats = await procesarBoletinPreclasificado(supabase, docs, {
        fuente: 'DOGV',
        region: 'Comunitat Valenciana',
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        fecha: fechaHoy,
        ...stats,
        mensaje: 'DOGV procesado (captura bruta + filtro rural)',
      });
    } catch (e) {
      console.error('Error en /scrape-dogv', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
