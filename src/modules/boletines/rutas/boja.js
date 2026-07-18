// src/routes/boja.js
//
// Scraper del BOJA (Boletín Oficial de la Junta de Andalucía).
// Usa la API oficial REST — el texto de cada disposición llega directamente
// en el campo bodyNoHtml, sin necesidad de descargar PDFs.
//
// Cron recomendado: días laborables a las 10:00–11:00h (el BOJA
// se publica normalmente entre las 08:00 y las 10:00h de lunes a viernes).
//
// Captura bruta: TODOS los documentos devueltos por la API se registran en
// raw_documents ANTES del filtro rural. Los descartados por el filtro quedan
// como skipped_by_rule (no se pierden); los insertados enlazan con su alerta.

const { checkCronToken } = require('../../../middleware/cronToken');
const { getFechaHoyYYYYMMDD, obtenerDocumentosBojaPorFecha } = require('../scrapers/BOJA/bojaScraper');
const { procesarConFiltroRural } = require('./shared/procesarConFiltroRural');
const { crearFiltroRural } = require('./shared/registrarBoletinRuta');

const REGION = 'Andalucía';

// ─────────────────────────────────────────────
// Filtro de relevancia rural
// ─────────────────────────────────────────────
const SENALES_NEGATIVAS = [
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

const esRuralRelevante = crearFiltroRural({
  excluir: SENALES_NEGATIVAS,
  incluir: INCLUIR_RURAL,
});

// ─────────────────────────────────────────────
// Núcleo: registrar (bruto) → filtrar (rural) → insertar (alertas).
// Separado de la ruta para poder testearlo con un supabase falso.
// ─────────────────────────────────────────────
async function procesarDocumentosBoja(supabase, docs) {
  return procesarConFiltroRural(supabase, docs, {
    fuente: 'BOJA',
    region: REGION,
    esRuralRelevante,
    contenido: (doc) => doc.texto,
  });
}

// ─────────────────────────────────────────────
// Ruta
// ─────────────────────────────────────────────
function bojaRoutes(app, supabase) {
  app.get('/scrape-boja-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

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

      const stats = await procesarDocumentosBoja(supabase, docs);

      return res.json({
        success: true,
        ...stats,
        mensaje: 'BOJA procesado (API oficial Junta de Andalucía + captura bruta + filtro rural)',
      });
    } catch (e) {
      console.error('Error en /scrape-boja-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
}

module.exports = bojaRoutes;
module.exports.procesarDocumentosBoja = procesarDocumentosBoja;
module.exports.esRuralRelevante = esRuralRelevante;
