// src/boletines/DOE/doeScraper.js
const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/build/pdf.js');

/**
 * Devuelve la fecha actual en formato YYYYMMDD.
 */
function getFechaHoyYYYYMMDD() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function normalizarUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function extraerUrlsPdfDesdeHtml(html, baseUrl) {
  const urls = new Set();
  if (!html) return [];

  const patterns = [
    /href=["']([^"']+\.pdf[^"']*)["']/gi,
    /href=["']([^"']+type=pdf[^"']*)["']/gi,
    /href=["']([^"']+pdf[^"']*download[^"']*)["']/gi,
  ];

  for (const pattern of patterns) {
    const matches = html.matchAll(pattern);
    for (const match of matches) {
      const candidate = normalizarUrl(baseUrl, match[1]);
      if (candidate) urls.add(candidate);
    }
  }

  return Array.from(urls);
}

function extraerUrlsPdfDesdeJson(payload, baseUrl) {
  const urls = new Set();
  const texto = JSON.stringify(payload || {});
  for (const match of texto.matchAll(/https?:\\/\\/[^"\\s]+/gi)) {
    const raw = match[0];
    if (!/pdf|type=pdf/i.test(raw)) continue;
    const candidate = normalizarUrl(baseUrl, raw);
    if (candidate) urls.add(candidate);
  }

  return Array.from(urls);
}

/**
 * Obtiene la lista de URLs de publicaciones del DOE para una fecha dada.
 * Se apoya en el sumario diario del DOE y extrae enlaces a PDFs.
 */
async function obtenerDocumentosDoePorFecha(fechaYYYYMMDD) {
  const fecha = fechaYYYYMMDD;
  const yyyy = fecha.slice(0, 4);
  const mm = fecha.slice(4, 6);
  const dd = fecha.slice(6, 8);

  const candidatos = [
    `https://doe.juntaex.es/diario/?fecha=${fecha}`,
    `https://doe.juntaex.es/diario/?dia=${dd}&mes=${mm}&anio=${yyyy}`,
    `https://doe.juntaex.es/diario/${yyyy}/${mm}/${dd}/`,
    `https://doe.juntaex.es/diario/`,
  ];

  for (const url of candidatos) {
    try {
      const resp = await axios.get(url, {
        timeout: 20000,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Mozilla/5.0 (RuralicosBot)',
        },
        validateStatus: (s) => s >= 200 && s < 400,
      });

      const data = resp.data;
      const html = typeof data === 'string' ? data : '';
      const urlsHtml = extraerUrlsPdfDesdeHtml(html, url);
      const urlsJson =
        typeof data === 'object' && data ? extraerUrlsPdfDesdeJson(data, url) : [];
      const urls = Array.from(new Set([...urlsHtml, ...urlsJson]));
      if (urls.length > 0) return urls;
    } catch (e) {
      console.error('❌ Error DOE sumario:', url, e.message);
    }
  }

  return [];
}

/**
 * Descarga un PDF del DOE y comprueba que sea un PDF válido.
 */
async function descargarDoePdf(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 5,
    headers: {
      Accept: 'application/pdf,*/*',
      'User-Agent': 'Mozilla/5.0 (RuralicosBot)',
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const buf = Buffer.from(response.data);
  const magic = buf.slice(0, 4).toString('utf8');
  if (magic !== '%PDF') return null;

  return buf;
}

/**
 * Extrae el texto de un PDF utilizando pdfjs.
 */
async function extraerTextoPdf(bufferPdf) {
  const uint8Array = new Uint8Array(bufferPdf);
  const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
  const pdf = await loadingTask.promise;

  let texto = '';
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const strings = content.items.map((item) => item.str).join(' ');
    texto += strings + '\n';
  }
  return texto;
}

/**
 * Procesa un PDF completo: lo descarga y extrae su texto.
 */
async function procesarDoePdf(url) {
  const pdfBuffer = await descargarDoePdf(url);
  if (!pdfBuffer) return null;

  try {
    return await extraerTextoPdf(pdfBuffer);
  } catch {
    return null;
  }
}

/**
 * Extrae la fecha del boletín a partir del texto.
 * Ajusta la expresión regular según cómo la indica el DOE.
 */
function extraerFechaBoletin(texto) {
  const match = texto && texto.match(/DOE\s*(\d{2})\/(\d{2})\/(\d{4})/);
  if (match) {
    const [, dd, mm, yyyy] = match;
    return `${yyyy}${mm}${dd}`;
  }
  return null;
}

/**
 * Divide el texto en disposiciones (órdenes, resoluciones, anuncios, consejerías).
 */
function dividirEnDisposiciones(texto) {
  const patrones = [
    /ORDEN\s+[A-ZÁÉÍÓÚ0-9\/\-]+/g,
    /RESOLUCIÓN\s+de\s+/g,
    /ANUNCIO\s+de\s+/g,
    /CONSEJERÍA\s+DE\s+[A-ZÁÉÍÓÚÑ ]+/g,
  ];
  const regex = new RegExp(patrones.map((p) => p.source).join('|'), 'g');
  const indices = [];
  let match;
  while ((match = regex.exec(texto)) !== null) indices.push(match.index);

  if (indices.length === 0) return [texto.trim()];

  const disposiciones = [];
  for (let i = 0; i < indices.length; i++) {
    const inicio = indices[i];
    const fin = indices[i + 1] ?? texto.length;
    const bloque = texto.slice(inicio, fin).trim();
    if (bloque.length > 80) disposiciones.push(bloque);
  }
  return disposiciones;
}

module.exports = {
  getFechaHoyYYYYMMDD,
  obtenerDocumentosDoePorFecha,
  descargarDoePdf,
  extraerTextoPdf,
  procesarDoePdf,
  extraerFechaBoletin,
  dividirEnDisposiciones,
};
