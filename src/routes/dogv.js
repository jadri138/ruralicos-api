// src/routes/dogv.js
//
// Scraper del DOGV (Diari Oficial de la Generalitat Valenciana).
// Cron recomendado: días laborables a las 11:00–12:00h.

const { checkCronToken } = require('../utils/checkCronToken');
const { obtenerDocumentosDogvConTexto, getFechaHoyISO } = require('../boletines/DOGV/dogvScraper');
const { insertarAlertasBoletin } = require('./boletines/shared/insertarAlertasBoletin');

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
          nuevas: 0, duplicadas: 0, errores: 0,
          mensaje: 'No hay disposiciones DOGV relevantes hoy',
        });
      }

      const { nuevas, duplicadas, errores } = await insertarAlertasBoletin(supabase, docs, {
        fuente: 'DOGV',
        region: 'Comunitat Valenciana',
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        fecha: fechaHoy,
        relevantes: docs.length,
        nuevas,
        duplicadas,
        errores,
        mensaje: 'DOGV procesado',
      });
    } catch (e) {
      console.error('Error en /scrape-dogv', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
