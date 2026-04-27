const { checkCronToken } = require('../utils/checkCronToken');
const { getFechaHoyYYYYMMDD, obtenerDocumentosDocmPorFecha } = require('../boletines/DOCM/docmScraper');

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

    let nuevas = 0;
    let duplicadas = 0;
    let errores = 0;
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

      for (const doc of docs) {
        const bolsa = [doc.texto.slice(0, 3500), doc.titulo, doc.seccion].join(' ');
        if (!esRuralRelevante(bolsa)) {
          saltadasFiltro++;
          continue;
        }

        const { data: existe, error: errDup } = await supabase
          .from('alertas').select('id').eq('url', doc.url).limit(1);
        if (errDup) { errores++; continue; }
        if (existe && existe.length > 0) { duplicadas++; continue; }

        const { error: errInsert } = await supabase.from('alertas').insert([{
          titulo: doc.titulo,
          resumen: 'Procesando con IA...',
          url: doc.url,
          fecha: doc.fecha,
          region: 'Castilla-La Mancha',
          fuente: 'DOCM',
          contenido: doc.texto,
        }]);

        if (errInsert) {
          console.error('[DOCM] Error insertando:', doc.url, errInsert.message);
          errores++;
          continue;
        }
        nuevas++;
      }

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