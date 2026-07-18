// src/routes/doe.js
const { checkCronToken } = require('../../../middleware/cronToken');
const {
  getFechaHoyYYYYMMDD,
  obtenerDocumentosDoePorFecha,
  procesarDoePdf,
  extraerFechaBoletin,
} = require('../scrapers/DOE/doeScraper');
const { getFechaMadridISO, getFechaMadridYYYYMMDD } = require('../../../shared/fechaMadrid');
const { procesarConFiltroRural } = require('./shared/procesarConFiltroRural');
const { crearFiltroRural } = require('./shared/registrarBoletinRuta');
const {
  registrarRawDocuments,
  marcarRawDocumentSaltado,
} = require('../rawDocuments/rawDocuments.service');

function formatearFecha(fecha) {
  if (!fecha || fecha.length !== 8) return null;
  return `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;
}

const SENALES_NEGATIVAS = [
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

const esRuralRelevante = crearFiltroRural({
  excluir: SENALES_NEGATIVAS,
  incluir: INCLUIR_RURAL,
});

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

      // Captura bruta: recolectamos TODO lo detectado. La descarga del PDF ya
      // ocurría antes (no añade coste). Lo que no tiene PDF antes se perdía en
      // silencio; ahora se registra como skipped_by_rule / sin_pdf.
      const docsConTexto = [];
      const docsSinPdf = [];

      for (const url of urls) {
        const texto = await procesarDoePdf(url);
        if (!texto) {
          docsSinPdf.push({
            titulo: null,
            url,
            fecha: formatearFecha(fechaHoy) || fechaParam || getFechaMadridISO(),
          });
          continue;
        }

        const fechaDoc = extraerFechaBoletin(texto) || fechaHoy;
        const fechaSQL = formatearFecha(fechaDoc) || fechaParam || getFechaMadridISO();
        const titulo = generarTituloDoe(texto, fechaSQL);
        docsConTexto.push({ titulo, url, fecha: fechaSQL, texto });
      }

      // Registrar los detectados sin PDF (auditables, no perdidos).
      if (docsSinPdf.length) {
        const sinPdfConRaw = await registrarRawDocuments(supabase, docsSinPdf, {
          fuente: 'DOE',
          region: 'Extremadura',
        });
        for (const d of sinPdfConRaw) {
          await marcarRawDocumentSaltado(supabase, d.raw_document_id, 'sin_pdf');
        }
      }

      // El filtro rural usa solo el inicio del texto (igual que antes).
      const stats = await procesarConFiltroRural(supabase, docsConTexto, {
        fuente: 'DOE',
        region: 'Extremadura',
        esRuralRelevante,
        construirBolsa: (doc) => String(doc.texto || '').slice(0, 3500),
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        totales: urls.length,
        documentos_insertables: stats.documentos_insertables,
        nuevas: stats.nuevas,
        duplicadas: stats.duplicadas,
        errores: stats.errores,
        saltadasNoPdf: docsSinPdf.length,
        saltadasFiltro: stats.saltadasFiltro,
        mensaje: 'DOE procesado (captura bruta + 1 documento = 1 alerta + filtro)',
      });
    } catch (e) {
      console.error('Error en /scrape-doe-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
