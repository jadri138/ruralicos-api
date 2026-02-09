// src/routes/boja.js
const { checkCronToken } = require('../utils/checkCronToken');
const bojaScraper = require('../boletines/BOJA/bojaScraper');
const {
  obtenerDocumentosBojaPorFecha,
  procesarBojaPdf,
  extraerFechaBoletin,
} = bojaScraper;
const getFechaHoyYYYYMMDD = typeof bojaScraper.getFechaHoyYYYYMMDD === 'function'
  ? bojaScraper.getFechaHoyYYYYMMDD
  : () => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  };

function formatearFecha(fecha) {
  if (!fecha || fecha.length !== 8) return null;
  return `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;
}

// Filtra ruido y busca palabras clave agrarias.
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

function generarTituloBoja(texto, fechaSQL) {
  const t = (texto || '').replace(/\r/g, '').trim();
  const lineas = t.split('\n').map(l => l.trim()).filter(Boolean);
  const primera =
    lineas.find((l) => {
      const n = normalizar(l);
      if (!l) return false;
      if (n.includes('num.') || n.includes('boja')) return false;
      if (n.includes('seccion') || n.includes('sección')) return false;
      return l.length >= 12;
    }) || lineas[0] || 'Documento BOJA';
  const corto = primera.replace(/\s+/g, ' ').slice(0, 140).trim();
  return `BOJA Andalucía – ${corto} (${fechaSQL})`;
}

module.exports = function bojaRoutes(app, supabase) {
  app.get('/scrape-boja-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    let documentos = 0;
    let nuevas = 0;
    let duplicadas = 0;
    let errores = 0;
    let saltadasNoPdf = 0;
    let saltadasFiltro = 0;

    try {
      const fechaHoy = getFechaHoyYYYYMMDD();
      const urls = await obtenerDocumentosBojaPorFecha(fechaHoy);

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
          mensaje: 'No se han encontrado documentos BOJA hoy',
        });
      }

      for (const url of urls) {
        const texto = await procesarBojaPdf(url);
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
        const fechaSQL = formatearFecha(fechaDoc) || new Date().toISOString().slice(0, 10);

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

        const titulo = generarTituloBoja(texto, fechaSQL);
        const { error: errInsert } = await supabase.from('alertas').insert([
          {
            titulo,
            resumen: 'Procesando con IA...',
            url,
            fecha: fechaSQL,
            region: 'Andalucía',
            fuente: 'BOJA',
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
        mensaje: 'BOJA procesado (1 documento = 1 alerta + filtro + título dinámico)',
      });
    } catch (e) {
      console.error('Error en /scrape-boja-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
