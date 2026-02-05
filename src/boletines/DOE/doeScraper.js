// src/boletines/DOE/doeScraper.js
// DOE (Extremadura) — Scraper estable para CRON
// - Calcula fecha de HOY en Europe/Madrid
// - Descarga HTML de "ultimosdoe/mostrardoe.php?fecha=YYYYMMDD&t=o"
// - Extrae enlaces a PDF (absolutos o relativos)
// - Descarga PDF y extrae texto con pdfjs

const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/build/pdf.js');

// URL base FIJA (como BOE/BOA): no dependemos de variables de entorno.
const DOE_LIST_URL = 'https://doe.juntaex.es/ultimosdoe/mostrardoe.php';
const DOE_ORIGIN = 'https://doe.juntaex.es';

/**
 * Fecha hoy en formato YYYYMMDD en zona horaria Europe/Madrid (ideal para cron).
 */
function getFechaHoyYYYYMMDD() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  // es-ES devuelve DD/MM/YYYY
  const [dd, mm, yyyy] = fmt.format(now).split('/');
  return `${yyyy}${mm}${dd}`;
}

/**
 * Construye la URL del listado para una fecha (YYYYMMDD).
 */
function construirUrlListado(fechaYYYYMMDD) {
  // Ejemplo: https://doe.juntaex.es/ultimosdoe/mostrardoe.php?fecha=20260205&t=o
  return `${DOE_LIST_URL}?fecha=${fechaYYYYMMDD}&t=o`;
}

/**
 * Normaliza un enlace (relativo -> absoluto).
 */
function absolutizarUrl(link, baseUrl) {
  if (!link) return null;

  // limpiar entidades HTML básicas
  let cleaned = String(link)
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .trim();

  // a veces viene entre comillas o con espacios raros
  cleaned = cleaned.replace(/^['"]|['"]$/g, '').trim();

  // Si ya es absoluta
  if (/^https?:\/\//i.test(cleaned)) return cleaned;

  // Si empieza por //
  if (cleaned.startsWith('//')) return `https:${cleaned}`;

  // Si empieza por /
  if (cleaned.startsWith('/')) return `${DOE_ORIGIN}${cleaned}`;

  // Relativa respecto al listado
  try {
    return new URL(cleaned, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Extrae URLs de PDFs desde HTML.
 * - Soporta href="...pdf"
 * - Soporta enlaces con parámetros (...pdf?x=y)
 */
function extraerPdfUrlsDesdeHtml(html, baseUrl) {
  const out = new Set();
  if (!html || typeof html !== 'string') return [];

  // Captura enlaces a .pdf con o sin querystring
  // Ej: href=".../archivo.pdf" o href="/ruta/archivo.pdf?abc=1"
  const re = /href\s*=\s*["']([^"']+?\.pdf(?:\?[^"']*)?)["']/gi;

  let m;
  while ((m = re.exec(html)) !== null) {
    const abs = absolutizarUrl(m[1], baseUrl);
    if (abs && abs.toLowerCase().includes('.pdf')) out.add(abs);
  }

  return [...out];
}

/**
 * Obtiene la lista de URLs PDF del DOE para una fecha dada (YYYYMMDD).
 */
async function obtenerDocumentosDoePorFecha(fechaYYYYMMDD) {
  const urlListado = construirUrlListado(fechaYYYYMMDD);

  try {
    const resp = await axios.get(urlListado, {
      timeout: 30000,
      headers: {
        Accept: 'text/html,*/*',
        'User-Agent': 'Mozilla/5.0 (RuralicosBot)',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const html = typeof resp.data === 'string' ? resp.data : '';
    const pdfUrls = extraerPdfUrlsDesdeHtml(html, urlListado);
    return pdfUrls;
  } catch (err) {
    console.error('DOE: error obteniendo listado:', err?.message || err);
    return [];
  }
}

/**
 * Descarga un PDF y comprueba que sea PDF válido (%PDF).
 */
async function descargarDoePdf(url) {
  try {
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
    if (buf.slice(0, 4).toString('utf8') !== '%PDF') return null;
    return buf;
  } catch (err) {
    console.error('DOE: error descargando PDF:', url, err?.message || err);
    return null;
  }
}

/**
 * Extrae texto de un PDF usando pdfjs.
 */
async function extraerTextoPdf(bufferPdf) {
  const uint8Array = new Uint8Array(bufferPdf);
  const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
  const pdf = await loadingTask.promise;

  let texto = '';
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    texto += content.items.map((item) => item.str).join(' ') + '\n';
  }
  return texto;
}

/**
 * Descarga + extrae texto del PDF.
 */
async function procesarDoePdf(url) {
  const pdfBuffer = await descargarDoePdf(url);
  if (!pdfBuffer) return null;

  try {
    return await extraerTextoPdf(pdfBuffer);
  } catch (err) {
    console.error('DOE: error extrayendo texto PDF:', url, err?.message || err);
    return null;
  }
}

/**
 * Extrae fecha del boletín desde el texto si aparece como “DOE dd/mm/aaaa”.
 * Devuelve YYYYMMDD o null.
 */
function extraerFechaBoletin(texto) {
  const match = texto && texto.match(/DOE\s*(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return `${yyyy}${mm}${dd}`;
}

/**
 * Divide texto en disposiciones (opcional; lo mantengo como tenías).
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

  if (indices.length === 0) return [String(texto || '').trim()].filter(Boolean);

  const disposiciones = [];
  const t = String(texto || '');

  for (let i = 0; i < indices.length; i++) {
    const inicio = indices[i];
    const fin = indices[i + 1] ?? t.length;
    const bloque = t.slice(inicio, fin).trim();
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
