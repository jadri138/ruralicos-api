// src/boletines/BOJA/bojaScraper.js
const axios = require('axios');
// En Node suele ir mejor el "legacy build"
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

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

  // Variantes para filtrar enlaces que contengan la fecha
  const variantesFecha = [
    fecha,
    `${fecha.slice(0, 4)}/${fecha.slice(4, 6)}/${fecha.slice(6, 8)}`,
    `${fecha.slice(6, 8)}/${fecha.slice(4, 6)}/${fecha.slice(0, 4)}`,
  ];

  const fuentes = [
    { tipo: 'xml', url: 'https://www.juntadeandalucia.es/boja/rss/boja.xml' },
    { tipo: 'xml', url: 'https://www.juntadeandalucia.es/boja/boletines/rss/boja.xml' },
    { tipo: 'html', url: `https://www.juntadeandalucia.es/boja/boletines?fecha=${fecha}` },
    { tipo: 'html', url: 'https://www.juntadeandalucia.es/boja/boletines/' },
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
      const encontrados =
        fuente.tipo === 'xml'
          ? extraerPdfUrlsDesdeXml(body, fuente.url)
          : extraerPdfUrlsDesdeHtml(body, fuente.url);

      // 1) Preferimos links que contengan la fecha
      for (const link of encontrados) {
        if (variantesFecha.some((v) => link.includes(v))) {
          urls.add(link);
        }
      }

      // 2) Si no hay coincidencias por fecha, devolvemos lo encontrado igualmente
      if (urls.size === 0 && encontrados.length > 0) {
        encontrados.forEach((link) => urls.add(link));
      }

      // Si ya hemos sacado algo, paramos
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

  // Busca cualquier URL a PDF dentro del XML
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
 * Procesa el PDF (Buffer) y devuelve texto plano.
 * IMPORTANTE: el endpoint te estaba llamando a esto y no existía.
 */
async function procesarBojaPdf(pdfBuffer) {
  if (!pdfBuffer) return '';

  const loadingTask = pdfjsLib.getDocument({ data: pdfBuffer });
  const pdf = await loadingTask.promise;

  let texto = '';

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const strings = content.items.map((it) => it.str);
    texto += strings.join(' ') + '\n';
  }

  return texto.trim();
}

module.exports = {
  getFechaHoyYYYYMMDD,
  obtenerDocumentosBojaPorFecha,
  descargarBojaPdf,
  procesarBojaPdf,
};
