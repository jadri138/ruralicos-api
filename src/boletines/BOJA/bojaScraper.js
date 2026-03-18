// src/boletines/BOJA/bojaScraper.js
//
// Estructura real del BOJA (verificada en el HTML fuente):
//
//   Índice boletín:  https://www.juntadeandalucia.es/eboja/2026/53/
//   Secciones:       /eboja/2026/53/s51, s52, s53, s54, s55, s57...
//   PDFs (relativos en el HTML): BOJA26-053-00009-3692-01_00334913.pdf
//   PDFs (absolutos):            https://www.juntadeandalucia.es/eboja/2026/53/BOJA26-...pdf
//   HTML disposición:            https://www.juntadeandalucia.es/boja/2026/53/1
//
// Estrategia:
//   1. Obtener el número de boletín de hoy desde /eboja/2026.html o siguiendo /BOJA
//   2. Leer el índice del boletín + todas sus secciones (s51, s52...)
//   3. Extraer todos los hrefs relativos a PDF y absolutizarlos
//   4. Para cada PDF, leer el HTML de la disposición (más limpio que parsear PDF)

const axios = require('axios');

const BASE_EBOJA = 'https://www.juntadeandalucia.es/eboja';
const BASE_BOJA  = 'https://www.juntadeandalucia.es/boja';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (RuralicosBot/2.0)',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9',
};

function getFechaHoyYYYYMMDD() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

