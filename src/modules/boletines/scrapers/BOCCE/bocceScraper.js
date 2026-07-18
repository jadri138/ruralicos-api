// src/boletines/BOCCE/bocceScraper.js
//
// Scraper del BOCCE (Boletin Oficial de la Ciudad Autonoma de Ceuta).
//
// Listado principal:
//   https://www.ceuta.es/ceuta/bocce
// Categoria por anio:
//   /ceuta/component/jdownloads/viewcategory/{id}-{anio}
// Categoria por mes:
//   /ceuta/component/jdownloads/viewcategory/{id}-{mes}
// Descarga PDF:
//   /ceuta/component/jdownloads/finish/{id}-{mes}/{id-doc}-{slug}?Itemid=0

const cheerio = require('cheerio');
const { PDFParse } = require('pdf-parse');
const { axiosGetWithRetry, cabecerasNavegador } = require('../../../../platform/httpClient');
const { agenteResiliente, ipConocida } = require('../../../../platform/dnsResiliente');
const { evaluarPrefiltroRural } = require('../shared/ruralFilter');

const BASE = 'https://www.ceuta.es';
const BOCCE_URL = `${BASE}/ceuta/bocce`;
const DELAY_MS = 350;

const MESES = {
  '01': 'enero',
  '02': 'febrero',
  '03': 'marzo',
  '04': 'abril',
  '05': 'mayo',
  '06': 'junio',
  '07': 'julio',
  '08': 'agosto',
  '09': 'septiembre',
  '10': 'octubre',
  '11': 'noviembre',
  '12': 'diciembre',
};

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

function absoluteUrl(href) {
  if (!href) return '';
  return href.startsWith('http') ? href : `${BASE}${href}`;
}

