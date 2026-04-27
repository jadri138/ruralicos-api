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


// Decodifica entidades HTML básicas en un título.
function decodificarEntidades(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/g, ' ');
}

// Extrae entradas de documentos del HTML del índice diario.
// El DOCM usa <a href="./descargarArchivo.do?ruta=.../pdf/NID.pdf&amp;tipo=rutaDocm" class="new-window">TITULO</a>
// para cada disposición. La URL HTML se deriva sustituyendo /pdf/ → /html/ y .pdf → .html.
function parsearIndice(html, fechaYYYYMMDD) {
  const entradas = [];
  const vistos = new Set();
  const fechaISO = `${fechaYYYYMMDD.slice(0, 4)}-${fechaYYYYMMDD.slice(4, 6)}-${fechaYYYYMMDD.slice(6, 8)}`;

  // Captura: ruta del PDF (group 1), NID sin extensión (group 2), texto del enlace (group 3)
  const re = /href="[^"]*descargarArchivo\.do\?ruta=([\d]{4}\/[\d]{2}\/[\d]{2}\/pdf\/([^"&]+)\.pdf)&amp;tipo=rutaDocm"[^>]*class\s*=\s*"new-window"[^>]*>([\s\S]*?)<\/a>/gi;

  let m;
  while ((m = re.exec(html)) !== null) {
    const rutaPdf = m[1];
    const nid = m[2];
    const tituloRaw = m[3];

    // Normalizar título (descartar iconos u otras entradas sin texto real)
    const titulo = decodificarEntidades(
      tituloRaw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    ).slice(0, 250);

    if (!titulo || titulo.length < 5) continue;
    if (vistos.has(nid)) continue;
    vistos.add(nid);

    const pdfUrl = `${DOCM_BASE}descargarArchivo.do?ruta=${rutaPdf}&tipo=rutaDocm`;
    const rutaHtml = rutaPdf.replace('/pdf/', '/html/').replace(/\.pdf$/, '.html');
    const htmlUrl = `${DOCM_BASE}verArchivoHtml.do?ruta=${rutaHtml}&tipo=rutaDocm`;

    const partes = rutaPdf.split('/');
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