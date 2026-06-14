// src/routes/doe.js
const { checkCronToken } = require('../middleware/cronToken');
const {
  getFechaHoyYYYYMMDD,
  obtenerDocumentosDoePorFecha,
  procesarDoePdf,
  extraerFechaBoletin,
} = require('../boletines/DOE/doeScraper');
const { getFechaMadridISO, getFechaMadridYYYYMMDD } = require('../utils/fechaMadrid');
const { insertarAlertasBoletin } = require('./boletines/shared/insertarAlertasBoletin');

function formatearFecha(fecha) {
  if (!fecha || fecha.length !== 8) return null;
  return `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;
}

const EXCLUIR_FUERTE = [
  'boletín oficial de la provincia', 'ayuntamiento', 'diputación',
  'presupuesto', 'recurso contencioso', 'nombramiento',
];
const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'rural', 'forest', 'subvenc',
  'ayuda', 'modificación de bases', 'regad', 'riego', 'pac',
];

function normalizar(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function esRuralRelevante(texto) {
  const t = normalizar(texto);
  if (EXCLUIR_FUERTE.some((k) => t.includes(normalizar(k)))) return false;
  return INCLUIR_RURAL.some((k) => t.includes(normalizar(k)));
}

function generarTituloDoe(texto, fechaSQL) {
  const t = (texto || '').replace(/\r/g, '').trim();
  const lineas = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const primera =
    lineas.find((l) => {
      const n = normalizar(l);
      if (!l) return false;
      if (n.includes('num.') || n.includes('doe')) return false;
      if (n.includes('seccion') || n.includes('sección')) return false;
      return l.length >= 12;
    }) || lineas[0] || 'Documento DOE';
  const corto = primera.replace(/\s+/g, ' ').slice(0, 140).trim();
  return `DOE Extremadura – ${corto} (${fechaSQL})`;
}

module.exports = function doeRoutes(app, supabase) {
  app.get('/scrape-doe-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    let documentos = 0;
    let saltadasNoPdf = 0;
    let saltadasFiltro = 0;

    try {
      const fechaParam = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : null;
      const fechaHoy = fechaParam ? fechaParam.replace(/-/g, '') : (getFechaHoyYYYYMMDD() || getFechaMadridYYYYMMDD());
      const urls = await obtenerDocumentosDoePorFecha(fechaHoy);

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
          mensaje: 'No se han encontrado documentos DOE hoy',
        });
      }

      const docsInsertables = [];
      for (const url of urls) {
        const texto = await procesarDoePdf(url);
        if (!texto) {
          saltadasNoPdf++;
          continue;
        }

        const check = texto.slice(0, 3500);
        if (!esRuralRelevante(check)) {
          saltadasFiltro++;
          continue;
        }

        documentos++;
        const fechaDoc = extraerFechaBoletin(texto) || fechaHoy;
        const fechaSQL =
          formatearFecha(fechaDoc) || fechaParam || getFechaMadridISO();

        const titulo = generarTituloDoe(texto, fechaSQL);
        docsInsertables.push({
          titulo,
          url,
          fecha: fechaSQL,
          texto,
        });
      }

      const { nuevas, duplicadas, errores } = await insertarAlertasBoletin(supabase, docsInsertables, {
        fuente: 'DOE',
        region: 'Extremadura',
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        totales: urls.length,
        documentos_insertables: documentos,
        nuevas,
        duplicadas,
        errores,
        saltadasNoPdf,
        saltadasFiltro,
        mensaje: 'DOE procesado (1 documento = 1 alerta + filtro + título dinámico)',
      });
    } catch (e) {
      console.error('Error en /scrape-doe-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
