// Doe Scraper reescrito para Ruralicos
// Este módulo obtiene los PDF del DOE desde la página de últimas publicaciones

const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/build/pdf.js');

/**
 * Devuelve la fecha actual en formato YYYYMMDD. Ajusta si el servidor no está en zona horaria de Madrid.
 */
function getFechaHoyYYYYMMDD() {
  const now = new Date();
  // Convertir a hora de Europa/Madrid usando la API Intl
  const formatter = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [day, month, year] = formatter.format(now).split('/');
  return `${year}${month}${day}`;
}

/**
 * Obtiene la lista de URLs de PDFs del DOE para una fecha dada.
 * Utiliza la página HTML de Últimos DOE para extraer enlaces a PDFs.
 * La URL base debe tener el marcador {fecha} para ser sustituido por YYYYMMDD.
 */
async function obtenerDocumentosDoePorFecha(fechaYYYYMMDD) {
  const baseUrl = process.env.DOE_API_URL || process.env.DOE_RSS_URL || '';
  if (!baseUrl) {
    console.warn('DOE: no hay DOE_API_URL ni DOE_RSS_URL configuradas. Devuelvo lista vacía.');
    return [];
  }
  // Construir la URL reemplazando {fecha}
  const url = baseUrl.includes('{fecha}')
    ? baseUrl.replace('{fecha}', fechaYYYYMMDD)
    : `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}fecha=${fechaYYYYMMDD}`;
  try {
    const resp = await axios.get(url, { timeout: 30000 });
    const html = typeof resp.data === 'string' ? resp.data : '';
    const pdfUrls = [];
    const regex = /href\s*=\s*["']([^"']+\.pdf)["']/gi;
    let m;
    while ((m = regex.exec(html)) !== null) {
      let link = m[1];
      // Convertir rutas relativas en absolutas
      if (!/^https?:\/\//i.test(link)) {
        const { origin, pathname } = new URL(url);
        if (link.startsWith('/')) {
          link = origin + link;
        } else {
          const pathParts = pathname.split('/');
          pathParts.pop();
          link = origin + pathParts.join('/') + '/' + link;
        }
      }
      pdfUrls.push(link);
    }
    // Devolver sin duplicados
    return [...new Set(pdfUrls)];
  } catch (err) {
    console.error('Error obteniendo listado de DOE:', err.message);
    return [];
  }
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
 * Extrae la fecha del boletín a partir del texto. Formato: AAAAMMDD.
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
