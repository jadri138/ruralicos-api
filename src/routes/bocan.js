// src/routes/bocan.js
//
// Scraper del BOC (Boletín Oficial de Canarias).
// Cron recomendado: días laborables a partir de las 08:30h.

const { checkCronToken } = require('../utils/checkCronToken');
const { obtenerDocumentosBocanConTexto, getFechaHoyISO } = require('../boletines/BOCAN/bocanScraper');

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

    let nuevas = 0;
    let duplicadas = 0;
    let errores = 0;

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

      for (const doc of docs) {
        if (!doc.url) { errores++; continue; }

        const { data: existe, error: errDup } = await supabase
          .from('alertas').select('id').eq('url', doc.url).limit(1);
        if (errDup) { errores++; continue; }
        if (existe && existe.length > 0) { duplicadas++; continue; }

        const { error: errInsert } = await supabase.from('alertas').insert([{
          titulo: doc.titulo,
          resumen: 'Procesando con IA...',
          url: doc.url,
          fecha: doc.fecha,
          region: 'Canarias',
          fuente: 'BOC',
          contenido: doc.texto,
        }]);

        if (errInsert) {
          console.error('[BOCAN] Error insertando:', doc.url, errInsert.message);
          errores++;
          continue;
        }
        nuevas++;
      }

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
