// src/routes/dogc.js
//
// Scraper del DOGC (Diari Oficial de la Generalitat de Catalunya).
// Cron recomendado: días laborables a las 10:00–11:00h.

const { checkCronToken } = require('../utils/checkCronToken');
const { obtenerDocumentosDogcConTexto, getFechaHoyISO } = require('../boletines/DOGC/dogcScraper');

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

    let nuevas         = 0;
    let duplicadas     = 0;
    let errores        = 0;
    let saltadasFiltro = 0;

    try {
      const fechaHoy = getFechaHoyISO();
      const docs     = await obtenerDocumentosDogcConTexto(fechaHoy, esRuralRelevante);

      // docs ya llegan pre-filtrados por esRuralRelevante
      // saltadasFiltro se calcula en el scraper implícitamente
      // aquí solo gestionamos inserción

      if (!docs.length) {
        return res.json({
          success: true,
          fecha: fechaHoy,
          nuevas: 0, duplicadas: 0, errores: 0,
          mensaje: 'No hay disposiciones DOGC relevantes hoy',
        });
      }

      for (const doc of docs) {
        // Duplicado por URL
        const { data: existe, error: errDup } = await supabase
          .from('alertas').select('id').eq('url', doc.url).limit(1);
        if (errDup) { errores++; continue; }
        if (existe && existe.length > 0) { duplicadas++; continue; }

        const { error: errInsert } = await supabase.from('alertas').insert([{
          titulo:    doc.titulo,
          resumen:   'Procesando con IA...',
          url:       doc.url,
          fecha:     doc.fecha,
          region:    'Catalunya',
          fuente:    'DOGC',
          contenido: doc.texto,
        }]);

        if (errInsert) {
          console.error('[DOGC] Error insertando:', doc.url, errInsert.message);
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
        mensaje: 'DOGC procesado (Socrata + texto HTML)',
      });
    } catch (e) {
      console.error('Error en /scrape-dogc', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
