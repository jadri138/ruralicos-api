// src/boletines/BOPA/bopaScraper.js
//
// Scraper del BOPA (Boletín Oficial del Principado de Asturias).
//
// El portal usa Liferay en miprincipado.asturias.es.
// La página de listado (sede.asturias.es/bopa) incluye links a sumarios con el patrón:
//   https://miprincipado.asturias.es/bopa-sumario?...&p_r_p_summaryDate=DD%2FMM%2FYYYY&...
// En el sumario, cada disposición se representa como un par <dt>/<dd>:
//   <dt>Título completo [Cód. YYYY-NNNNN]</dt>
//   <dd><a title="Texto de la disposición" href="..."></dd>
// El texto completo está en #main-content de la página de la disposición.

const axios = require('axios');
const cheerio = require('cheerio');

const LISTING_URL = 'https://sede.asturias.es/bopa';
const BASE_SUMARIO = 'https://miprincipado.asturias.es/bopa-sumario';
const SUMARIO_PARAMS =
  'p_p_id=pa_sede_bopa_web_portlet_SedeBopaSummaryWeb' +
  '&p_p_lifecycle=0&p_p_state=normal&p_p_mode=view' +
  '&p_r_p_summaryIsSearch=false';

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

// YYYY-MM-DD → DD%2FMM%2FYYYY (formato que usa la URL del sumario BOPA)
function fechaIsoABopaParam(fechaISO) {
  const [yyyy, mm, dd] = fechaISO.split('-');
  return `${dd}%2F${mm}%2F${yyyy}`;
}

// Extrae la fecha ISO de un href de sumario BOPA (DD%2FMM%2FYYYY → YYYY-MM-DD)
function extraerFechaDeHref(href) {
  const match = href.match(/p_r_p_summaryDate=(\d{2})%2F(\d{2})%2F(\d{4})/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function buildSumarioUrl(fechaISO) {
  return `${BASE_SUMARIO}?${SUMARIO_PARAMS}&p_r_p_summaryDate=${fechaIsoABopaParam(fechaISO)}`;
}

async function getHtml(url) {
  const { data } = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
  });
  return data;
}

// Devuelve los boletines recientes listados en la página principal del BOPA.
async function obtenerBoletinesRecientes() {
  const html = await getHtml(LISTING_URL);
  const $ = cheerio.load(html);
  const boletines = [];
  const vistos = new Set();

  $('a[href*="bopa-sumario"][href*="p_r_p_summaryDate="]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const fecha = extraerFechaDeHref(href);
    if (!fecha || vistos.has(fecha)) return;
    vistos.add(fecha);
    boletines.push({ fecha, url: href });
  });

  return boletines;
}

// Devuelve el boletín más reciente (o el de la fecha pedida si existe).
async function obtenerBoletinObjetivo(fechaISO) {
  if (fechaISO) {
    // Construimos la URL directamente: no hace falta raspar el listado
    return { fecha: fechaISO, url: buildSumarioUrl(fechaISO) };
  }

  const boletines = await obtenerBoletinesRecientes();
  if (!boletines.length) throw new Error('No se han encontrado boletines recientes del BOPA');
  return boletines[0];
}

// Devuelve todos los documentos del sumario de un boletín.
// Estructura HTML: <dl> con pares <dt>título</dt><dd><a title="Texto de la disposición" ...></dd>
async function obtenerDocumentosSumario(boletin) {
  const html = await getHtml(boletin.url);
  const $ = cheerio.load(html);
  const docs = [];
  const vistos = new Set();

  $('a[title="Texto de la disposición"]').each((_, el) => {
    const url = $(el).attr('href') || '';
    if (!url || vistos.has(url)) return;
    vistos.add(url);

    // El título está en el <dt> anterior al <dd> que contiene este link
    const titulo = normalizarEspacios(
      $(el).closest('dd').prev('dt').text()
    )
      .replace(/\[Cód\.\s*[\d-]+\]/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);

    if (!titulo) return;

    docs.push({ titulo, url, fecha: boletin.fecha });
  });

  return docs;
}

// Extrae el texto completo de la página HTML de una disposición.
async function obtenerTextoDocumento(url) {
  try {
    const html = await getHtml(url);
    const $ = cheerio.load(html);
    const texto = normalizarEspacios($('#main-content').text());
    return texto.slice(0, 12000);
  } catch {
    return '';
  }
}

// Función principal: documentos del BOPA del día indicado que pasan el filtro rural.
async function obtenerDocumentosBopaConTexto(fechaISO, esRuralRelevante) {
  const boletin = await obtenerBoletinObjetivo(fechaISO || null);
  const todos = await obtenerDocumentosSumario(boletin);
  const resultado = [];

  for (const doc of todos) {
    if (!esRuralRelevante(doc.titulo)) continue;

    await sleep(DELAY_MS);
    const texto = await obtenerTextoDocumento(doc.url);
    resultado.push({ ...doc, texto: texto || doc.titulo });
  }

  console.log(`[BOPA] ${resultado.length} documentos relevantes de ${todos.length} totales`);
  return resultado;
}

module.exports = {
  obtenerDocumentosBopaConTexto,
  obtenerBoletinesRecientes,
  getFechaHoyISO,
};
