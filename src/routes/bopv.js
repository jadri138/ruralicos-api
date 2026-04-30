// src/routes/bopv.js
//
// Scraper del BOPV / EHAA (Boletin Oficial del Pais Vasco).
// Cron recomendado: dias laborables a partir de las 08:30h.

const { checkCronToken } = require('../utils/checkCronToken');
const { obtenerDocumentosBopvConTexto, getFechaHoyISO } = require('../boletines/BOPV/bopvScraper');

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'udal', 'diputacion foral',
  'nombramiento', 'nombra', 'cese', 'personal eventual',
  'oposicion', 'concurso', 'puesto de trabajo', 'provision',
  'universidad', 'osakidetza', 'servicio vasco de salud',
  'vivienda', 'turismo', 'hosteleria', 'ruido',
  'sancionador', 'notifica', 'edicto',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'nekazar', 'abeltzaint',
  'agroalimentari', 'alimentari', 'rural',
  'forest', 'monte', 'mendi', 'medio natural',
  'politica agricola comun', 'fega', 'feaga', 'feader',
  'solicitud unica', 'subvenciones agrarias',
  'regadio', 'regad', 'riego',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'vitivinicol', 'vino', 'vinedo', 'txakoli',
  'cereal', 'forraje', 'pasto', 'explotacion agraria', 'explotacion ganadera',
  'denominacion de origen', 'indicacion geografica', 'calidad alimentaria',
  'industria agroalimentaria',
  'desarrollo rural',
];

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some((k) => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some((k) => t.includes(normalizar(k)));
}

module.exports = function bopvRoutes(app, supabase) {
  async function scrapeBopv(req, res) {
    if (!checkCronToken(req, res)) return;

    let nuevas = 0;
    let duplicadas = 0;
    let errores = 0;

    try {
      const fecha = req.query.fecha ? String(req.query.fecha).slice(0, 10) : null;
      const docs = await obtenerDocumentosBopvConTexto(fecha, esRuralRelevante);

      if (!docs.length) {
        return res.json({
          success: true,
          fecha: fecha || getFechaHoyISO(),
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          mensaje: 'No hay disposiciones BOPV relevantes en el ultimo boletin',
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
          region: 'Pais Vasco',
          fuente: 'BOPV',
          contenido: doc.texto,
        }]);

        if (errInsert) {
          console.error('[BOPV] Error insertando:', doc.url, errInsert.message);
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
        mensaje: 'BOPV procesado',
      });
    } catch (e) {
      console.error('Error en /scrape-bopv', e);
      return res.status(500).json({ error: e.message });
    }
  }

  app.get('/scrape-bopv-oficial', scrapeBopv);
  app.get('/scrape-bopv', scrapeBopv);
};
