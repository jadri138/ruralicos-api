// src/routes/bocyl.js
//
// Scraper del BOCYL (Boletín Oficial de Castilla y León).
// Usa la API OpenDataSoft de la JCyL; el scraper devuelve disposiciones
// listas con texto completo — no hay que descargar PDFs aquí.
//
// Cron recomendado: días laborables a las 10:00–11:00h (el BOCYL
// se publica entre las 08:00 y las 10:30h de lunes a viernes).

const { checkCronToken }                          = require('../middleware/cronToken');
const { getFechaHoyYYYYMMDD, obtenerDocumentosBocylPorFecha } = require('../boletines/BOCYL/bocylScraper');
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
  'modificacion de creditos', 'presupuesto',
  'recurso contencioso', 'tribunal superior de justicia',
  'edicto', 'nombramiento', 'oposicion',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'rural',
  'forest', 'pac', 'ayuda', 'subvenc', 'bases reguladoras',
  'regad', 'riego', 'agua', 'fitosanit', 'zoosanit',
  'sanidad animal', 'plaga', 'caza',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some(k => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some(k => t.includes(normalizar(k)));
}

// ─────────────────────────────────────────────
// Ruta
// ─────────────────────────────────────────────
module.exports = function bocylRoutes(app, supabase) {
  app.get('/scrape-bocyl-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    let saltadasFiltro = 0;

    try {
      const fechaHoy = getFechaHoyYYYYMMDD();
      const docs     = await obtenerDocumentosBocylPorFecha(fechaHoy);

      if (!docs.length) {
        return res.json({
          success: true,
          totales: 0, documentos_insertables: 0,
          nuevas: 0, duplicadas: 0, errores: 0, saltadasFiltro: 0,
          mensaje: 'No hay boletín BOCYL publicado hoy (festivo o fin de semana)',
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
        fuente: 'BOCYL',
        region: 'Castilla y León',
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        totales:              docs.length,
        documentos_insertables: docs.length - saltadasFiltro,
        nuevas,
        duplicadas,
        errores,
        saltadasFiltro,
        mensaje: 'BOCYL procesado (API OpenDataSoft + filtro rural)',
      });
    } catch (e) {
      console.error('Error en /scrape-bocyl-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
