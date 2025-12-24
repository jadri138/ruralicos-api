// src/routes/boa.js
const { checkCronToken } = require('../utils/checkCronToken');
const {
  obtenerMlkobsSumarioHoy,
  procesarBoaPorMlkob,
  dividirEnDisposiciones,
} = require('../boletines/boa/boaPdf');

// Convierte AAAAMMDD → AAAA-MM-DD
function formatearFecha(fecha) {
  if (!fecha || fecha.length !== 8) return null;
  return `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;
}

// =============================
//  RECORTE PARA IA (evita PDFs gigantes)
// =============================
const HEAD_CHARS = 2500;
const TAIL_CHARS = 400;

function recortarContenido(texto) {
  if (!texto) return '';
  const limpio = texto.replace(/\s+/g, ' ').trim();

  if (limpio.length <= HEAD_CHARS + TAIL_CHARS + 50) return limpio;

  return (
    limpio.slice(0, HEAD_CHARS) +
    '\n\n[... texto intermedio omitido ...]\n\n' +
    limpio.slice(-TAIL_CHARS)
  );
}

// =============================
//  FILTRO POR PALABRAS CLAVE (BOA)
//  - Si NO pasa el filtro, no se inserta en BD (ahorras IA).
// =============================

// Ajusta aquí las listas según lo que quieras cubrir.
const INCLUIR = [
  // Agricultura / ganadería / forestal
  'agric', 'ganad', 'forest', 'mont',
  // Agua / regadío
  'regad', 'riego', 'agua', 'pozo', 'conces', 'regante',
  // Ayudas / PAC
  'pac', 'ayuda', 'subvenc', 'convoc', 'bases reguladoras',
  // Sanidad animal / fitosanidad
  'sanidad animal', 'zoosanit', 'fitosanit', 'plaga',
  'peste porcina', 'influenza aviar', 'tuberculosis', 'lengua azul',
  // Purines / nitratos
  'purin', 'estiércol', 'nitrato', 'deyeccion',
  // Caza / daños
  'caza', 'jabal'
];

const EXCLUIR = [
  // Ruido típico (ajústalo con cuidado)
  'oposicion', 'nombramiento',
  'juzgado', 'subasta',
  'edicto', 'notificacion', 'notificación',
  'universidad', 'beca'
];

function normalizar(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

// Excluir gana siempre; si no hay match de incluir, se descarta.
function pasaFiltro(titulo, texto) {
  const hay = normalizar(`${titulo} ${texto}`);

  if (EXCLUIR.some((k) => hay.includes(k))) return false;
  return INCLUIR.some((k) => hay.includes(k));
}

module.exports = function boaRoutes(app, supabase) {
  app.get('/scrape-boa-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    let documentos = 0;
    let detectadas = 0;
    let nuevas = 0;
    let duplicadas = 0;
    let errores = 0;
    let saltadasNoPdf = 0;

    // Nuevas métricas del filtro
    let saltadasFiltro = 0;

    try {
      const mlkobs = await obtenerMlkobsSumarioHoy();

      if (!mlkobs || mlkobs.length === 0) {
        return res.json({
          success: true,
          documentos: 0,
          mlkobs_totales: 0,
          detectadas: 0,
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          saltadasNoPdf: 0,
          saltadasFiltro: 0,
          mensaje: 'No se han encontrado documentos BOA hoy',
        });
      }

      for (const mlkob of mlkobs) {
        const resultado = await procesarBoaPorMlkob(mlkob);

        // Si no devuelve texto, casi seguro era HTML/no-PDF o pdfjs falló
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

        const disposiciones = dividirEnDisposiciones(texto);
        detectadas += disposiciones.length;

        for (const disp of disposiciones) {
          const titulo =
            disp.slice(0, 140).replace(/\s+/g, ' ').trim() ||
            'Disposición BOA';

          // ✅ 1) FILTRO por palabras clave (antes de tocar BD)
          if (!pasaFiltro(titulo, disp)) {
            saltadasFiltro++;
            continue;
          }

          // ✅ 2) Duplicado por url+título
          const { data: existe, error: errDup } = await supabase
            .from('alertas')
            .select('id')
            .eq('url', urlOficial)
            .eq('titulo', titulo)
            .limit(1);

          if (errDup) {
            errores++;
            continue;
          }

          if (existe && existe.length > 0) {
            duplicadas++;
            continue;
          }

          // ✅ 3) Insertar (contenido recortado)
          const { error: errInsert } = await supabase.from('alertas').insert([
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

          if (errInsert) {
            errores++;
            continue;
          }

          nuevas++;
        }
      }

      return res.json({
        success: true,
        documentos,
        mlkobs_totales: mlkobs.length,
        detectadas,
        nuevas,
        duplicadas,
        errores,
        saltadasNoPdf,
        saltadasFiltro,
        mensaje: 'BOA procesado (multi-MLKOB + filtro keywords)',
      });
    } catch (e) {
      console.error('Error en /scrape-boa-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
