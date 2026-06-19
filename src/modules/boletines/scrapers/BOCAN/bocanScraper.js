// src/boletines/BOCAN/bocanScraper.js
//
// Scraper del BOC (Boletín Oficial de Canarias).
//
// El listado de boletines recientes está en:
//   https://www.gobiernodecanarias.org/boc/
// Cada boletín tiene su sumario en:
//   https://www.gobiernodecanarias.org/boc/YYYY/NNN
// donde NNN es el número de boletín con cero a la izquierda (p.ej. 082).
//
// En el sumario, cada disposición tiene:
//   - Un link al PDF en sede.gobiernodecanarias.org con el título completo.
//     Patrón: https://sede.../boc-a-YYYY-NNN-NNNN.pdf
//   - Un link a la versión HTML en /boc/YYYY/NNN/NNNN.html
//     El texto completo está en el div.conten de esa página.

const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.gobiernodecanarias.org';
const LISTING_URL = `${BASE}/boc/`;
const DELAY_MS = 350;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFechaHoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalizarEspacios(texto) {
  return (texto || '').replace(/\s+/g, ' ').trim();
}

function fechaTextoAISO(texto) {
  const meses = {
    enero: '01', febrero: '02', marzo: '03', abril: '04',
    mayo: '05', junio: '06', julio: '07', agosto: '08',
    septiembre: '09', setiembre: '09', octubre: '10',
    noviembre: '11', diciembre: '12',
  };
  const match = normalizarEspacios(texto)
    .toLowerCase()
    .match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/i);
  if (!match) return null;
  const dia = String(Number(match[1])).padStart(2, '0');
  const mes = meses[match[2].normalize('NFD').replace(/\p{Diacritic}/gu, '')];
  return mes ? `${match[3]}-${mes}-${dia}` : null;
}

async function getHtml(url) {
  const { data } = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
  });
  return data;
}

// Convierte la URL del PDF de un anuncio en la URL de su versión HTML.
// "https://sede.../boc-a-2026-082-1379.pdf" → "https://www.../boc/2026/082/1379.html"
function pdfUrlAHtmlUrl(pdfUrl) {
  const match = pdfUrl.match(/boc-a-(\d{4})-(\d{3})-(\d+)\.pdf$/i);
  if (!match) return null;
  return `${BASE}/boc/${match[1]}/${match[2]}/${match[3]}.html`;
}

// Devuelve los boletines recientes del listado principal.
async function obtenerBoletinesRecientes() {
  const html = await getHtml(LISTING_URL);
  const $ = cheerio.load(html);
  const boletines = [];
  const vistos = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const texto = normalizarEspacios($(el).text());

    // URL tipo /boc/YYYY/NNN (3 dígitos con posibles ceros)
    const match = href.match(/^\/boc\/(\d{4})\/(\d{3})$/);
    if (!match) return;

    const key = `${match[1]}-${match[2]}`;
    if (vistos.has(key)) return;
    vistos.add(key);

    const fecha = fechaTextoAISO(texto);
    boletines.push({
      fecha: fecha || '',
      numero: match[2],
      year: match[1],
      url: `${BASE}${href}`,
    });
  });

  return boletines;
}

// Devuelve el boletín que coincide con la fecha pedida, o el más reciente.
async function obtenerBoletinObjetivo(fechaISO) {
  const boletines = await obtenerBoletinesRecientes();
  if (!boletines.length) throw new Error('No se encontraron boletines recientes del BOC Canarias');

  if (fechaISO) {
    const exacto = boletines.find((b) => b.fecha === fechaISO);
    if (exacto) return exacto;
    console.log(`[BOCAN] No hay boletin para la fecha pedida (${fechaISO})`);
    return null;
  }

  return boletines[0];
}

// Extrae las disposiciones del sumario de un boletín.
// Busca los links a PDF de anuncio (boc-a-...) y construye la URL HTML.
async function obtenerDocumentosSumario(boletin) {
  const html = await getHtml(boletin.url);
  const $ = cheerio.load(html);
  const docs = [];
  const vistos = new Set();

  $('a[href*="boc-a-"][href$=".pdf"]').each((_, el) => {
    const pdfHref = $(el).attr('href') || '';
    const titulo = normalizarEspacios($(el).text()).slice(0, 300);

    if (!titulo || titulo.length < 10) return;

    const htmlUrl = pdfUrlAHtmlUrl(pdfHref);
    if (!htmlUrl || vistos.has(htmlUrl)) return;
    vistos.add(htmlUrl);

    docs.push({ titulo, url: htmlUrl, fecha: boletin.fecha });
  });

  return docs;
}

// Extrae el texto completo de la versión HTML de un anuncio.
async function obtenerTextoDocumento(url) {
  try {
    const html = await getHtml(url);
    const $ = cheerio.load(html);
    const texto = normalizarEspacios($('.conten').text());
    return texto.slice(0, 12000);
  } catch {
    return '';
  }
}

// Función principal: disposiciones del BOC Canarias del día indicado
// que superen el filtro esRuralRelevante, con texto completo.
async function obtenerDocumentosBocanConTexto(fechaISO, esRuralRelevante) {
  const boletin = await obtenerBoletinObjetivo(fechaISO || null);
  if (!boletin) return [];

  const todos = await obtenerDocumentosSumario(boletin);
  const resultado = [];

  // Captura bruta: se devuelven TODOS los detectados anotados con `_relevante`; el
  // texto solo se descarga para los relevantes (coste idéntico al de antes).
  for (const doc of todos) {
    if (!esRuralRelevante(doc.titulo)) {
      resultado.push({ ...doc, _relevante: false });
      continue;
    }

    await sleep(DELAY_MS);
    const texto = await obtenerTextoDocumento(doc.url);
    resultado.push({ ...doc, texto: texto || doc.titulo, _relevante: true });
  }

  console.log(`[BOCAN] ${resultado.length} documentos detectados (captura bruta) de ${todos.length}`);
  return resultado;
}

module.exports = {
  obtenerDocumentosBocanConTexto,
  obtenerBoletinesRecientes,
  getFechaHoyISO,
};
