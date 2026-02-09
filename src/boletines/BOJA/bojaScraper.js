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
 * Intenta RSS y listados HTML públicos.
 */
async function obtenerDocumentosBojaPorFecha(fechaYYYYMMDD) {
  const fecha = fechaYYYYMMDD;

  const variantesFecha = [
    fecha,
    `${fecha.slice(0, 4)}/${fecha.slice(4, 6)}/${fecha.slice(6, 8)}`,
    `${fecha.slice(6, 8)}/${fecha.slice(4, 6)}/${fecha.slice(0, 4)}`,
  ];

  const fuentes = [
    {
      tipo: 'xml',
      url: 'https://www.juntadeandalucia.es/boja/rss/boja.xml',
    },
    {
      tipo: 'xml',
      url: 'https://www.juntadeandalucia.es/boja/boletines/rss/boja.xml',
    },
    {
      tipo: 'html',
      url: `https://www.juntadeandalucia.es/boja/boletines?fecha=${fecha}`,
    },
    {
      tipo: 'html',
      url: 'https://www.juntadeandalucia.es/boja/boletines/',
    },
  ];

  const urls = new Set();

  for (const fuente of fuentes) {
    try {
      const resp = await axios.get(fuente.url, {
        timeout: 30000,
        headers: {
          Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (RuralicosBot)',
        },
        validateStatus: (s) => s >= 200 && s < 400,
      });

      const body = typeof resp.data === 'string' ? resp.data : '';
      const encontrados = fuente.tipo === 'xml'
        ? extraerPdfUrlsDesdeXml(body, fuente.url)
        : extraerPdfUrlsDesdeHtml(body, fuente.url);

      for (const link of encontrados) {
        if (variantesFecha.some((v) => link.includes(v))) {
          urls.add(link);
        }
      }

      if (urls.size === 0 && encontrados.length > 0) {
        encontrados.forEach((link) => urls.add(link));
      }

      if (urls.size > 0) break;
    } catch (err) {
      console.error('BOJA: error obteniendo listado:', fuente.url, err?.message || err);
    }
  }

  return [...urls];
}

function absolutizarUrl(link, baseUrl) {
  if (!link) return null;

  let cleaned = String(link)
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .trim();

  cleaned = cleaned.replace(/^['"]|['"]$/g, '').trim();

  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  if (cleaned.startsWith('//')) return `https:${cleaned}`;

  try {
    return new URL(cleaned, baseUrl).toString();
  } catch {
    return null;
  }
}

function extraerPdfUrlsDesdeHtml(html, baseUrl) {
  const out = new Set();
  if (!html || typeof html !== 'string') return [];

  const re = /href\s*=\s*["']([^"']+?\.pdf(?:\?[^"']*)?)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const abs = absolutizarUrl(m[1], baseUrl);
    if (abs) out.add(abs);
  }

  return [...out];
}

function extraerPdfUrlsDesdeXml(xml, baseUrl) {
  const out = new Set();
  if (!xml || typeof xml !== 'string') return [];

  const re = /https?:[^\s"'<>]+\.pdf(?:\?[^\s"'<>]+)?/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const abs = absolutizarUrl(m[0], baseUrl);
    if (abs) out.add(abs);
  }

  return [...out];
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
