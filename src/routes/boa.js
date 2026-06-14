// src/routes/boa.js
const { checkCronToken } = require('../middleware/cronToken');
const {
  obtenerMlkobsSumarioHoy,
  obtenerMlkobsPorFecha,
  procesarBoaPorMlkob,
} = require('../boletines/boa/boaPdf');
const { getFechaMadridISO, getFechaMadridYYYYMMDD } = require('../utils/fechaMadrid');
const { insertarAlertasBoletin } = require('./boletines/shared/insertarAlertasBoletin');

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
const EXCLUIR_FUERTE = [
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

function esRuralRelevante(texto) {
  const t = normalizar(texto);

  // Excluir gana siempre
  if (EXCLUIR_FUERTE.some((k) => t.includes(normalizar(k)))) return false;

  // Incluir: al menos una señal rural
  return INCLUIR_RURAL.some((k) => t.includes(normalizar(k)));
}

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

    let documentos = 0;
    let saltadasNoPdf = 0;
    let saltadasFiltro = 0;

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

      const docsInsertables = [];
      for (const mlkob of mlkobs) {
        const resultado = await procesarBoaPorMlkob(mlkob);

        if (!resultado) {
          saltadasNoPdf++;
          continue;
        }

        const { texto, fechaBoletin } = resultado;

        // Filtro rápido usando solo el inicio del texto (barato)
        const check = texto.slice(0, 3500);
        if (!esRuralRelevante(check)) {
          saltadasFiltro++;
          continue;
        }

        documentos++;

        const fechaSQL =
          formatearFecha(fechaBoletin) ||
          fechaParam ||
          getFechaMadridISO();

        const urlOficial = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;

        const titulo = generarTituloBoa(texto, fechaSQL);
        docsInsertables.push({
          titulo,
          url: urlOficial,
          fecha: fechaSQL,
          texto,
        });
      }

      const { nuevas, duplicadas, errores } = await insertarAlertasBoletin(supabase, docsInsertables, {
        fuente: 'BOA',
        region: 'Aragón',
        contenido: (doc) => doc.texto,
      });

      return res.json({
        success: true,
        mlkobs_totales: mlkobs.length,
        documentos_insertables: documentos,
        nuevas,
        duplicadas,
        errores,
        saltadasNoPdf,
        saltadasFiltro,
        mensaje: 'BOA procesado (1 MLKOB = 1 alerta + filtro + título dinámico)',
      });
    } catch (e) {
      console.error('Error en /scrape-boa-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
