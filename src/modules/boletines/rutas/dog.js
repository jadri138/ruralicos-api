// src/routes/dog.js
//
// Scraper del DOG (Diario Oficial de Galicia).
// Cron recomendado: días laborables a las 10:00h.

const { checkCronToken } = require('../../../middleware/cronToken');
const { obtenerDocumentosDogConTexto, getFechaHoyISO } = require('../scrapers/DOG/dogScraper');
const { procesarBoletinPreclasificado } = require('./shared/procesarBoletinPreclasificado');

// ─────────────────────────────────────────────
// Filtro de relevancia rural
// ─────────────────────────────────────────────
function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'concello', 'diputacion', 'deputacion',
  'presupuesto', 'orzamento',
  'recurso contencioso', 'tribunal superior',
  'edicto', 'edicte', 'oposicion', 'oposicions',
  'universidad', 'universidade', 'escola', 'escuela',
  'nombramiento', 'cese', 'sustitucion',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'ganderi', 'agrari', 'rural',
  'forest', 'monte', 'pac', 'fega',
  'ayuda', 'axuda', 'subvenci', 'bases reguladoras',
  'regadio', 'regad', 'riego', 'agua', 'auga',
  'fitosanit', 'zoosanit', 'sanidad animal', 'sanidade animal', 'plaga', 'praga',
  'caza', 'caca', 'aprovechamiento', 'aproveitamento',
  'vitivinicol', 'vino', 'vinu', 'viñedo', 'olivar', 'frutal',
  'cereal', 'forraje', 'pasto', 'explotaci',
  'denominacion de orixe', 'denominacion de origen',
  'calidade alimentaria', 'calidad alimentaria',
  'pesca', 'acuicultura', 'marisqu',
  'conselleria do medio rural', 'conselleria de medio rural',
  'agencia gallega de la calidad alimentaria',
  'instituto galego da calidade',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some(k => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some(k => t.includes(normalizar(k)));
}

// ─────────────────────────────────────────────
// Ruta
// ─────────────────────────────────────────────
module.exports = function dogRoutes(app, supabase) {
  app.get('/scrape-dog', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const fechaHoy = getFechaHoyISO();
      const docs     = await obtenerDocumentosDogConTexto(fechaHoy, esRuralRelevante);

      if (!docs.length) {
        return res.json({
          success: true,
          fecha: fechaHoy,
          totales: 0, documentos_insertables: 0,
          nuevas: 0, duplicadas: 0, errores: 0, saltadasFiltro: 0,
          mensaje: 'No hay disposiciones DOG hoy (festivo o fin de semana)',
        });
      }

      const stats = await procesarBoletinPreclasificado(supabase, docs, {
        fuente: 'DOG',
        region: 'Galicia',
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        fecha: fechaHoy,
        ...stats,
        mensaje: 'DOG procesado (captura bruta + filtro rural)',
      });
    } catch (e) {
      console.error('Error en /scrape-dog', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
