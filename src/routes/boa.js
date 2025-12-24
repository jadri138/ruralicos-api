// src/routes/boa.js
const { checkCronToken } = require('../utils/checkCronToken');
const {
  obtenerMlkobsSumarioHoy,
  procesarBoaPorMlkob,
} = require('../boletines/boa/boaPdf');

// Convierte AAAAMMDD → AAAA-MM-DD
function formatearFecha(fecha) {
  if (!fecha || fecha.length !== 8) return null;
  return `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;
}

module.exports = function boaRoutes(app, supabase) {
  app.get('/scrape-boa-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    let documentos = 0;
    let nuevas = 0;
    let duplicadas = 0;
    let errores = 0;
    let saltadasNoPdf = 0;

    try {
      const mlkobs = await obtenerMlkobsSumarioHoy();

      if (!mlkobs || mlkobs.length === 0) {
        return res.json({
          success: true,
          documentos: 0,
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          mensaje: 'No se han encontrado documentos BOA hoy',
        });
      }

      for (const mlkob of mlkobs) {
        const resultado = await procesarBoaPorMlkob(mlkob);

        if (!resultado) {
          saltadasNoPdf++;
          continue;
        }

        documentos++;

        const { texto, fechaBoletin } = resultado;

        const fechaSQL =
          formatearFecha(fechaBoletin) ||
          new Date().toISOString().slice(0, 10);

        const urlOficial = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;

        // 🔴 Duplicado REAL: 1 alerta por MLKOB
        const { data: existe, error: errDup } = await supabase
          .from('alertas')
          .select('id')
          .eq('url', urlOficial)
          .limit(1);

        if (errDup) {
          errores++;
          continue;
        }

        if (existe && existe.length > 0) {
          duplicadas++;
          continue;
        }

        // 🧠 AQUÍ LA IA HARÁ EL TRABAJO
        const { error: errInsert } = await supabase.from('alertas').insert([
          {
            titulo: `BOA Aragón – Contenido relevante para el sector agrario (${fechaSQL})`,
            resumen: 'Procesando con IA...',
            url: urlOficial,
            fecha: fechaSQL,
            region: 'Aragón',
            fuente: 'BOA',
            // IMPORTANTE: aquí guardas TODO el texto
            // la IA lo procesará en el siguiente paso
            contenido: texto,
          },
        ]);

        if (errInsert) {
          errores++;
          continue;
        }

        nuevas++;
      }

      return res.json({
        success: true,
        documentos,
        nuevas,
        duplicadas,
        errores,
        saltadasNoPdf,
        mensaje: 'BOA procesado (1 MLKOB = 1 alerta)',
      });
    } catch (e) {
      console.error('Error en /scrape-boa-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
