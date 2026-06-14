const { checkCronToken } = require('../middleware/cronToken');
const { getFechaHoyYYYYMMDD, obtenerDocumentosDocmPorFecha } = require('../boletines/DOCM/docmScraper');
const { insertarAlertasBoletin } = require('./boletines/shared/insertarAlertasBoletin');

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'diputacion', 'presupuesto',
  'recurso contencioso', 'edicto', 'nombramiento',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'rural',
  'forest', 'pac', 'ayuda', 'subvenc', 'bases reguladoras',
  'regad', 'riego', 'fitosanit', 'zoosanit',
  'sanidad animal', 'caza', 'viticult', 'vitivinicol', 'olivar',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some(k => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some(k => t.includes(normalizar(k)));
}

module.exports = function docmRoutes(app, supabase) {
  app.get('/scrape-docm-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    let saltadasFiltro = 0;

    try {
      const fechaHoy = getFechaHoyYYYYMMDD();
      const docs = await obtenerDocumentosDocmPorFecha(fechaHoy);

      if (!docs.length) {
        return res.json({
          success: true,
          totales: 0,
          documentos_insertables: 0,
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          saltadasFiltro: 0,
          mensaje: 'No hay boletín DOCM publicado hoy (festivo o fin de semana)',
        });
      }

      const docsInsertables = [];
      for (const doc of docs) {
        const bolsa = [doc.texto.slice(0, 3500), doc.titulo, doc.seccion].join(' ');
        if (!esRuralRelevante(bolsa)) {
          saltadasFiltro++;
          continue;
        }

        docsInsertables.push(doc);
      }

      const { nuevas, duplicadas, errores } = await insertarAlertasBoletin(supabase, docsInsertables, {
        fuente: 'DOCM',
        region: 'Castilla-La Mancha',
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        totales: docs.length,
        documentos_insertables: docs.length - saltadasFiltro,
        nuevas,
        duplicadas,
        errores,
        saltadasFiltro,
        mensaje: 'DOCM procesado (HTML scraping + filtro rural)',
      });
    } catch (e) {
      console.error('Error en /scrape-docm-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
