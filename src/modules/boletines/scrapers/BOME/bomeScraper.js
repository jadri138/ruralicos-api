// src/boletines/BOME/bomeScraper.js
//
// Scraper del BOME (Boletin Oficial de la Ciudad Autonoma de Melilla).
// Usa el calendario publico para localizar boletines del dia y despues
// scrapea el sumario/vista web HTML de cada articulo.

const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://bomemelilla.es';
const DELAY_MS = 300;

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

function limpiarHtmlTexto(html) {
  const $ = cheerio.load(html || '');
  $('script, style, nav, header, footer, form, .modal, .offcanvas').remove();
  return normalizarEspacios($('body').text()).slice(0, 14000);
}

function mesCompleto(fechaISO) {
  const [year, month] = fechaISO.split('-');
  const end = new Date(Number(year), Number(month), 0).getDate();
  return {
    start: `${year}-${month}-01`,
    end: `${year}-${month}-${String(end).padStart(2, '0')}`,
  };
}

async function obtenerBoletinesDelDia(fechaISO = getFechaHoyISO()) {
  const { start, end } = mesCompleto(fechaISO);
  const { data } = await axios.get(`${BASE}/api/bomes/calendar`, {
    timeout: 15000,
    params: { start, end },
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
  });

  if (!Array.isArray(data)) return [];

  return data
    .filter((item) => item.start === fechaISO && item.url)
    .map((item) => ({
      titulo: `BOME Melilla ${item.title}`,
      url: absoluteUrl(item.url),
      fecha: item.start,
    }));
}

async function obtenerArticulosBoletin(boletin) {
  const { data: html } = await axios.get(boletin.url, {
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
  });

  const $ = cheerio.load(html);
  const articulos = [];
  const vistos = new Set();

  $('.articulo-list li').each((_, el) => {
    const numero = normalizarEspacios($(el).find('h5').first().text()).match(/ART[IÍ]CULO\s+(\d+)/i)?.[1] || '';
    const titulo = normalizarEspacios($(el).find('blockquote').first().text());
    const vistaWeb = $(el).find('a[href*="/articulo/"]').first().attr('href');
    const pdf = $(el).find('a[href$=".pdf"]').first().attr('href');
    const url = absoluteUrl(vistaWeb || pdf);

    if (!titulo || !url || vistos.has(url)) return;
    vistos.add(url);

    const organismo = normalizarEspacios(
      $(el).closest('ul.articulo-list').prevAll('h4').first().text()
    );

    articulos.push({
      titulo,
      url,
      fecha: boletin.fecha,
      boletin: boletin.titulo,
      articulo: numero,
      organismo,
    });
  });

  return articulos;
}

async function obtenerTextoArticulo(url) {
  if (!url) return '';

  try {
    const { data: html } = await axios.get(url, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
    });

    return limpiarHtmlTexto(html);
  } catch {
    return '';
  }
}

async function obtenerDocumentosBomeConTexto(fechaISO, esRuralRelevante) {
  const fecha = fechaISO || getFechaHoyISO();
  const boletines = await obtenerBoletinesDelDia(fecha);
  const todos = [];

  for (const boletin of boletines) {
    const articulos = await obtenerArticulosBoletin(boletin);
    todos.push(...articulos);
  }

  const resultado = [];
  for (const doc of todos) {
    const textoBase = `${doc.organismo} ${doc.titulo}`;
    if (!esRuralRelevante(textoBase)) continue;

    await sleep(DELAY_MS);
    const texto = await obtenerTextoArticulo(doc.url);
    resultado.push({ ...doc, texto: texto || textoBase });
  }

  console.log(`[BOME] ${resultado.length} documentos relevantes de ${todos.length} totales`);
  return resultado;
}

module.exports = {
  obtenerDocumentosBomeConTexto,
  obtenerBoletinesDelDia,
  obtenerArticulosBoletin,
  getFechaHoyISO,
};
