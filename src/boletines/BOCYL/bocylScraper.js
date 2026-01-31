// src/boletines/bocyl/bocylScraper.js
const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/build/pdf.js');

/**
 * Devuelve la fecha de hoy en formato YYYYMMDD.
 */
function getFechaHoyYYYYMMDD() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Obtiene la lista de publicaciones del BOCYL para una fecha concreta.
 * Debes reemplazar la URL base por la del servicio o RSS del BOCYL.
 */
async function obtenerDocumentosBocylPorFecha(fechaYYYYMMDD) {
  const fecha = fechaYYYYMMDD;
  const baseUrl = 'https://<url-del-bocyl>/api'; // TODO: ajustar
  const listaUrls = []; // aquí irán las URLs de las publicaciones

  // Ejemplo de llamada a un RSS o API para recoger las URLs de los PDFs/HTML.
  // Puedes hacer varias llamadas como en el BOA:contentReference[oaicite:0]{index=0}.
  /*
  const url = `${baseUrl}?fecha=${fecha}`;
  const resp = await axios.get(url);
  // Analiza resp.data y extrae las URLs de los documentos.
  resp.data.items.forEach(item => listaUrls.push(item.pdfUrl));
  */

  return listaUrls;
}

/**
 * Descarga un PDF del BOCYL a partir de su URL y valida que sea un PDF real.
 * Basado en la función de descarga del BOA:contentReference[oaicite:1]{index=1}.
 */
async function descargarBocylPdf(url) {
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

  // Validar encabezado PDF.
  const magic = buf.slice(0, 4).toString('utf8');
  if (magic !== '%PDF') {
    return null;
  }

  return buf;
}

/**
 * Extrae todo el texto de un PDF usando pdfjs-dist:contentReference[oaicite:2]{index=2}.
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
async function procesarBocylPdf(url) {
  const pdfBuffer = await descargarBocylPdf(url);
  if (!pdfBuffer) return null;

  try {
    return await extraerTextoPdf(pdfBuffer);
  } catch {
    return null;
  }
}

/**
 * Extrae la fecha del boletín a partir del texto.
 * Ajusta la expresión regular a cómo se indica la fecha en el BOCYL.
 */
function extraerFechaBoletin(texto) {
  const match = texto && texto.match(/BOCYL(\d{8})/);
  return match ? match[1] : null;
}

/**
 * Divide el texto en disposiciones relevantes, usando patrones similares a BOA:contentReference[oaicite:3]{index=3}.
 * Modifica los patrones si el BOCYL usa encabezados diferentes.
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
  obtenerDocumentosBocylPorFecha,
  descargarBocylPdf,
  extraerTextoPdf,
  procesarBocylPdf,
  extraerFechaBoletin,
  dividirEnDisposiciones,
};
