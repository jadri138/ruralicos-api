// src/routes/bor.js
//
// Scraper del BOR (Boletin Oficial de La Rioja).
// Cron recomendado: dias laborables a partir de las 08:30h.

const { checkCronToken } = require('../utils/checkCronToken');
const { obtenerDocumentosBorConTexto, getFechaHoyISO } = require('../boletines/BOR/borScraper');

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'mancomunidad',
  'presupuesto', 'modificacion de credito',
  'recurso contencioso', 'tribunal superior',
  'oposicion', 'concurso de traslados', 'relacion definitiva', 'relacion provisional',
  'nombramiento', 'nombra', 'funcionario', 'interino', 'cese',
  'padron', 'periodo de cobranza', 'delegacion de funciones',
  'casa rural', 'hotel', 'vehiculos', 'matrimonio civil',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'mundo rural',
  'forest', 'monte', 'politica agricola comun', 'fega', 'feaga', 'feader',
  'solicitud unica', 'subvenciones agrarias', 'subvenciones agro',
  'regadio', 'regad', 'riego',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'vitivinicol', 'vino', 'vinedo', 'viñedo', 'olivar', 'frutal',
  'cereal', 'forraje', 'pasto', 'explotaci',
  'denominacion de origen', 'calidad agroalimentaria',
  'industria agroalimentaria', 'agroalimentari',
  'consejeria de agricultura',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some((k) => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some((k) => t.includes(normalizar(k)));
}

module.exports = function borRoutes(app, supabase) {
  async function scrapeBor(req, res) {
    if (!checkCronToken(req, res)) return;

    let nuevas = 0;
    let duplicadas = 0;
    let errores = 0;

    try {
      const fecha = req.query.fecha ? String(req.query.fecha).slice(0, 10) : getFechaHoyISO();
      const docs = await obtenerDocumentosBorConTexto(fecha, esRuralRelevante);

      if (!docs.length) {
        return res.json({
          success: true,
          fecha,
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          mensaje: 'No hay disposiciones BOR relevantes en esta fecha',
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
          region: 'La Rioja',
          fuente: 'BOR',
          contenido: doc.texto,
        }]);

        if (errInsert) {
          console.error('[BOR] Error insertando:', doc.url, errInsert.message);
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
        mensaje: 'BOR procesado',
      });
    } catch (e) {
      console.error('Error en /scrape-bor', e);
      return res.status(500).json({ error: e.message });
    }
  }

  app.get('/scrape-bor-oficial', scrapeBor);
  app.get('/scrape-bor', scrapeBor);
};
