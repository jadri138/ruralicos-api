// src/boletines/DOE/doeScraper.js
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const pdfjsLib = require('pdfjs-dist/build/pdf.js');

const xmlParser = new XMLParser({ ignoreAttributes: false });

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
 * Obtiene la lista de URLs de publicaciones del DOE para una fecha dada.
 * REEMPLAZA la URL base y el parseo según el servicio oficial del DOE.
 */
async function obtenerDocumentosDoePorFecha(fechaYYYYMMDD) {
  const baseUrl =
    process.env.DOE_RSS_URL ||
    process.env.DOE_API_URL ||
    '';

  if (!baseUrl) {
    console.warn(
      'DOE: no hay DOE_RSS_URL ni DOE_API_URL configuradas. Devuelvo lista vacía.'
    );
    return [];
  }

  const shouldAppendFecha = process.env.DOE_APPEND_FECHA === 'true';

  const url = baseUrl.includes('{fecha}')
    ? baseUrl.replace('{fecha}', fechaYYYYMMDD)
    : shouldAppendFecha
      ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}fecha=${fechaYYYYMMDD}`
      : baseUrl;

  const resp = await axios.get(url, {
    timeout: 30000,
    headers: {
      Accept: 'application/xml,application/json,text/xml,*/*',
      'User-Agent': 'Mozilla/5.0 (RuralicosBot)',
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const url = baseUrl.includes('{fecha}')
    ? baseUrl.replace('{fecha}', fechaYYYYMMDD)
    : `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}fecha=${fechaYYYYMMDD}`;

  const resp = await axios.get(url, {
    timeout: 30000,
    headers: {
      Accept: 'application/xml,application/json,text/xml,*/*',
      'User-Agent': 'Mozilla/5.0 (RuralicosBot)',
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const listaUrls = [];
  const contentType = `${resp.headers['content-type'] || ''}`.toLowerCase();

  if (contentType.includes('xml') || typeof resp.data === 'string') {
    const xml = typeof resp.data === 'string' ? resp.data : '';
    if (xml) {
      const json = xmlParser.parse(xml);
      const items =
        json?.rss?.channel?.item ||
        json?.feed?.entry ||
        json?.['rdf:RDF']?.item ||
        [];
      const arrayItems = Array.isArray(items) ? items : [items].filter(Boolean);

      for (const item of arrayItems) {
        const enclosureUrl = item?.enclosure?.['@_url'];
        const link =
          item?.link?.['@_href'] ||
          item?.link?.['#text'] ||
          item?.link ||
          item?.guid?.['#text'] ||
          item?.link ||
          item?.guid ||
          null;
        const candidato = enclosureUrl || link;
        if (typeof candidato === 'string') listaUrls.push(candidato);
      }

      if (listaUrls.length === 0) {
        const pdfMatches = xml.match(/https?:\/\/[^"'\s>]+\.pdf/gi) || [];
        for (const match of pdfMatches) listaUrls.push(match);
      }
    }
  } else if (resp.data && typeof resp.data === 'object') {
    const items = resp.data.items || resp.data.results || [];
    const arrayItems = Array.isArray(items) ? items : [];
    for (const item of arrayItems) {
      const candidato =
        item?.pdfUrl ||
        item?.pdf ||
        item?.url ||
        item?.link ||
        null;
      if (typeof candidato === 'string') listaUrls.push(candidato);
    }
  }

  return [...new Set(listaUrls.filter(Boolean))];
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
