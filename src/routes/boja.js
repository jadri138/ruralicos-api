// src/routes/boja.js
//
// Scraper del BOJA (Boletín Oficial de la Junta de Andalucía).
// Usa la API oficial REST — el texto de cada disposición llega directamente
// en el campo bodyNoHtml, sin necesidad de descargar PDFs.
//
// Cron recomendado: días laborables a las 10:00–11:00h (el BOJA
// se publica normalmente entre las 08:00 y las 10:00h de lunes a viernes).

const { checkCronToken } = require('../middleware/cronToken');
const { getFechaHoyYYYYMMDD, obtenerDocumentosBojaPorFecha } = require('../boletines/BOJA/bojaScraper');
const { insertarAlertasBoletin } = require('./boletines/shared/insertarAlertasBoletin');

// ─────────────────────────────────────────────
// Filtro de relevancia rural
// ─────────────────────────────────────────────
function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'boletin oficial de la provincia',
  'ayuntamiento', 'diputacion',
  'presupuesto', 'modificacion de creditos',
  'recurso contencioso', 'tribunal superior de justicia',
  'edicto', 'nombramiento', 'oposicion',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'rural',
  'forest', 'pac', 'fega',
  'ayuda', 'subvenc', 'bases reguladoras',
  'regad', 'riego', 'agua', 'regante',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'caza', 'monte', 'aprovechamiento',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some(k => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some(k => t.includes(normalizar(k)));
}

// ─────────────────────────────────────────────
// Ruta
// ─────────────────────────────────────────────
module.exports = function bojaRoutes(app, supabase) {
  app.get('/scrape-boja-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    let saltadasFiltro = 0;

    try {
      const fechaHoy = getFechaHoyYYYYMMDD();
      const docs     = await obtenerDocumentosBojaPorFecha(fechaHoy);

      if (!docs.length) {
        return res.json({
          success: true,
          totales: 0, documentos_insertables: 0,
          nuevas: 0, duplicadas: 0, errores: 0, saltadasFiltro: 0,
          mensaje: 'No hay boletín BOJA publicado hoy (festivo o fin de semana)',
        });
      }

      const docsInsertables = [];
      for (const doc of docs) {
        // Filtro rural: texto + título + sección + organismo
        const bolsa = [doc.texto.slice(0, 3500), doc.titulo, doc.seccion, doc.organismo].join(' ');
        if (!esRuralRelevante(bolsa)) {
          saltadasFiltro++;
          continue;
        }

        docsInsertables.push(doc);
      }

      const { nuevas, duplicadas, errores } = await insertarAlertasBoletin(supabase, docsInsertables, {
        fuente: 'BOJA',
        region: 'Andalucía',
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        totales:                docs.length,
        documentos_insertables: docs.length - saltadasFiltro,
        nuevas,
        duplicadas,
        errores,
        saltadasFiltro,
        mensaje: 'BOJA procesado (API oficial Junta de Andalucía + filtro rural)',
      });
    } catch (e) {
      console.error('Error en /scrape-boja-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
