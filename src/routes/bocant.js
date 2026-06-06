// src/routes/bocant.js
//
// Scraper del BOC (Boletin Oficial de Cantabria).
// Cron recomendado: dias laborables a partir de las 08:30h.

const { checkCronToken } = require('../utils/checkCronToken');
const { obtenerDocumentosBocantConTexto, getFechaHoyISO } = require('../boletines/BOCANT/bocantScraper');
const { insertarAlertasBoletin } = require('./boletines/shared/insertarAlertasBoletin');

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'mancomunidad',
  'presupuesto', 'modificacion de credito',
  'recurso contencioso', 'tribunal superior',
  'oposicion', 'concurso', 'bolsa de empleo', 'proceso selectivo',
  'nombramiento', 'funcionario', 'interino', 'cese',
  'matrimonio civil', 'padron', 'urbanismo',
  'tauromaquia', 'espectaculos publicos',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'agroalimentari',
  'forest', 'monte', 'medio natural',
  'politica agricola comun', 'fega', 'feaga', 'feader',
  'solicitud unica', 'subvenciones agrarias',
  'regadio', 'regad', 'riego',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'vitivinicol', 'vino', 'vinedo', 'olivar', 'frutal',
  'cereal', 'forraje', 'pasto', 'explotaci',
  'denominacion de origen', 'indicacion geografica', 'calidad alimentaria',
  'industria agroalimentaria',
  'consejeria de desarrollo rural',
  'direccion general de ganaderia',
  'direccion general de agricultura',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some((k) => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some((k) => t.includes(normalizar(k)));
}

module.exports = function bocantRoutes(app, supabase) {
  async function scrapeBocant(req, res) {
    if (!checkCronToken(req, res)) return;

    try {
      const fecha = req.query.fecha ? String(req.query.fecha).slice(0, 10) : null;
      const docs = await obtenerDocumentosBocantConTexto(fecha, esRuralRelevante);

      if (!docs.length) {
        return res.json({
          success: true,
          fecha: fecha || getFechaHoyISO(),
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          mensaje: 'No hay disposiciones BOC Cantabria relevantes en esta fecha',
        });
      }

      const { nuevas, duplicadas, errores } = await insertarAlertasBoletin(supabase, docs, {
        fuente: 'BOCANT',
        region: 'Cantabria',
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        fecha: docs[0]?.fecha || fecha,
        relevantes: docs.length,
        nuevas,
        duplicadas,
        errores,
        mensaje: 'BOC Cantabria procesado',
      });
    } catch (e) {
      console.error('Error en /scrape-bocant', e);
      return res.status(500).json({ error: e.message });
    }
  }

  app.get('/scrape-bocant-oficial', scrapeBocant);
  app.get('/scrape-bocant', scrapeBocant);
};
