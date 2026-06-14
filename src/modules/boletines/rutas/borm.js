const { checkCronToken } = require('../../../middleware/cronToken');
const { getFechaHoyYYYYMMDD, obtenerDocumentosBormPorFecha } = require('../scrapers/BORM/bormScraper');
const { insertarAlertasBoletin } = require('./shared/insertarAlertasBoletin');

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
  'huerta', 'frutas', 'horticultur', 'citric', 'regant',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some(k => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some(k => t.includes(normalizar(k)));
}

module.exports = function bormRoutes(app, supabase) {
  app.get('/scrape-borm-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    let saltadasFiltro = 0;

    try {
      const fechaHoy = getFechaHoyYYYYMMDD();
      const docs = await obtenerDocumentosBormPorFecha(fechaHoy);

      if (!docs.length) {
        return res.json({
          success: true,
          totales: 0,
          documentos_insertables: 0,
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          saltadasFiltro: 0,
          mensaje: 'No hay boletín BORM publicado hoy (festivo o fin de semana)',
        });
      }

      const docsInsertables = [];
      for (const doc of docs) {
        const bolsa = [doc.texto.slice(0, 3500), doc.titulo, doc.seccion, doc.organismo].join(' ');
        if (!esRuralRelevante(bolsa)) {
          saltadasFiltro++;
          continue;
        }

        docsInsertables.push(doc);
      }

      const { nuevas, duplicadas, errores } = await insertarAlertasBoletin(supabase, docsInsertables, {
        fuente: 'BORM',
        region: 'Murcia',
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
        mensaje: 'BORM procesado (API REST + filtro rural)',
      });
    } catch (e) {
      console.error('Error en /scrape-borm-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
