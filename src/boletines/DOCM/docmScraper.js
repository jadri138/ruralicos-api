const axios = require('axios');
const { htmlATexto } = require('../../utils/htmlParser');
const { extraerTextoPdf } = require('../../utils/pdfExtractor');

const DOCM_BASE = 'https://docm.jccm.es/docm/';

function getFechaHoyYYYYMMDD() {
  const fmt = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [dd, mm, yyyy] = fmt.format(new Date()).split('/');
  return `${yyyy}${mm}${dd}`;
}

function absoluta(href) {
  if (!href) return null;
  const cleaned = href.replace(/&amp;/g, '&').trim();
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  if (cleaned.startsWith('/docm/')) return `https://docm.jccm.es${cleaned}`;
  if (cleaned.startsWith('/')) return `https://docm.jccm.es${cleaned}`;
  return `${DOCM_BASE}${cleaned}`;
}

// Extrae entradas de documentos del HTML del índice diario.
// Cada enlace a verArchivoHtml.do contiene el título y la ruta del fichero.
function parsearIndice(html, fechaYYYYMMDD) {
  const entradas = [];
  const fechaISO = `${fechaYYYYMMDD.slice(0, 4)}-${fechaYYYYMMDD.slice(4, 6)}-${fechaYYYYMMDD.slice(6, 8)}`;

  const re = /href\s*=\s*["']([^"']*verArchivoHtml\.do\?ruta=([^&"']+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const ruta = decodeURIComponent(m[2].replace(/&amp;/g, '&'));
    const tituloRaw = m[3];

    const titulo = tituloRaw
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 250);

    if (!titulo || titulo.length < 5) continue;

    const htmlUrl = absoluta(href.replace(/&amp;/g, '&'));

    // Derivar URL PDF sustituyendo /html/ → /pdf/ y .html → .pdf en la ruta
    const rutaPdf = ruta.replace('/html/', '/pdf/').replace(/\.html$/, '.pdf');
    const pdfUrl = `${DOCM_BASE}descargarArchivo.do?ruta=${rutaPdf}&tipo=rutaDocm`;

    // Fecha desde la ruta (formato YYYY/MM/DD/...)
    const partes = ruta.split('/');
    const fecha = partes.length >= 3
      ? `${partes[0]}-${partes[1]}-${partes[2]}`
      : fechaISO;

    entradas.push({ titulo, htmlUrl, pdfUrl, fecha });
  }

  return entradas;
}

async function obtenerTextoDocm(htmlUrl, pdfUrl) {
  // Intento 1: HTML
  if (htmlUrl) {
    try {
      const { data } = await axios.get(htmlUrl, {
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (RuralicosBot/2.0)',
          Accept: 'text/html',
          Referer: DOCM_BASE,
        },
      });
      const texto = htmlATexto(String(data));
      if (texto.length > 200) return texto;
    } catch (e) {
      console.warn(`[DOCM] HTML no disponible (${htmlUrl}): ${e.message}`);
    }
  }

  // Intento 2: PDF
  if (pdfUrl) {
    try {
      const { data } = await axios.get(pdfUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (RuralicosBot/2.0)',
          Accept: 'application/pdf,*/*',
          Referer: DOCM_BASE,
        },
        validateStatus: s => s >= 200 && s < 400,
      });
      const buf = Buffer.from(data);
      if (buf.slice(0, 4).toString('utf8') === '%PDF') {
        return await extraerTextoPdf(buf);
      }
    } catch (e) {
      console.warn(`[DOCM] PDF no disponible (${pdfUrl}): ${e.message}`);
    }
  }

  return '';
}

async function obtenerDocumentosDocmPorFecha(fechaYYYYMMDD) {
  const urlIndice = `${DOCM_BASE}cambiarBoletin.do?fecha=${fechaYYYYMMDD}`;
  console.log('[DOCM] Índice →', urlIndice);

  let html;
  try {
    const { data } = await axios.get(urlIndice, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (RuralicosBot/2.0)',
        Accept: 'text/html',
        Referer: DOCM_BASE,
      },
      validateStatus: s => s >= 200 && s < 400,
    });
    html = typeof data === 'string' ? data : '';
  } catch (e) {
    console.error('[DOCM] Error obteniendo índice:', e.message);
    return [];
  }

  const entradas = parsearIndice(html, fechaYYYYMMDD);
  if (!entradas.length) {
    console.log('[DOCM] Sin documentos en el índice para', fechaYYYYMMDD);
    return [];
  }

  console.log(`[DOCM] ${entradas.length} entradas encontradas`);

  const resultado = [];
  for (const entrada of entradas) {
    const texto = await obtenerTextoDocm(entrada.htmlUrl, entrada.pdfUrl);
    resultado.push({
      titulo: entrada.titulo,
      url: entrada.pdfUrl,
      texto,
      fecha: entrada.fecha,
      seccion: '',
    });
  }

  return resultado;
}

module.exports = { getFechaHoyYYYYMMDD, obtenerDocumentosDocmPorFecha };