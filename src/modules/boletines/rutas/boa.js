// src/routes/boa.js
const { checkCronToken } = require('../../../middleware/cronToken');
const {
  obtenerMlkobsSumarioHoy,
  obtenerMlkobsPorFecha,
  procesarBoaPorMlkob,
} = require('../scrapers/boa/boaPdf');
const { getFechaMadridISO, getFechaMadridYYYYMMDD } = require('../../../shared/fechaMadrid');
const { procesarConFiltroRural } = require('./shared/procesarConFiltroRural');
const { crearFiltroRural } = require('./shared/registrarBoletinRuta');
const {
  registrarRawDocuments,
  marcarRawDocumentSaltado,
} = require('../rawDocuments/rawDocuments.service');

// Convierte AAAAMMDD → AAAA-MM-DD
function formatearFecha(fecha) {
  if (!fecha || fecha.length !== 8) return null;
  return `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;
}

// =============================
//  FILTRO BOA (anti-ruido + inclusión rural)
// =============================
function normalizar(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

// Ruido típico BOA/BOP (ayuntamientos, presupuestos, edictos, recursos...)
const SENALES_NEGATIVAS = [
  'bop', 'boletin oficial de la provincia',
  'ayuntamiento', 'comarca', 'diputacion',
  'seccion sexta', 'sección sexta',
  'modificacion de creditos', 'modificación de créditos',
  'presupuesto', 'haciendas locales', 'remanente de tesoreria', 'remanente de tesorería',
  'estado de gastos', 'estado de ingresos',
  'recurso contencioso', 'jurisdiccion contencioso', 'jurisdicción contencioso',
  'sala de lo contencioso', 'tribunal superior de justicia',
  'edicto', 'notificacion', 'notificación',
  'nombramiento', 'oposicion', 'oposición', 'concurso de meritos', 'concurso de méritos',
];

// Señales claras de interés rural (si no aparece ninguna, se descarta)
const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'rural',
  'forest', 'mont', 'aprovechamiento',
  'pac', 'fega', 'ayuda', 'subvenc', 'convoc', 'bases reguladoras',
  'regad', 'riego', 'concesion', 'concesión', 'agua', 'pozo', 'regante',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'peste porcina', 'influenza aviar', 'lengua azul', 'tuberculosis',
  'purin', 'purín', 'nitrato', 'estiércol', 'deyeccion', 'deyección',
  'caza', 'jabal', 'jabalí',
];

const esRuralRelevante = crearFiltroRural({
  excluir: SENALES_NEGATIVAS,
  incluir: INCLUIR_RURAL,
});

// Título dinámico: intenta coger una línea “humana” del inicio
function generarTituloBoa(texto, fechaSQL) {
  const t = (texto || '').replace(/\r/g, '').trim();

  // Coger una línea útil (evitar cabeceras tipo "Núm. 294 24 diciembre 2025 BOP Z ...")
  const lineas = t.split('\n').map((l) => l.trim()).filter(Boolean);

  const primeraUtil =
    lineas.find((l) => {
      const n = normalizar(l);
      if (!l) return false;
      if (n.includes('num.') || n.includes('núm.') || n.includes('bop')) return false;
      if (n.includes('boletin oficial') || n.includes('boletín oficial')) return false;
      if (/^boa\b/.test(n)) return false;
      if (n.includes('seccion') || n.includes('sección')) return false;
      return l.length >= 12;
    }) || (lineas[0] || 'Documento BOA');

  const corto = primeraUtil.replace(/\s+/g, ' ').slice(0, 140).trim();
  return `BOA Aragón – ${corto} (${fechaSQL})`;
}

module.exports = function boaRoutes(app, supabase) {
  app.get('/scrape-boa-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const fechaParam = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : null;
      const fechaYYYYMMDD = fechaParam ? fechaParam.replace(/-/g, '') : getFechaMadridYYYYMMDD();
      const mlkobs = fechaParam
        ? await obtenerMlkobsPorFecha(fechaYYYYMMDD)
        : await obtenerMlkobsSumarioHoy();

      if (!mlkobs || mlkobs.length === 0) {
        return res.json({
          success: true,
          mlkobs_totales: 0,
          documentos: 0,
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          saltadasNoPdf: 0,
          saltadasFiltro: 0,
          mensaje: 'No se han encontrado documentos BOA hoy',
        });
      }

      // Captura bruta: recolectamos TODO lo detectado. La descarga del PDF ya
      // ocurría antes (no añade coste). Lo que no tiene PDF antes se perdía en
      // silencio; ahora se registra como skipped_by_rule / sin_pdf.
      const docsConTexto = [];
      const docsSinPdf = [];

      for (const mlkob of mlkobs) {
        const urlOficial = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;
        const resultado = await procesarBoaPorMlkob(mlkob);

        if (!resultado) {
          docsSinPdf.push({
            titulo: null,
            url: urlOficial,
            fecha: fechaParam || getFechaMadridISO(),
          });
          continue;
        }

        const { texto, fechaBoletin } = resultado;
        const fechaSQL = formatearFecha(fechaBoletin) || fechaParam || getFechaMadridISO();
        const titulo = generarTituloBoa(texto, fechaSQL);
        docsConTexto.push({ titulo, url: urlOficial, fecha: fechaSQL, texto });
      }

      // Registrar los detectados sin PDF (auditables, no perdidos).
      if (docsSinPdf.length) {
        const sinPdfConRaw = await registrarRawDocuments(supabase, docsSinPdf, {
          fuente: 'BOA',
          region: 'Aragón',
        });
        for (const d of sinPdfConRaw) {
          await marcarRawDocumentSaltado(supabase, d.raw_document_id, 'sin_pdf');
        }
      }

      // El filtro rural usa solo el inicio del texto (igual que antes).
      const stats = await procesarConFiltroRural(supabase, docsConTexto, {
        fuente: 'BOA',
        region: 'Aragón',
        esRuralRelevante,
        construirBolsa: (doc) => String(doc.texto || '').slice(0, 3500),
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        mlkobs_totales: mlkobs.length,
        totales: mlkobs.length,
        documentos_insertables: stats.documentos_insertables,
        nuevas: stats.nuevas,
        duplicadas: stats.duplicadas,
        errores: stats.errores,
        saltadasNoPdf: docsSinPdf.length,
        saltadasFiltro: stats.saltadasFiltro,
        mensaje: 'BOA procesado (captura bruta + 1 MLKOB = 1 alerta + filtro)',
      });
    } catch (e) {
      console.error('Error en /scrape-boa-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
