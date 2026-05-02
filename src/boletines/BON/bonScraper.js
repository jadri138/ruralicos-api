// src/boletines/BON/bonScraper.js
//
// Scraper del BON (Boletin Oficial de Navarra).
//
// HTML oficial:
//   Ultimos boletines: https://bon.navarra.es/es/boletines
//   Sumario:           https://bon.navarra.es/es/boletin/-/sumario/{YEAR}/{NUM}
//   Anuncio:           https://bon.navarra.es/es/anuncio/-/texto/{YEAR}/{NUM}/{ID}

const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://bon.navarra.es';
const BOLETINES_URL = `${BASE}/es/boletines`;
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

function absoluteUrl(href) {
  if (!href) return '';
  return href.startsWith('http') ? href : `${BASE}${href}`;
}

function fechaTextoAISO(texto) {
  const meses = {
    enero: '01',
    febrero: '02',
    marzo: '03',
    abril: '04',
    mayo: '05',
    junio: '06',
    julio: '07',
    agosto: '08',
    septiembre: '09',
    setiembre: '09',
    octubre: '10',
    noviembre: '11',
    diciembre: '12',
  };

  const match = normalizarEspacios(texto)
    .toLowerCase()
    .match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/i);
  if (!match) return null;

  const dia = String(Number(match[1])).padStart(2, '0');
  const mes = meses[match[2].normalize('NFD').replace(/\p{Diacritic}/gu, '')];
  const year = match[3];
  return mes ? `${year}-${mes}-${dia}` : null;
}

async function getHtml(url) {
  const { data } = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
  });
  return data;
}

async function obtenerBoletinesRecientes() {
  const html = await getHtml(BOLETINES_URL);
  const $ = cheerio.load(html);
  const boletines = [];
  const vistos = new Set();

  $('a[href*="/es/boletin/-/sumario/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = normalizarEspacios($(el).text());
    const matchUrl = href.match(/\/sumario\/(\d{4})\/(\d+)/);
    if (!matchUrl) return;

    const year = matchUrl[1];
    const numero = matchUrl[2];
    const key = `${year}-${numero}`;
    if (vistos.has(key)) return;
    vistos.add(key);

    boletines.push({
      year,
      numero,
      fecha: fechaTextoAISO(text),
      titulo: text,
      url: absoluteUrl(href),
    });
  });

  return boletines;
}

async function obtenerBoletinObjetivo(fechaISO) {
  const boletines = await obtenerBoletinesRecientes();
  if (!boletines.length) {
    throw new Error('No se han encontrado boletines recientes del BON');
  }

  if (fechaISO) {
    const boletinFecha = boletines.find((boletin) => boletin.fecha === fechaISO);
    if (boletinFecha) return boletinFecha;
    console.log(`[BON] No hay boletin para la fecha pedida (${fechaISO})`);
    return null;
  }

  return boletines[0];
}

async function obtenerDocumentosSumario(boletin) {
  const html = await getHtml(boletin.url);
  const $ = cheerio.load(html);
  const docs = [];
  const vistos = new Set();

  $('a[href*="/es/anuncio/-/texto/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const titulo = normalizarEspacios($(el).text()).slice(0, 300);
    if (!titulo) return;

    const url = absoluteUrl(href);
    if (vistos.has(url)) return;
    vistos.add(url);

    docs.push({
      titulo,
      url,
      fecha: boletin.fecha || getFechaHoyISO(),
      boletin: boletin.numero,
    });
  });

  return docs;
}

async function obtenerTextoDocumento(url) {
  try {
    const html = await getHtml(url);
    const $ = cheerio.load(html);
    const texto = normalizarEspacios($('#main-content').text() || $('main').text());
    return texto.slice(0, 12000);
  } catch {
    return '';
  }
}

async function obtenerDocumentosBonConTexto(fechaISO, esRuralRelevante) {
  const boletin = await obtenerBoletinObjetivo(fechaISO);
  if (!boletin) return [];

  const todos = await obtenerDocumentosSumario(boletin);
  const resultado = [];

  for (const doc of todos) {
    if (!esRuralRelevante(doc.titulo)) continue;

    await sleep(DELAY_MS);
    const texto = await obtenerTextoDocumento(doc.url);

    resultado.push({ ...doc, texto: texto || doc.titulo });
  }

  console.log(`[BON] ${resultado.length} documentos relevantes de ${todos.length} totales`);
  return resultado;
}

module.exports = {
  obtenerDocumentosBonConTexto,
  obtenerBoletinesRecientes,
  getFechaHoyISO,
};
