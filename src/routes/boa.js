// src/routes/boa.js
const { checkCronToken } = require('../utils/checkCronToken');
const {
  procesarBoaDeHoy,
  dividirEnDisposiciones,
} = require('../boletines/boa/boaPdf');

// Convierte AAAAMMDD en AAAA-MM-DD (útil para Supabase)
function formatearFecha(fecha) {
  if (!fecha || fecha.length !== 8) return null;
  return `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;
}

module.exports = function boaRoutes(app, supabase) {
  app.get('/scrape-boa-oficial', async (req, res) => {
    // Verificar token cron (como en el BOE)
    if (!checkCronToken(req, res)) return;

    try {
      // Procesar el BOA de hoy y extraer texto + fecha del boletín
      const resultado = await procesarBoaDeHoy();
      if (!resultado) {
        // No hay BOA para hoy (o no se pudo descargar)
        return res.json({
          success: true,
          nuevas: 0,
          mensaje: 'No se ha encontrado boletín del BOA para hoy',
        });
      }

      const { mlkob, texto, fechaBoletin } = resultado;

      // Fecha para Supabase (AAAA-MM-DD); si no se detecta, se usa hoy
      const fechaSQL =
        formatearFecha(fechaBoletin) ||
        new Date().toISOString().slice(0, 10);

      // URL al PDF del BOA (usada como referencia única)
      const urlPdf = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;

      // Dividir el texto en disposiciones (cada una será una alerta)
      const disposiciones = dividirEnDisposiciones(texto);

      let nuevas = 0;

      // Recorrer cada disposición e insertar si no existe
      for (const disp of disposiciones) {
        // Generar título (primeras 140 letras) y normalizar espacios
        const titulo =
          disp.slice(0, 140).replace(/\s+/g, ' ').trim() ||
          'Disposición BOA';

        // Comprobar duplicados por URL y título
        const { data: existe, error: errorExiste } = await supabase
          .from('alertas')
          .select('id')
          .eq('url', urlPdf)
          .eq('titulo', titulo)
          .limit(1);

        if (errorExiste) {
          // Si hay error comprobando duplicado, pasar a la siguiente
          console.error(
            'Error comprobando duplicado BOA:',
            errorExiste.message
          );
          continue;
        }
        if (existe && existe.length > 0) {
          // Ya existe; no duplicar
          continue;
        }

        // Insertar la alerta en Supabase (mismo patrón que el BOE)
        const { error: errorInsert } = await supabase
          .from('alertas')
          .insert([
            {
              titulo,
              resumen: 'Procesando con IA...',
              url: urlPdf,
              fecha: fechaSQL,
              region: 'Aragón',      // Región fija para el BOA
              contenido: disp,        // Texto completo de la disposición
              fuente: 'BOA',          // Fuente explícita (no se usaba en el BOE)
            },
          ]);

        if (errorInsert) {
          console.error(
            'Error insertando alerta del BOA:',
            errorInsert.message
          );
          continue;
        }

        nuevas++;
      }

      return res.json({
        success: true,
        nuevas,
        fecha: fechaSQL,
        mensaje: `BOA procesado e insertado (nuevas: ${nuevas})`,
      });
    } catch (e) {
      console.error('Error en /scrape-boa-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
