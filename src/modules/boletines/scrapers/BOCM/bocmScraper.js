// src/boletines/BOCM/bocmScraper.js
//
// Scraper del BOCM (Boletín Oficial de la Comunidad de Madrid).
//
// El BOCM publica un sumario XML en:
//   https://www.bocm.es/boletin/CM_Boletin_BOCM/YYYY/MM/DD/BOCM-YYYYMMDDNNN.xml
// La URL exacta (con el número de boletín NNN) se extrae de la portada.
// Cada disposición tiene su propio XML con el texto completo:
//   https://www.bocm.es/boletin/CM_XXX_BOCM/YYYY/MM/DD/BOCM-YYYYMMDD-N.xml
//   → nodo <texto> con el contenido íntegro.

const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.bocm.es';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

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

// Obtiene la URL del XML del sumario del boletín más reciente leyendo la portada.
async function obtenerUrlXmlActual() {
  const { data: html } = await axios.get(`${BASE}/`, { timeout: 15000, headers: HEADERS });

  // La portada incluye un link relativo o absoluto al XML del sumario:
  //   href="/boletin/CM_Boletin_BOCM/YYYY/MM/DD/BOCM-YYYYMMDDNNN.xml"
  const match = html.match(
    /href="((?:https:\/\/www\.bocm\.es)?\/boletin\/CM_Boletin_BOCM\/\d{4}\/\d{2}\/\d{2}\/BOCM-\d+\.xml)"/
  );
  if (!match) throw new Error('[BOCM] No se encontró la URL del XML del sumario en la portada');
  const href = match[1];
  return href.startsWith('http') ? href : `${BASE}${href}`;
}

// Extrae la fecha ISO del path de la URL del XML del sumario.
function extraerFechaDeUrlXml(url) {
  const m = url.match(/CM_Boletin_BOCM\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// Parsea el XML del sumario y devuelve un array de disposiciones.
function parsearSumarioXml(xml, fechaDefault) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const docs = [];
  const vistos = new Set();

  $('disposicion').each((_, el) => {
    const $el = $(el);
    const titulo = normalizarEspacios($el.find('titulo').first().text()).slice(0, 300);
    const urlHtml = normalizarEspacios($el.find('url_html').first().text());
    const urlXml = normalizarEspacios($el.find('url_xml').first().text());
    const organismo = normalizarEspacios($el.closest('organismo').attr('nombre') || '');

    if (!titulo || !urlHtml || vistos.has(urlHtml)) return;
    vistos.add(urlHtml);

    docs.push({ titulo, urlHtml, urlXml, organismo, fecha: fechaDefault });
  });

  return docs;
}

// Descarga el XML individual de una disposición y extrae el nodo <texto>.
// Si falla, intenta el HTML de la página del anuncio.
async function obtenerTextoDisposicion(urlXml, urlHtml) {
  if (urlXml) {
    try {
      const { data: xml } = await axios.get(urlXml, { timeout: 15000, headers: HEADERS });
      const $ = cheerio.load(xml, { xmlMode: true });
      const texto = normalizarEspacios($('texto').text());
      if (texto) return texto.slice(0, 12000);
    } catch { /* fallback al HTML */ }
  }

  if (urlHtml) {
    try {
      const { data: html } = await axios.get(urlHtml, { timeout: 15000, headers: HEADERS });
      const $ = cheerio.load(html);
      return normalizarEspacios($('#main-content, main').first().text()).slice(0, 12000);
    } catch { return ''; }
  }

  return '';
}

// Función principal: disposiciones del BOCM que pasan el filtro rural.
async function obtenerDocumentosBocmConTexto(fechaISO, esRuralRelevante) {
  const xmlUrl = await obtenerUrlXmlActual();
  const fechaBoletin = extraerFechaDeUrlXml(xmlUrl) || fechaISO || getFechaHoyISO();

  if (fechaISO && fechaBoletin !== fechaISO) {
    console.log(`[BOCM] Boletin disponible (${fechaBoletin}) no coincide con la fecha pedida (${fechaISO}). No se procesa.`);
    return [];
  }

  const { data: xml } = await axios.get(xmlUrl, { timeout: 20000, headers: HEADERS });
  const todos = parsearSumarioXml(xml, fechaBoletin);

  // Filtrar por relevancia usando título + nombre del organismo
  const relevantes = todos.filter((d) => esRuralRelevante(`${d.titulo} ${d.organismo}`));

  const resultado = [];
  for (const doc of relevantes) {
    await sleep(DELAY_MS);
    const texto = await obtenerTextoDisposicion(doc.urlXml, doc.urlHtml);
    resultado.push({
      titulo: doc.titulo,
      url: doc.urlHtml,
      fecha: doc.fecha,
      texto: texto || doc.titulo,
    });
  }

  console.log(`[BOCM] ${resultado.length} documentos relevantes de ${todos.length} totales`);
  return resultado;
}

module.exports = { obtenerDocumentosBocmConTexto, getFechaHoyISO };
