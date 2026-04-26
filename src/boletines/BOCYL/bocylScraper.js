// src/boletines/BOCYL/bocylScraper.js
//
// Scraper del BOCYL (Boletín Oficial de Castilla y León) usando la API REST oficial.
//
// Fuente primaria — API OpenDataSoft de la JCyL (sin autenticación):
//   https://analisis.datosabiertos.jcyl.es/api/explore/v2.1/catalog/datasets/bocyl/records
//
// Cada registro incluye metadatos completos + URLs a HTML (.do), XML y PDF.
// Se descarga el HTML de la disposición para obtener el texto completo;
// si el HTML no está disponible se usa el PDF como fallback.

const axios = require('axios');
const { htmlATexto }     = require('../../utils/htmlParser');
const { extraerTextoPdf } = require('../../utils/pdfExtractor');

const API_BOCYL = 'https://analisis.datosabiertos.jcyl.es/api/explore/v2.1/catalog/datasets/bocyl/records';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function getFechaHoyYYYYMMDD() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// La API devuelve URLs con http:// — forza HTTPS
function toHttps(url) {
  return url ? String(url).replace(/^http:\/\//i, 'https://') : null;
}

// ─────────────────────────────────────────────
// Paso 1: obtener todos los registros de la API
// para una fecha ISO (YYYY-MM-DD), paginando si es necesario.
// ─────────────────────────────────────────────
async function obtenerRegistrosAPI(fechaISO) {
  const registros = [];
  let offset      = 0;
  const limit     = 100;

  while (true) {
    const url = `${API_BOCYL}?limit=${limit}&offset=${offset}&refine=fecha_publicacion:${fechaISO}&order_by=pagina_inicial%20asc`;
    console.log('[BOCYL] API →', url);

    const { data } = await axios.get(url, {
      timeout: 30000,
      headers: { Accept: 'application/json' },
    });

    if (!data.results || data.results.length === 0) break;
    registros.push(...data.results);
    console.log(`[BOCYL] ${registros.length} / ${data.total_count || '?'} registros`);
    if (registros.length >= (data.total_count || 0)) break;
    offset += limit;
  }

  return registros;
}

// ─────────────────────────────────────────────
// Paso 2: para una disposición, obtener su texto completo.
//   1. HTML (.do servlet)  → texto limpio vía htmlATexto
//   2. PDF                 → texto extraído vía pdfjs
//   3. Metadatos de la API → fallback mínimo
// ─────────────────────────────────────────────
async function obtenerTextoDisposicion(r) {
  // — Intento 1: HTML —
  const htmlUrl = toHttps(r.enlace_fichero_html);
  if (htmlUrl) {
    try {
      const { data } = await axios.get(htmlUrl, {
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (RuralicosBot/2.0)',
          'Accept':     'text/html',
          'Referer':    'https://bocyl.jcyl.es/',
        },
      });
      const texto = htmlATexto(String(data));
      if (texto.length > 200) return texto;
    } catch (e) {
      console.warn(`[BOCYL] HTML no disponible (${htmlUrl}): ${e.message}`);
    }
  }

  // — Intento 2: PDF —
  const pdfUrl = toHttps(r.enlace_fichero_pdf);
  if (pdfUrl) {
    try {
      const { data } = await axios.get(pdfUrl, {
        responseType: 'arraybuffer',
        timeout:      30000,
        headers: {
          Accept:       'application/pdf,*/*',
          'User-Agent': 'Mozilla/5.0 (RuralicosBot/2.0)',
          Referer:      'https://bocyl.jcyl.es/',
        },
        validateStatus: s => s >= 200 && s < 400,
      });
      const buf = Buffer.from(data);
      if (buf.slice(0, 4).toString('utf8') === '%PDF') {
        return await extraerTextoPdf(buf);
      }
    } catch (e) {
      console.warn(`[BOCYL] PDF no disponible (${pdfUrl}): ${e.message}`);
    }
  }

  // — Fallback: metadatos —
  return [r.rango, r.titulo, r.organismo, r.seccion].filter(Boolean).join('\n');
}

// ─────────────────────────────────────────────
// Función principal
// Devuelve array de disposiciones con texto completo para una fecha (YYYYMMDD).
// ─────────────────────────────────────────────
async function obtenerDocumentosBocylPorFecha(fechaYYYYMMDD) {
  const año = fechaYYYYMMDD.slice(0, 4);
  const mes = fechaYYYYMMDD.slice(4, 6);
  const dia = fechaYYYYMMDD.slice(6, 8);
  const fechaISO = `${año}-${mes}-${dia}`;

  const registros = await obtenerRegistrosAPI(fechaISO);
  if (!registros.length) return [];

  const resultado = [];

  for (const r of registros) {
    const urlPdf  = toHttps(r.enlace_fichero_pdf);
    const urlHtml = toHttps(r.enlace_fichero_html);
    // URL canónica: PDF si existe (es un enlace estable y único); sino HTML
    const url = urlPdf || urlHtml || `https://bocyl.jcyl.es/boletin.do?fechaBoletin=${dia}/${mes}/${año}`;

    const texto = await obtenerTextoDisposicion(r);

    // Título limpio: rango + título oficial de la API (ya es texto plano)
    const titulo = `${r.rango ? r.rango + ' – ' : ''}${r.titulo || r.organismo || 'Disposición BOCYL'}`
      .replace(/\s+/g, ' ').trim().slice(0, 220);

    resultado.push({
      titulo,
      url,
      texto,
      fecha:     r.fecha_publicacion || fechaISO, // YYYY-MM-DD
      seccion:   r.seccion   || '',
      organismo: r.organismo || '',
    });
  }

  return resultado;
}

module.exports = { getFechaHoyYYYYMMDD, obtenerDocumentosBocylPorFecha };
