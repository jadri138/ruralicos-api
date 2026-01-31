// src/routes/bocyl.js
const { checkCronToken } = require('../utils/checkCronToken');
const {
  getFechaHoyYYYYMMDD,
  obtenerDocumentosBocylPorFecha,
  procesarBocylPdf,
  extraerFechaBoletin,
} = require('./boletines/bocyl/bocylScraper');

/**
 * Convierte AAAAMMDD en AAAA-MM-DD para almacenarlo en la base de datos.
 */
function formatearFecha(fecha) {
  if (!fecha || fecha.length !== 8) return null;
  return `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;
}

// =============================
//  FILTRO BOCYL (anti-ruido + inclusión rural)
// =============================
function normalizar(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

// Lista de palabras o frases que indican anuncios administrativos sin interés.
const EXCLUIR_FUERTE = [
  'boletín oficial de la provincia',
  'ayuntamiento', 'diputación',
  'modificación de créditos', 'presupuesto',
  'recurso contencioso', 'tribunal superior de justicia',
  'edicto', 'nombramiento', 'oposición',
];

// Señales de interés rural; puedes ampliarlas según la terminología regional.
const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'rural',
  'forest', 'pac', 'ayuda', 'subvenc', 'bases reguladoras',
  'regad', 'riego', 'agua',
  'fitosanit', 'zoosanit', 'sanidad animal',
  'caza',
];

// Función de filtrado: descarta si encuentra algún ruido y sólo acepta si hay palabra clave:contentReference[oaicite:0]{index=0}.
function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some((k) => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some((k) => t.includes(normalizar(k)));
}

// Crea un título resumido a partir del contenido.
function generarTituloBocyl(texto, fechaSQL) {
  const t = (texto || '').replace(/\r/g, '').trim();
  const lineas = t.split('\n').map((l) => l.trim()).filter(Boolean);

  const primeraUtil =
    lineas.find((l) => {
      const n = normalizar(l);
      if (!l) return false;
      if (n.includes('num.') || n.includes('bocyl')) return false;
      if (n.includes('seccion') || n.includes('sección')) return false;
      return l.length >= 12;
    }) || lineas[0] || 'Documento BOCYL';

  const corto = primeraUtil.replace(/\s+/g, ' ').slice(0, 140).trim();
  return `BOCYL Castilla y León – ${corto} (${fechaSQL})`;
}

module.exports = function bocylRoutes(app, supabase) {
  app.get('/scrape-bocyl-oficial', async (req, res) => {
    // Protege la ruta con el token de cron.
    if (!checkCronToken(req, res)) return;

    let documentos = 0;
    let nuevas = 0;
    let duplicadas = 0;
    let errores = 0;
    let saltadasNoPdf = 0;
    let saltadasFiltro = 0;

    try {
      // Obtiene la lista de URLs de documentos de hoy.
      const fechaHoy = getFechaHoyYYYYMMDD();
      const urls = await obtenerDocumentosBocylPorFecha(fechaHoy);

      if (!urls || urls.length === 0) {
        return res.json({
          success: true,
          totales: 0,
          documentos: 0,
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          saltadasNoPdf: 0,
          saltadasFiltro: 0,
          mensaje: 'No se han encontrado documentos BOCYL hoy',
        });
      }

      for (const url of urls) {
        const texto = await procesarBocylPdf(url);

        if (!texto) {
          saltadasNoPdf++;
          continue;
        }

        // Filtro rápido en los primeros caracteres:contentReference[oaicite:1]{index=1}.
        const check = texto.slice(0, 3500);
        if (!esRuralRelevante(check)) {
          saltadasFiltro++;
          continue;
        }

        documentos++;

        const fechaBoletin = extraerFechaBoletin(texto) || fechaHoy;
        const fechaSQL = formatearFecha(fechaBoletin) || new Date().toISOString().slice(0, 10);

        // Comprobar duplicados: 1 alerta por URL
        const { data: existe, error: errDup } = await supabase
          .from('alertas')
          .select('id')
          .eq('url', url)
          .limit(1);

        if (errDup) {
          errores++;
          continue;
        }
        if (existe && existe.length > 0) {
          duplicadas++;
          continue;
        }

        const titulo = generarTituloBocyl(texto, fechaSQL);

        const { error: errInsert } = await supabase.from('alertas').insert([
          {
            titulo,
            resumen: 'Procesando con IA...',
            url,
            fecha: fechaSQL,
            region: 'Castilla y León',
            fuente: 'BOCYL',
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
        totales: urls.length,
        documentos_insertables: documentos,
        nuevas,
        duplicadas,
        errores,
        saltadasNoPdf,
        saltadasFiltro,
        mensaje: 'BOCYL procesado (1 documento = 1 alerta + filtro + título dinámico)',
      });
    } catch (e) {
      console.error('Error en /scrape-bocyl-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
