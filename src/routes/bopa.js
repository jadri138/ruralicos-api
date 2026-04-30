// src/routes/bopa.js
//
// Scraper del BOPA (Boletín Oficial del Principado de Asturias).
// Cron recomendado: días laborables a partir de las 08:30h.

const { checkCronToken } = require('../utils/checkCronToken');
const { obtenerDocumentosBopaConTexto, getFechaHoyISO } = require('../boletines/BOPA/bopaScraper');

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'concejo', 'mancomunidad',
  'presupuesto municipal', 'modificacion de credito',
  'recurso contencioso', 'tribunal superior',
  'edicto', 'notificacion', 'recaudacion ejecutiva', 'providencia de apremio',
  'diligencia de embargo', 'herencia yacente', 'padron municipal',
  'oposicion', 'convocatoria para la provision', 'lista definitiva', 'lista provisional',
  'nombramiento', 'nombra', 'funcionario', 'interino', 'cese',
  'casa rural', 'hotel', 'alojamiento rural',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'rural', 'agroalimentari',
  'forest', 'monte', 'aprovechamiento forestal', 'politica agricola comun',
  'fega', 'feaga', 'feader', 'desarrollo rural',
  'regadio', 'regad', 'riego',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'lacteo', 'leche', 'bovino', 'vacuno', 'porcino', 'ovino', 'caprino',
  'sidra', 'manzana', 'pomac', 'vino', 'viticultur',
  'pasto', 'pastal', 'praderia', 'explotaci',
  'denominacion de origen', 'calidad agroalimentaria',
  'consejeria de medio rural', 'servicio de ganaderia',
  'industria alimentaria',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some((k) => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some((k) => t.includes(normalizar(k)));
}

module.exports = function bopaRoutes(app, supabase) {
  async function scrapeBopa(req, res) {
    if (!checkCronToken(req, res)) return;

    let nuevas = 0;
    let duplicadas = 0;
    let errores = 0;

    try {
      const fecha = req.query.fecha ? String(req.query.fecha).slice(0, 10) : null;
      const docs = await obtenerDocumentosBopaConTexto(fecha, esRuralRelevante);

      if (!docs.length) {
        return res.json({
          success: true,
          fecha: fecha || getFechaHoyISO(),
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          mensaje: 'No hay disposiciones BOPA relevantes en el último boletín',
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
          estado_ia: 'pendiente_clasificar',
          url: doc.url,
          fecha: doc.fecha,
          region: 'Asturias',
          fuente: 'BOPA',
          contenido: doc.texto,
        }]);

        if (errInsert) {
          console.error('[BOPA] Error insertando:', doc.url, errInsert.message);
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
        mensaje: 'BOPA procesado',
      });
    } catch (e) {
      console.error('Error en /scrape-bopa', e);
      return res.status(500).json({ error: e.message });
    }
  }

  app.get('/scrape-bopa-oficial', scrapeBopa);
  app.get('/scrape-bopa', scrapeBopa);
};
