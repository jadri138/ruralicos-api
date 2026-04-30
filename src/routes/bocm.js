// src/routes/bocm.js
//
// Scraper del BOCM (Boletín Oficial de la Comunidad de Madrid).
// Cron recomendado: días laborables a partir de las 08:30h.

const { checkCronToken } = require('../utils/checkCronToken');
const { obtenerDocumentosBocmConTexto, getFechaHoyISO } = require('../boletines/BOCM/bocmScraper');

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'mancomunidad', 'municipio',
  'presupuesto municipal', 'modificacion presupuestaria',
  'recurso contencioso', 'tribunal superior',
  'edicto', 'notificacion', 'recaudacion ejecutiva', 'providencia de apremio',
  'padron municipal', 'empadronamiento',
  'oposicion', 'convocatoria de pruebas selectivas', 'lista definitiva', 'lista provisional',
  'nombramiento', 'funcionario', 'interino', 'cese',
  'vehiculos', 'taxi', 'metro', 'urbanismo',
  'instalacion electrica', 'instalacion fotovoltaica', 'alta tension',
  'transicion energetica', 'economia circular',
  'canal de isabel ii',
  'modificacion presupuestaria',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'agroalimentari', 'rural',
  'forest', 'monte', 'sierra', 'medio natural',
  'politica agricola comun', 'pac', 'feader', 'fega', 'feaga',
  'regadio', 'regad', 'riego', 'canal',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'vino', 'viticultur', 'vinedo', 'olivar', 'cereal',
  'pasto', 'praderia', 'explotaci',
  'denominacion de origen', 'calidad alimentaria',
  'industria agroalimentaria',
  'consejeria de medio ambiente, agricultura',
  'medio ambiente, agricultura',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some((k) => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some((k) => t.includes(normalizar(k)));
}

module.exports = function bocmRoutes(app, supabase) {
  async function scrapeBocm(req, res) {
    if (!checkCronToken(req, res)) return;

    let nuevas = 0;
    let duplicadas = 0;
    let errores = 0;

    try {
      const fecha = req.query.fecha ? String(req.query.fecha).slice(0, 10) : null;
      const docs = await obtenerDocumentosBocmConTexto(fecha, esRuralRelevante);

      if (!docs.length) {
        return res.json({
          success: true,
          fecha: fecha || getFechaHoyISO(),
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          mensaje: 'No hay disposiciones BOCM relevantes en el último boletín',
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
          region: 'Comunidad de Madrid',
          fuente: 'BOCM',
          contenido: doc.texto,
        }]);

        if (errInsert) {
          console.error('[BOCM] Error insertando:', doc.url, errInsert.message);
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
        mensaje: 'BOCM procesado',
      });
    } catch (e) {
      console.error('Error en /scrape-bocm', e);
      return res.status(500).json({ error: e.message });
    }
  }

  app.get('/scrape-bocm-oficial', scrapeBocm);
  app.get('/scrape-bocm', scrapeBocm);
};
