// src/routes/boa.js
const { checkCronToken } = require('../utils/checkCronToken');
const {
  procesarBoaDeHoy,
  dividirEnDisposiciones,
} = require('../boletines/boa/boaPdf');

// =============================
//  UTILIDADES
// =============================

// Convierte AAAAMMDD → AAAA-MM-DD
function formatearFecha(fecha) {
  if (!fecha || fecha.length !== 8) return null;
  return `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;
}

// Recorta contenido para IA (evita PDFs gigantes)
const HEAD_CHARS = 2500; // inicio del texto
const TAIL_CHARS = 400;  // final del texto

function recortarContenido(texto) {
  if (!texto) return '';

  const limpio = texto.replace(/\s+/g, ' ').trim();

  if (limpio.length <= HEAD_CHARS + TAIL_CHARS + 50) {
    return limpio;
  }

  return (
    limpio.slice(0, HEAD_CHARS) +
    '\n\n[... texto intermedio omitido ...]\n\n' +
    limpio.slice(-TAIL_CHARS)
  );
}

// =============================
//  RUTA BOA
// =============================
module.exports = function boaRoutes(app, supabase) {
  app.get('/scrape-boa-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const resultado = await procesarBoaDeHoy();

      if (!resultado) {
        return res.json({
          success: true,
          detectadas: 0,
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          mensaje: 'No se ha encontrado BOA procesable',
        });
      }

      const { mlkob, texto, fechaBoletin } = resultado;

      const fechaSQL =
        formatearFecha(fechaBoletin) ||
        new Date().toISOString().slice(0, 10);

      // URL OFICIAL que verá el usuario
      const urlOficial = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;

      const disposiciones = dividirEnDisposiciones(texto);
      const detectadas = disposiciones.length;

      let nuevas = 0;
      let duplicadas = 0;
      let errores = 0;

      for (const disp of disposiciones) {
        const titulo =
          disp.slice(0, 140).replace(/\s+/g, ' ').trim() ||
          'Disposición BOA';

        // 1️⃣ Comprobar duplicado (igual que BOE)
        const { data: existe, error: errorExiste } = await supabase
          .from('alertas')
          .select('id')
          .eq('url', urlOficial)
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

        // 2️⃣ Insertar alerta con contenido recortado
        const { error: errorInsert } = await supabase
          .from('alertas')
          .insert([
            {
              titulo,
              resumen: 'Procesando con IA...',
              url: urlOficial,
              fecha: fechaSQL,
              region: 'Aragón',
              fuente: 'BOA',
              contenido: recortarContenido(disp),
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
        mensaje: 'BOA procesado correctamente',
      });
    } catch (e) {
      console.error('Error en /scrape-boa-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
