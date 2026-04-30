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

const axios = require('axios');
const cheerio = require('cheerio');
const { PDFParse } = require('pdf-parse');

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
  const { data } = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
  });
  return data;
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
  if (!urlAnio) throw new Error(`No se encontro categoria BOCCE para el anio ${year}`);

  const html = await getHtml(urlAnio);
  const $ = cheerio.load(html);
  let urlMes = '';

  $('a[href*="/component/jdownloads/viewcategory/"]').each((_, el) => {
    const texto = normalizarEspacios($(el).text()).toLowerCase();
    if (texto === mes) urlMes = absoluteUrl($(el).attr('href'));
  });

  if (!urlMes) throw new Error(`No se encontro categoria BOCCE para ${mes} ${year}`);
  return urlMes;
}

async function obtenerBoletinesDelDia(fechaISO = getFechaHoyISO()) {
  const urlMes = await obtenerCategoriaMes(fechaISO);
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
    const { data } = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
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
  const boletines = await obtenerBoletinesDelDia(fecha);
  const resultado = [];

  for (const boletin of boletines) {
    await sleep(DELAY_MS);
    const texto = await obtenerTextoPdf(boletin.url);
    const textoFiltro = `${boletin.titulo} ${extraerSumario(texto)}`;

    if (!esRuralRelevante(textoFiltro)) continue;
    resultado.push({ ...boletin, texto: texto || textoFiltro });
  }

  console.log(`[BOCCE] ${resultado.length} boletines relevantes de ${boletines.length} totales`);
  return resultado;
}

module.exports = {
  obtenerDocumentosBocceConTexto,
  obtenerBoletinesDelDia,
  getFechaHoyISO,
};
