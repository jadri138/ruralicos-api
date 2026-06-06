// src/routes/bocan.js
//
// Scraper del BOC (Boletín Oficial de Canarias).
// Cron recomendado: días laborables a partir de las 08:30h.

const { checkCronToken } = require('../utils/checkCronToken');
const { obtenerDocumentosBocanConTexto, getFechaHoyISO } = require('../boletines/BOCAN/bocanScraper');
const { insertarAlertasBoletin } = require('./boletines/shared/insertarAlertasBoletin');

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'cabildo insular', 'mancomunidad',
  'presupuesto municipal', 'presupuesto general',
  'recurso contencioso', 'tribunal superior',
  'edicto', 'notificacion', 'recaudacion ejecutiva', 'providencia de apremio',
  'diligencia de embargo', 'padron municipal',
  'oposicion', 'convocatoria de pruebas', 'lista definitiva', 'lista provisional',
  'nombramiento', 'funcionario', 'interino', 'cese',
  'transporte', 'taxi', 'turismo',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'agroalimentari', 'rural', 'agro',
  'forest', 'monte', 'medio natural',
  'politica agricola comun', 'pac', 'feader', 'fega', 'feaga',
  'pesca', 'acuicultur', 'maritim', 'lonja', 'pesquer',
  'regadio', 'regad', 'riego', 'agua agricola',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'platano', 'tomate', 'papa', 'vid', 'vino', 'viticultur',
  'pasto', 'explotaci', 'caprino', 'ovino', 'bovino',
  'denominacion de origen', 'indicacion geografica', 'calidad alimentaria',
  'consejeria de agricultura', 'direccion general de agricultura',
  'industria agroalimentaria',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some((k) => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some((k) => t.includes(normalizar(k)));
}

module.exports = function bocanRoutes(app, supabase) {
  async function scrapeBocan(req, res) {
    if (!checkCronToken(req, res)) return;

    try {
      const fecha = req.query.fecha ? String(req.query.fecha).slice(0, 10) : null;
      const docs = await obtenerDocumentosBocanConTexto(fecha, esRuralRelevante);

      if (!docs.length) {
        return res.json({
          success: true,
          fecha: fecha || getFechaHoyISO(),
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          mensaje: 'No hay disposiciones BOC Canarias relevantes en el último boletín',
        });
      }

      const { nuevas, duplicadas, errores } = await insertarAlertasBoletin(supabase, docs, {
        fuente: 'BOCAN',
        region: 'Canarias',
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        fecha: docs[0]?.fecha || fecha,
        relevantes: docs.length,
        nuevas,
        duplicadas,
        errores,
        mensaje: 'BOC Canarias procesado',
      });
    } catch (e) {
      console.error('Error en /scrape-bocan', e);
      return res.status(500).json({ error: e.message });
    }
  }

  app.get('/scrape-bocan-oficial', scrapeBocan);
  app.get('/scrape-bocan', scrapeBocan);
};
