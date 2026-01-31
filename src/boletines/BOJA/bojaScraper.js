// src/boletines/BOJA/bojaScraper.js
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

/**
 * Obtiene la lista de URLs de las publicaciones del BOJA para una fecha dada.
 * REEMPLAZA la URL base y el parseo según el servicio o RSS del BOJA.
 */
async function obtenerDocumentosBojaPorFecha(fechaYYYYMMDD) {
  const fecha = fechaYYYYMMDD;
  const baseUrl = 'https://<url-del-boja>/api'; // TODO: ajustar
  const listaUrls = []; // Aquí irán las URLs de los PDFs/HTML.

  // Ejemplo genérico de llamada. Ajusta según la estructura real del BOJA.
  /*
  const url = `${baseUrl}?fecha=${fecha}`;
  const resp = await axios.get(url);
  // Analiza resp.data y extrae las URLs de los documentos.
  resp.data.items.forEach(item => listaUrls.push(item.pdfUrl));
  */

  return listaUrls;
}

/**
 * Descarga un PDF del BOJA y comprueba que sea un PDF válido.
 */
async function descargarBojaPdf(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 5,
    headers: {
      Accept: 'application/pdf,*/*',
      'User-Agent': 'Mozilla/5.0 (RuralicosBot)'
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
async function procesarBojaPdf(url) {
  const pdfBuffer = await descargarBojaPdf(url);
  if (!pdfBuffer) return null;
  try {
    return await extraerTextoPdf(pdfBuffer);
  } catch {
    return null;
  }
}

/**
 * Extrae la fecha del boletín a partir del texto.
 * Ajusta la expresión regular según cómo la indica el BOJA.
 */
function extraerFechaBoletin(texto) {
  const match = texto && texto.match(/BOJA\s*(\d{2})\/(\d{2})\/(\d{4})/);
  if (match) {
    // Convierte DD/MM/AAAA a AAAAMMDD
    const [ , dd, mm, yyyy ] = match;
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
  obtenerDocumentosBojaPorFecha,
  descargarBojaPdf,
  extraerTextoPdf,
  procesarBojaPdf,
  extraerFechaBoletin,
  dividirEnDisposiciones,
};