function htmlATexto(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Obtiene el número de boletín publicado en la fecha dada.
 * Prueba 3 estrategias en cascada.
 */
async function obtenerNumerosBoletinPorFecha(fechaYYYYMMDD) {
  const anyo = fechaYYYYMMDD.slice(0, 4);
  const mes  = fechaYYYYMMDD.slice(4, 6);
  const dia  = fechaYYYYMMDD.slice(6, 8);
  const fechaES = `${dia}/${mes}/${anyo}`;

  const numeros = new Set();

  // ── Estrategia 1: seguir redirección de /BOJA ──────────────────────────────
  try {
    const resp = await axios.get('https://www.juntadeandalucia.es/BOJA', {
      headers: HEADERS, timeout: 20000, maxRedirects: 5,
    });
    const finalUrl = resp.request?.res?.responseUrl || resp.config?.url || '';
    const mUrl = finalUrl.match(/\/eboja\/\d{4}\/(\d+)\/?/);
    if (mUrl) {
      const html = typeof resp.data === 'string' ? resp.data : '';
      if (html.includes(fechaES)) {
        numeros.add(mUrl[1]);
        console.log(`[BOJA] Boletín por redirección /BOJA: nº${mUrl[1]} (${fechaES})`);
      }
    }
  } catch (err) {
    console.warn('[BOJA] Error siguiendo /BOJA:', err.message);
  }

  // ── Estrategia 2: índice del año ───────────────────────────────────────────
  if (numeros.size === 0) {
    try {
      const resp = await axios.get(`${BASE_EBOJA}/${anyo}.html`, {
        headers: HEADERS, timeout: 30000,
      });
      const html = typeof resp.data === 'string' ? resp.data : '';
      const reFecha = new RegExp(fechaES.replace(/\//g, '\\/'), 'g');
      let m;
      while ((m = reFecha.exec(html)) !== null) {
        const entorno = html.slice(Math.max(0, m.index - 400), m.index + 400);
        const mN = entorno.match(/\/eboja\/\d{4}\/(\d+)\/?/i);
        if (mN) {
          numeros.add(mN[1]);
          console.log(`[BOJA] Boletín en índice año: nº${mN[1]} (${fechaES})`);
        }
      }
    } catch (err) {
      console.error('[BOJA] Error obteniendo índice del año:', err.message);
    }
  }

  // ── Estrategia 3: fuerza bruta por número estimado ─────────────────────────
  if (numeros.size === 0) {
    console.warn('[BOJA] Intentando búsqueda por fuerza bruta...');
    const diaDelAnyo = Math.ceil(
      (new Date(`${anyo}-${mes}-${dia}`) - new Date(`${anyo}-01-01`)) / (1000*60*60*24)
    );
    const estimado = Math.round(diaDelAnyo * 0.7);
    for (let n = Math.max(1, estimado - 5); n <= estimado + 5; n++) {
      try {
        const resp = await axios.get(`${BASE_EBOJA}/${anyo}/${n}/`, {
          headers: HEADERS, timeout: 10000, validateStatus: s => s === 200,
        });
        const html = typeof resp.data === 'string' ? resp.data : '';
        if (html.includes(fechaES)) {
          numeros.add(String(n));
          console.log(`[BOJA] Boletín por fuerza bruta: nº${n}`);
          break;
        }
      } catch { /* 404 esperado */ }
    }
  }

  return [...numeros];
}

/**
 * Extrae hrefs a PDFs del HTML y los absolutiza con la URL base del boletín.
 * Los PDFs en el BOJA son RELATIVOS: href="BOJA26-053-00009-....pdf"
 */
function extraerPdfsDeHtml(html, baseUrl, setDestino) {
  const re = /href=["']([^"']*(?:BOJA[\w-]+\.pdf)[^"']*)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    let urlAbsoluta;
    if (/^https?:\/\//i.test(href)) {
      urlAbsoluta = href;
    } else if (href.startsWith('/')) {
      urlAbsoluta = `https://www.juntadeandalucia.es${href}`;
    } else {
      // href relativo puro — concatenar con base del boletín
      urlAbsoluta = `${baseUrl}${href}`;
    }
    setDestino.add(urlAbsoluta);
  }
}

/**
 * Dado el número de boletín y el año, extrae todos los PDFs de todas las secciones.
 */
async function obtenerPdfsDeBoletín(anyo, numBoletin) {
  const baseBoletín = `${BASE_EBOJA}/${anyo}/${numBoletin}/`;
  const pdfs = new Set();
  let secciones = [];

  // Leer índice principal — descubrir secciones disponibles y sus PDFs
  try {
    const resp = await axios.get(baseBoletín, {
      headers: HEADERS, timeout: 20000, validateStatus: s => s === 200,
    });
    const html = typeof resp.data === 'string' ? resp.data : '';

    // Descubrir secciones: href="s51", href="s52"...
    const reSec = /href=["'](s\d+)["']/gi;
    let m;
    while ((m = reSec.exec(html)) !== null) secciones.push(m[1]);
    secciones = [...new Set(secciones)];

    // PDFs del índice principal
    extraerPdfsDeHtml(html, baseBoletín, pdfs);

    console.log(`[BOJA] Boletín ${numBoletin}: secciones ${secciones.join(', ')}`);
  } catch (err) {
    console.error(`[BOJA] Error leyendo índice del boletín ${numBoletin}:`, err.message);
    return [];
  }

  // Leer cada sección
  for (const sec of secciones) {
    try {
      const resp = await axios.get(`${baseBoletín}${sec}`, {
        headers: HEADERS, timeout: 15000, validateStatus: s => s === 200,
      });
      const html = typeof resp.data === 'string' ? resp.data : '';
      extraerPdfsDeHtml(html, baseBoletín, pdfs);
    } catch (err) {
      if (err?.response?.status !== 404) {
        console.warn(`[BOJA] Error en sección ${sec}:`, err.message);
      }
    }
  }

  // Excluir sumarios (_10000 en el nombre)
  const resultado = [...pdfs].filter(u => !u.includes('_10000'));
  console.log(`[BOJA] Boletín ${numBoletin}: ${resultado.length} PDFs de disposiciones`);
  return resultado;
}

/**
 * Convierte URL de PDF a URL del HTML de la disposición.
 *
 * PDF:  .../eboja/2026/53/BOJA26-053-00009-3692-01_00334913.pdf
 * HTML: .../boja/2026/53/9
 *
 * El número al final del HTML es el orden de la disposición,
 * que corresponde al segmento "-NNNNN-" del nombre del PDF.
 */
function pdfUrlAHtmlUrl(pdfUrl) {
  try {
    // Patrón: /eboja/YYYY/NUM/[seccion/]BOJA-NUM-ORDEN-...pdf
    const m = pdfUrl.match(/\/eboja\/(\d{4})\/(\d+)\/(?:[^/]+\/)?BOJA[\w]+-\d+-(\d+)-[\w.]+\.pdf/i);
    if (!m) return null;
    const anyo  = m[1];
    const num   = m[2];
    const orden = String(parseInt(m[3], 10)); // "00009" → "9"
    return `${BASE_BOJA}/${anyo}/${num}/${orden}`;
  } catch {
    return null;
  }
}

/**
 * Obtiene el texto de una disposición.
 * Intenta HTML primero, luego PDF como fallback.
 */
async function obtenerTextoBoja(pdfUrl) {
  // Intento 1: versión HTML
  const htmlUrl = pdfUrlAHtmlUrl(pdfUrl);
  if (htmlUrl) {
    try {
      const resp = await axios.get(htmlUrl, {
        headers: HEADERS, timeout: 20000, validateStatus: s => s === 200,
      });
      const texto = htmlATexto(typeof resp.data === 'string' ? resp.data : '');
      if (texto && texto.length > 200) {
        return { texto, url: pdfUrl, htmlUrl };
      }
    } catch (err) {
      console.warn(`[BOJA] HTML no disponible (${htmlUrl}):`, err.message);
    }
  }

  // Intento 2: PDF con pdfjs
  try {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const respPdf = await axios.get(pdfUrl, {
      responseType: 'arraybuffer',
      headers: { ...HEADERS, Accept: 'application/pdf,*/*' },
      timeout: 30000,
    });
    const buf = Buffer.from(respPdf.data);
    if (buf.slice(0, 4).toString('utf8') !== '%PDF') return null;

    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let texto = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      texto += content.items.map(it => it.str).join(' ') + '\n';
    }
    return { texto: texto.trim(), url: pdfUrl, htmlUrl: null };
  } catch (err) {
    console.error(`[BOJA] Error obteniendo PDF ${pdfUrl}:`, err.message);
    return null;
  }
}

/**
 * Punto de entrada principal — devuelve array de URLs de PDFs para la fecha dada.
 */
async function obtenerDocumentosBojaPorFecha(fechaYYYYMMDD) {
  const anyo = fechaYYYYMMDD.slice(0, 4);
  const numeros = await obtenerNumerosBoletinPorFecha(fechaYYYYMMDD);

  if (numeros.length === 0) {
    console.log(`[BOJA] No se encontró boletín para ${fechaYYYYMMDD}`);
    return [];
  }

  const todasLasUrls = [];
  for (const num of numeros) {
    const pdfs = await obtenerPdfsDeBoletín(anyo, num);
    todasLasUrls.push(...pdfs);
  }
  return todasLasUrls;
}

/**
 * Compatibilidad con boja.js (mantiene firma antigua).
 */
async function descargarBojaPdf(url) {
  const resultado = await obtenerTextoBoja(url);
  return resultado ? { _textoDirecto: resultado.texto } : null;
}

async function procesarBojaPdf(input) {
  if (input && input._textoDirecto) return input._textoDirecto;

  if (Buffer.isBuffer(input)) {
    try {
      const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
      const pdf = await pdfjsLib.getDocument({ data: input }).promise;
      let texto = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        texto += content.items.map(it => it.str).join(' ') + '\n';
      }
      return texto.trim();
    } catch (err) {
      console.error('[BOJA] Error procesando PDF buffer:', err.message);
      return '';
    }
  }
  return '';
}

module.exports = {
  getFechaHoyYYYYMMDD,
  obtenerDocumentosBojaPorFecha,
  descargarBojaPdf,
  procesarBojaPdf,
  obtenerNumerosBoletinPorFecha,
  obtenerPdfsDeBoletín,
  obtenerTextoBoja,
};