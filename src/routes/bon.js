// src/routes/bon.js
//
// Scraper del BON (Boletin Oficial de Navarra).
// Cron recomendado: dias laborables a partir de las 08:30h.

const { checkCronToken } = require('../utils/checkCronToken');
const { obtenerDocumentosBonConTexto } = require('../boletines/BON/bonScraper');

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'concejo', 'mancomunidad',
  'presupuesto', 'plantilla organica',
  'recurso contencioso', 'tribunal superior',
  'edicto', 'notificacion', 'recaudacion ejecutiva', 'providencia de apremio',
  'diligencia de embargo', 'herencia yacente', 'padron municipal',
  'oposicion', 'convocatoria para la provision', 'lista definitiva',
  'universidad', 'nombramiento', 'nombra', 'interino', 'cese',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'rural',
  'forest', 'monte', 'politica agricola comun', 'fega', 'feaga', 'feader',
  'regadio', 'regad', 'riego', 'agua',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'aprovechamiento forestal', 'aprovechamientos forestales',
  'vitivinicol', 'vino', 'vinedo', 'olivar', 'frutal',
  'cereal', 'forraje', 'pasto', 'explotaci',
  'denominacion de origen', 'calidad alimentaria',
  'industria agroalimentaria', 'agroalimentari',
  'desarrollo rural', 'medio rural',
  'departamento de desarrollo rural',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some((k) => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some((k) => t.includes(normalizar(k)));
}

module.exports = function bonRoutes(app, supabase) {
  async function scrapeBon(req, res) {
    if (!checkCronToken(req, res)) return;

    let nuevas = 0;
    let duplicadas = 0;
    let errores = 0;

    try {
      const fecha = req.query.fecha ? String(req.query.fecha).slice(0, 10) : null;
      const docs = await obtenerDocumentosBonConTexto(fecha, esRuralRelevante);

      if (!docs.length) {
        return res.json({
          success: true,
          fecha,
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          mensaje: 'No hay disposiciones BON relevantes en el ultimo boletin',
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
          region: 'Navarra',
          fuente: 'BON',
          contenido: doc.texto,
        }]);

        if (errInsert) {
          console.error('[BON] Error insertando:', doc.url, errInsert.message);
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
        mensaje: 'BON procesado',
      });
    } catch (e) {
      console.error('Error en /scrape-bon', e);
      return res.status(500).json({ error: e.message });
    }
  }

  app.get('/scrape-bon-oficial', scrapeBon);
  app.get('/scrape-bon', scrapeBon);
};
