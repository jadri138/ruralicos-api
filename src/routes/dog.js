// src/routes/dog.js
//
// Scraper del DOG (Diario Oficial de Galicia).
// Cron recomendado: días laborables a las 10:00h.

const { checkCronToken } = require('../utils/checkCronToken');
const { obtenerDocumentosDogConTexto, getFechaHoyISO } = require('../boletines/DOG/dogScraper');

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

    let nuevas     = 0;
    let duplicadas = 0;
    let errores    = 0;

    try {
      const fechaHoy = getFechaHoyISO();
      const docs     = await obtenerDocumentosDogConTexto(fechaHoy, esRuralRelevante);

      if (!docs.length) {
        return res.json({
          success: true,
          fecha: fechaHoy,
          nuevas: 0, duplicadas: 0, errores: 0,
          mensaje: 'No hay disposiciones DOG relevantes hoy',
        });
      }

      for (const doc of docs) {
        if (!doc.url) { errores++; continue; }

        const { data: existe, error: errDup } = await supabase
          .from('alertas').select('id').eq('url', doc.url).limit(1);
        if (errDup) { errores++; continue; }
        if (existe && existe.length > 0) { duplicadas++; continue; }

        const { error: errInsert } = await supabase.from('alertas').insert([{
          titulo:    doc.titulo,
          resumen:   'Procesando con IA...',
          url:       doc.url,
          fecha:     doc.fecha,
          region:    'Galicia',
          fuente:    'DOG',
          contenido: doc.texto,
        }]);

        if (errInsert) {
          console.error('[DOG] Error insertando:', doc.url, errInsert.message);
          errores++;
          continue;
        }
        nuevas++;
      }

      return res.json({
        success: true,
        fecha: fechaHoy,
        relevantes: docs.length,
        nuevas,
        duplicadas,
        errores,
        mensaje: 'DOG procesado',
      });
    } catch (e) {
      console.error('Error en /scrape-dog', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
