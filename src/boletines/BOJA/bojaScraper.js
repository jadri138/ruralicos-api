// src/boletines/BOJA/bojaScraper.js
//
// Estructura real del BOJA (sede electrónica):
//   Índice año:      https://www.juntadeandalucia.es/eboja/2026.html
//   Índice boletín:  https://www.juntadeandalucia.es/eboja/2026/{num}/index.html
//   Complementarios: https://www.juntadeandalucia.es/eboja/2026/{num}/c01/index.html
//   PDF disposición: https://www.juntadeandalucia.es/eboja/2026/{num}/[sección]/BOJA26-...pdf
//   HTML disposición:https://www.juntadeandalucia.es/boja/2026/{num}/[sección]/{orden}
//
// Estrategia:
//   1. Obtener el número de boletín de hoy desde el índice del año
//   2. Leer el índice del boletín y extraer los PDFs de cada disposición
//   3. Para cada PDF, usar la URL HTML alternativa para obtener texto plano
//      (más fiable que parsear PDF con pdfjs)

const axios = require('axios');

const BASE_EBOJA = 'https://www.juntadeandalucia.es/eboja';
const BASE_BOJA  = 'https://www.juntadeandalucia.es/boja';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (RuralicosBot/2.0)',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9',
};

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
 * Extrae texto plano de HTML (quita tags, entidades, espacios múltiples).
 */
