// src/routes/dogc.js
//
// Scraper del DOGC (Diari Oficial de la Generalitat de Catalunya).
// Cron recomendado: días laborables a las 10:00–11:00h.

const { checkCronToken } = require('../../../middleware/cronToken');
const { obtenerDocumentosDogcConTexto, getFechaHoyISO } = require('../scrapers/DOGC/dogcScraper');
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
  'recurs contenciós', 'tribunal superior de justicia',
  'edicte', 'edicto', 'oposicio', 'oposicion',
  'universitat', 'universidad', 'escola', 'escuela',
];

const INCLUIR_RURAL = [
  'agricultur', 'ramader', 'ganader', 'agrari', 'rural',
  'forest', 'pac', 'fega',
  'ajuda', 'ayuda', 'subvenci', 'subvenc', 'bases reguladores',
  'regadiu', 'regad', 'riego', 'aigua', 'agua', 'regant',
  'fitosanit', 'zoosanit', 'sanitat animal', 'sanidad animal', 'plaga',
  'caca', 'caza', 'mont', 'aprofitament', 'aprovechamiento',
  'vitivinicola', 'vinya', 'viñedo', 'olivar', 'fruiter', 'frutal',
  'cereal', 'farratge', 'forraje', 'bestiar', 'explotaci',
  'produccio agricola', 'produccion agricola',
  'denominaci d\'origen', 'denominacion de origen',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some(k => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some(k => t.includes(normalizar(k)));
}

// ─────────────────────────────────────────────
// Ruta
// ─────────────────────────────────────────────
module.exports = function dogcRoutes(app, supabase) {
  app.get('/scrape-dogc', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const fechaHoy = getFechaHoyISO();
      // docs incluye TODOS los detectados, anotados con `_relevante` (captura bruta).
      const docs     = await obtenerDocumentosDogcConTexto(fechaHoy, esRuralRelevante);

      if (!docs.length) {
        return res.json({
          success: true,
          fecha: fechaHoy,
          totales: 0, documentos_insertables: 0,
          nuevas: 0, duplicadas: 0, errores: 0, saltadasFiltro: 0,
          mensaje: 'No hay disposiciones DOGC hoy (festivo o fin de semana)',
        });
      }

      const stats = await procesarBoletinPreclasificado(supabase, docs, {
        fuente: 'DOGC',
        region: 'Catalunya',
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        fecha: fechaHoy,
        ...stats,
        mensaje: 'DOGC procesado (Socrata + captura bruta + filtro rural)',
      });
    } catch (e) {
      console.error('Error en /scrape-dogc', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