function fechaTituloAISO(titulo) {
  const match = normalizarEspacios(titulo).match(/_(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return '';
  return `${match[3]}-${match[2]}-${match[1]}`;
}

async function getHtml(url) {
  try {
    const { data } = await axiosGetWithRetry(url, {
      timeout: Number(process.env.BOCCE_HTML_TIMEOUT_MS || 45000),
      httpsAgent: agenteResiliente,
      headers: cabecerasNavegador({ Referer: BOCCE_URL }),
    }, {
      attempts: Number(process.env.BOCCE_HTML_ATTEMPTS || 3),
    });
    return data;
  } catch (error) {
    // Los nameservers de ceuta.es son intermitentes: anotar la IP conocida
    // distingue "DNS irresoluble" de "conexion bloqueada/lenta" en scraper_runs.
    const ip = ipConocida('www.ceuta.es');
    error.message = `${error.message} [BOCCE ip=${ip ? `${ip.ip} (${ip.origen})` : 'sin resolver'}]`;
    throw error;
  }
}

async function obtenerCategoriasAnio() {
  const html = await getHtml(BOCCE_URL);
  const $ = cheerio.load(html);
  const categorias = new Map();

  $('a[href*="/component/jdownloads/viewcategory/"]').each((_, el) => {
    const texto = normalizarEspacios($(el).text());
    if (!/^\d{4}$/.test(texto)) return;
    categorias.set(texto, absoluteUrl($(el).attr('href')));
  });

  return categorias;
}

async function obtenerCategoriaMes(fechaISO) {
  const year = fechaISO.slice(0, 4);
  const month = fechaISO.slice(5, 7);
  const mes = MESES[month];
  if (!mes) throw new Error(`Mes no valido para BOCCE: ${fechaISO}`);

  const categoriasAnio = await obtenerCategoriasAnio();
  const urlAnio = categoriasAnio.get(year);
  // "Sin categoria" = no hay boletines (o cambio de layout), NO un error de red:
  // devolvemos '' para que la ruta no marque la ejecucion como error y registre 0.
  if (!urlAnio) {
    console.warn(`[BOCCE] Sin categoria para el anio ${year} (sin boletines o cambio en la web)`);
    return '';
  }

  const html = await getHtml(urlAnio);
  const $ = cheerio.load(html);
  let urlMes = '';

  $('a[href*="/component/jdownloads/viewcategory/"]').each((_, el) => {
    const texto = normalizarEspacios($(el).text()).toLowerCase();
    if (texto === mes) urlMes = absoluteUrl($(el).attr('href'));
  });

  if (!urlMes) {
    console.warn(`[BOCCE] Sin categoria para ${mes} ${year} (sin boletines ese mes)`);
    return '';
  }
  return urlMes;
}

async function obtenerBoletinesDelDia(fechaISO = getFechaHoyISO()) {
  const urlMes = await obtenerCategoriaMes(fechaISO);
  if (!urlMes) return [];
  const html = await getHtml(urlMes);
  const $ = cheerio.load(html);
  const boletines = [];
  const vistos = new Set();

  $('a.jd_download_url[href*="/component/jdownloads/finish/"]').each((_, el) => {
    const titulo = normalizarEspacios($(el).text());
    const href = $(el).attr('href') || '';
    const fecha = fechaTituloAISO(titulo);

    if (!titulo.startsWith('BOCCE_') || fecha !== fechaISO || !href) return;

    const url = absoluteUrl(href.replace(/Itemid=$/, 'Itemid=0'));
    if (vistos.has(url)) return;
    vistos.add(url);

    boletines.push({ titulo, url, fecha });
  });

  return boletines;
}

async function obtenerTextoPdf(url) {
  let parser;
  try {
    const { data } = await axiosGetWithRetry(url, {
      responseType: 'arraybuffer',
      timeout: Number(process.env.BOCCE_PDF_TIMEOUT_MS || 60000),
      httpsAgent: agenteResiliente,
      headers: cabecerasNavegador({ Accept: 'application/pdf,*/*', Referer: BOCCE_URL }),
    }, {
      attempts: Number(process.env.BOCCE_PDF_ATTEMPTS || 2),
    });

    parser = new PDFParse({ data: Buffer.from(data) });
    const result = await parser.getText();
    return normalizarEspacios(result.text).slice(0, 14000);
  } catch {
    return '';
  } finally {
    if (parser && typeof parser.destroy === 'function') {
      await parser.destroy();
    }
  }
}

function extraerSumario(texto) {
  const limpio = normalizarEspacios(texto);
  const inicio = limpio.search(/SUMARIO/i);
  if (inicio < 0) return limpio.slice(0, 6000);

  const desdeSumario = limpio.slice(inicio);
  const fin = desdeSumario.search(/\bCEUTA\s+D\.L\.:/i);
  return (fin > 0 ? desdeSumario.slice(0, fin) : desdeSumario).slice(0, 6000);
}

async function obtenerDocumentosBocceConTexto(fechaISO, esRuralRelevante) {
  const fecha = fechaISO || getFechaHoyISO();

  let boletines;
  try {
    boletines = await obtenerBoletinesDelDia(fecha);
  } catch (error) {
    // Error operativo real (timeout/fuente caida): log claro y se propaga para que
    // la ejecucion quede marcada como error (no como "0 sin explicar").
    console.error(`[BOCCE] Error operativo accediendo a la fuente (${fecha}): ${error.message}`);
    throw error;
  }

  console.log(`[BOCCE] ${boletines.length} boletines detectados en la fuente (${fecha})`);
  const resultado = [];

  // Captura bruta: el texto del PDF ya se descargaba para TODOS (lo necesita el
  // filtro por sumario), así que se devuelven todos anotados con `_relevante`.
  for (const boletin of boletines) {
    await sleep(DELAY_MS);
    const texto = await obtenerTextoPdf(boletin.url);
    const textoFiltro = `${boletin.titulo} ${extraerSumario(texto)}`;
    const decision = evaluarPrefiltroRural(esRuralRelevante, textoFiltro);

    resultado.push({
      ...boletin,
      texto: texto || textoFiltro,
      _prefiltro_rural: decision,
      _relevante: decision.action !== 'discard',
    });
  }

  console.log(`[BOCCE] ${resultado.length} boletines detectados (captura bruta) de ${boletines.length}`);
  return resultado;
}

module.exports = {
  obtenerDocumentosBocceConTexto,
  obtenerBoletinesDelDia,
  getFechaHoyISO,
};
