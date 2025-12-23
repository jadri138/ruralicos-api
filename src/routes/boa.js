// src/routes/boa.js
const { checkCronToken } = require('../utils/checkCronToken');
const { procesarBoaDeHoy, dividirEnDisposiciones } = require('../boletines/boa/boaPdf');

// Convierte AAAAMMDD en AAAA-MM-DD
function formatearFecha(fecha) {
  if (!fecha || fecha.length !== 8) return null;
  return `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;
}

module.exports = function boaRoutes(app, supabase) {
  app.get('/scrape-boa-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const resultado = await procesarBoaDeHoy();
      if (!resultado) {
        return res.json({
          success: true,
          nuevas: 0,
          detectadas: 0,
          duplicadas: 0,
          errores: 0,
          mensaje: 'No se ha encontrado BOA procesable (no MLKOB o no PDF)',
        });
      }

      const { mlkob, texto, fechaBoletin } = resultado;

      const fechaSQL =
        formatearFecha(fechaBoletin) || new Date().toISOString().slice(0, 10);

      // OJO: para el campo `url` guardamos el VEROBJ “estable”.
      // El PDF real se descarga con &type=pdf dentro de boaPdf.js
      const urlPdf = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;

      const disposiciones = dividirEnDisposiciones(texto);
      const detectadas = disposiciones.length;

      let nuevas = 0;
      let duplicadas = 0;
      let errores = 0;

      for (const disp of disposiciones) {
        const titulo =
          disp.slice(0, 140).replace(/\s+/g, ' ').trim() || 'Disposición BOA';

        // Duplicado por url+título (igual que BOE)
        const { data: existe, error: errorExiste } = await supabase
          .from('alertas')
          .select('id')
          .eq('url', urlPdf)
          .eq('titulo', titulo)
          .limit(1);

        if (errorExiste) {
          errores++;
          console.error('BOA duplicado check error:', errorExiste.message);
          continue;
        }

        if (existe && existe.length > 0) {
          duplicadas++;
          continue;
        }

        const { error: errorInsert } = await supabase.from('alertas').insert([
          {
            titulo,
            resumen: 'Procesando con IA...',
            url: urlPdf,
            fecha: fechaSQL,
            region: 'Aragón',
            contenido: disp,
            fuente: 'BOA',
          },
        ]);

        if (errorInsert) {
          errores++;
          console.error('BOA insert error:', errorInsert.message);
          continue;
        }

        nuevas++;
      }

      return res.json({
        success: true,
        mlkob,
        fecha: fechaSQL,
        detectadas,
        nuevas,
        duplicadas,
        errores,
        mensaje: 'BOA procesado',
      });
    } catch (e) {
      console.error('Error en /scrape-boa-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
