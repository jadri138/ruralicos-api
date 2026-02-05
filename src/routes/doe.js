// src/routes/doe.js
const { checkCronToken } = require('../utils/checkCronToken');
const {
  getFechaHoyYYYYMMDD,
  obtenerDocumentosDoePorFecha,
  procesarDoePdf,
  extraerFechaBoletin,
} = require('../boletines/DOE/doeScraper');

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
    let nuevas = 0;
    let duplicadas = 0;
    let errores = 0;
    let saltadasNoPdf = 0;
    let saltadasFiltro = 0;

    try {
      let fecha = req.query.fecha || getFechaHoyYYYYMMDD();
      if (!/^\d{8}$/.test(fecha)) {
        return res.status(400).json({
          error: 'Fecha inválida. Usa AAAAMMDD, por ejemplo 20240101',
          fecha_recibida: fecha,
        });
      }

      const urls = await obtenerDocumentosDoePorFecha(fecha);

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
        const fechaDoc = extraerFechaBoletin(texto) || fecha;
        const fechaSQL =
          formatearFecha(fechaDoc) || new Date().toISOString().slice(0, 10);

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

        const titulo = generarTituloDoe(texto, fechaSQL);
        const { error: errInsert } = await supabase.from('alertas').insert([
          {
            titulo,
            resumen: 'Procesando con IA...',
            url,
            fecha: fechaSQL,
            region: 'Extremadura',
            fuente: 'DOE',
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
        mensaje: 'DOE procesado (1 documento = 1 alerta + filtro + título dinámico)',
      });
    } catch (e) {
      console.error('Error en /scrape-doe-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