function htmlATexto(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Busca el número de boletín publicado en la fecha dada.
 *
 * Estrategia 1: seguir la redirección de /BOJA (último boletín) y verificar fecha.
 * Estrategia 2: buscar en el índice del año por fecha.
 * Estrategia 3: fuerza bruta — probar números estimados.
 */
async function obtenerNumerosBoletinPorFecha(fechaYYYYMMDD) {
  const anyo   = fechaYYYYMMDD.slice(0, 4);
  const mes    = fechaYYYYMMDD.slice(4, 6);
  const dia    = fechaYYYYMMDD.slice(6, 8);
  const fechaES = `${dia}/${mes}/${anyo}`; // "18/03/2026"

  const numeros = new Set();

  // ── Estrategia 1: seguir redirección de /BOJA ──────────────────────────────
  try {
    const resp = await axios.get('https://www.juntadeandalucia.es/BOJA', {
      headers: HEADERS,
      timeout: 20000,
      maxRedirects: 5,
    });
    const finalUrl = resp.request?.res?.responseUrl || '';
    const mUrl = finalUrl.match(/\/eboja\/\d{4}\/(\d+)\//);
    if (mUrl) {
      const numCandidato = mUrl[1];
      const html = typeof resp.data === 'string' ? resp.data : '';
      if (html.includes(fechaES)) {
        numeros.add(numCandidato);
        console.log(`[BOJA] Boletín por redirección: nº${numCandidato} (${fechaES})`);
      }
    }
  } catch (err) {
    console.warn('[BOJA] Error siguiendo redirección /BOJA:', err.message);
  }

  // ── Estrategia 2: buscar en el índice del año ──────────────────────────────
  if (numeros.size === 0) {
    try {
      const urlAnyo = `${BASE_EBOJA}/${anyo}.html`;
      const resp = await axios.get(urlAnyo, { headers: HEADERS, timeout: 30000 });
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
      console.error(`[BOJA] Error obteniendo índice del año ${anyo}:`, err.message);
    }
  }

  // ── Estrategia 3: fuerza bruta por número estimado ─────────────────────────
  if (numeros.size === 0) {
    console.warn('[BOJA] Intentando búsqueda por fuerza bruta...');
    const diaDelAnyo = Math.ceil(
      (new Date(`${anyo}-${mes}-${dia}`) - new Date(`${anyo}-01-01`)) /
      (1000 * 60 * 60 * 24)
    );
    const estimado = Math.round(diaDelAnyo * 0.7);

    for (let n = Math.max(1, estimado - 5); n <= estimado + 5; n++) {
      try {
        const urlIdx = `${BASE_EBOJA}/${anyo}/${n}/index.html`;
        const resp = await axios.get(urlIdx, {
          headers: HEADERS,
          timeout: 10000,
          validateStatus: (s) => s === 200,
        });
        const html = typeof resp.data === 'string' ? resp.data : '';
        if (html.includes(fechaES)) {
          numeros.add(String(n));
          console.log(`[BOJA] Boletín por fuerza bruta: nº${n}`);
          break;
        }
      } catch {
        // 404 esperado
      }
    }
  }

  return [...numeros];
}


/**
 * Dado un número de boletín y año, devuelve todos los PDFs de sus disposiciones.
 * Recorre el índice principal y los complementarios (c01, c02...).
 */
async function obtenerPdfsDeBoletín(anyo, numBoletin) {
  const pdfs = new Set();

  // Secciones a revisar: índice principal + complementarios hasta c05
  const secciones = ['', 'c01', 'c02', 'c03', 'c04', 'c05'];

  for (const sec of secciones) {
    const urlIndice = sec
      ? `${BASE_EBOJA}/${anyo}/${numBoletin}/${sec}/index.html`
      : `${BASE_EBOJA}/${anyo}/${numBoletin}/index.html`;

    try {
      const resp = await axios.get(urlIndice, {
        headers: HEADERS,
        timeout: 20000,
        validateStatus: (s) => s === 200, // solo 200, no seguir en 404
      });

      const html = typeof resp.data === 'string' ? resp.data : '';
      if (!html) continue;

      // Extraer todos los hrefs a PDFs dentro de eboja/
      const rePdf = /href=["']([^"']*\/eboja\/[^"']+\.pdf[^"']*)["']/gi;
      let m;
      while ((m = rePdf.exec(html)) !== null) {
        const url = m[1].startsWith('http')
          ? m[1]
          : `https://www.juntadeandalucia.es${m[1]}`;
        // Excluir PDFs de sumario (solo queremos disposiciones individuales)
        if (!url.includes('_10000')) {
          pdfs.add(url);
        }
      }
    } catch (err) {
      // 404 en secciones complementarias es normal, no es un error
      if (err?.response?.status !== 404) {
        console.error(`[BOJA] Error en índice ${urlIndice}:`, err.message);
      }
    }
  }

  return [...pdfs];
}

/**
 * Dado un PDF URL del BOJA, intenta obtener el texto HTML de la disposición.
 * El BOJA tiene una versión HTML en boja/ (sin 'e') para cada disposición.
 *
 * PDF:  https://www.juntadeandalucia.es/eboja/2026/53/c01/BOJA26-205301-00001-3880-01_00335102.pdf
 * HTML: https://www.juntadeandalucia.es/boja/2026/53/c01/1
 *
 * El número al final (1, 2, 3...) es el orden de la disposición en esa sección.
 * Lo extraemos del nombre del PDF: el segmento "-00001-" indica orden 1.
 */
function pdfUrlAHtmlUrl(pdfUrl) {
  try {
    // Extraer año, num boletín, sección del PDF url
    // Patrón: /eboja/2026/53/c01/BOJA26-205301-00001-...pdf
    const m = pdfUrl.match(/\/eboja\/(\d{4})\/(\d+)\/((?:c\d+\/)?)BOJA[\w-]+-(\d+)-[\w.]+\.pdf/i);
    if (!m) return null;

    const anyo   = m[1];
    const num    = m[2];
    const sec    = m[3].replace(/\/$/, ''); // "c01" o ""
    const orden  = String(parseInt(m[4], 10)); // quitar ceros: "00001" → "1"

    const secPath = sec ? `/${sec}` : '';
    return `${BASE_BOJA}/${anyo}/${num}${secPath}/${orden}`;
  } catch {
    return null;
  }
}

/**
 * Descarga el texto de una disposición del BOJA.
 * Primero intenta la versión HTML (más limpia), luego cae al PDF.
 */
async function obtenerTextoBoja(pdfUrl) {
  // Intento 1: versión HTML
  const htmlUrl = pdfUrlAHtmlUrl(pdfUrl);
  if (htmlUrl) {
    try {
      const resp = await axios.get(htmlUrl, {
        headers: HEADERS,
        timeout: 20000,
        validateStatus: (s) => s === 200,
      });
      const texto = htmlATexto(typeof resp.data === 'string' ? resp.data : '');
      if (texto && texto.length > 100) {
        return { texto, url: pdfUrl, htmlUrl };
      }
    } catch (err) {
      console.warn(`[BOJA] HTML no disponible para ${htmlUrl}:`, err.message);
    }
  }

  // Intento 2: PDF directo con pdfjs
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
      texto += content.items.map((it) => it.str).join(' ') + '\n';
    }

    return { texto: texto.trim(), url: pdfUrl, htmlUrl: null };
  } catch (err) {
    console.error(`[BOJA] Error obteniendo PDF ${pdfUrl}:`, err.message);
    return null;
  }
}

/**
 * Punto de entrada principal.
 * Devuelve array de { texto, url, htmlUrl } para la fecha dada.
 */
async function obtenerDocumentosBojaPorFecha(fechaYYYYMMDD) {
  const anyo = fechaYYYYMMDD.slice(0, 4);

  // 1) Encontrar los números de boletín de hoy
  const numeros = await obtenerNumerosBoletinPorFecha(fechaYYYYMMDD);

  if (numeros.length === 0) {
    console.log(`[BOJA] No se encontraron boletines para la fecha ${fechaYYYYMMDD}`);
    return [];
  }

  console.log(`[BOJA] Boletines encontrados para ${fechaYYYYMMDD}: ${numeros.join(', ')}`);

  // 2) Para cada boletín, obtener sus PDFs
  const todasLasUrls = [];
  for (const num of numeros) {
    const pdfs = await obtenerPdfsDeBoletín(anyo, num);
    console.log(`[BOJA] Boletín ${num}: ${pdfs.length} PDFs encontrados`);
    todasLasUrls.push(...pdfs);
  }

  return todasLasUrls;
}

/**
 * Compatibilidad con boja.js — mantiene la firma antigua descargarBojaPdf/procesarBojaPdf
 * pero ahora solo se usan internamente.
 */
async function descargarBojaPdf(url) {
  const resultado = await obtenerTextoBoja(url);
  // Devolvemos un objeto especial que procesarBojaPdf reconoce
  return resultado ? { _textoDirecto: resultado.texto } : null;
}

async function procesarBojaPdf(input) {
  // Si recibimos el objeto con texto ya extraído, lo devolvemos directamente
  if (input && input._textoDirecto) {
    return input._textoDirecto;
  }
  // Fallback: input es un Buffer PDF (ruta antigua)
  if (Buffer.isBuffer(input)) {
    try {
      const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
      const pdf = await pdfjsLib.getDocument({ data: input }).promise;
      let texto = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        texto += content.items.map((it) => it.str).join(' ') + '\n';
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
  // Exportamos también las nuevas funciones por si se quieren usar directamente
  obtenerNumerosBoletinPorFecha,
  obtenerPdfsDeBoletín,
  obtenerTextoBoja,
};