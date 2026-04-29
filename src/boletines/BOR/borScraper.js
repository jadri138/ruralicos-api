// src/boletines/BOR/borScraper.js
//
// Scraper del BOR (Boletin Oficial de La Rioja).
//
// La portada carga el sumario por AJAX:
//   https://web.larioja.org/apps/ckan-client/public/bor/getBors
// y cada anuncio tiene vista HTML propia.

const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://web.larioja.org';
const BOR_AJAX_URL = `${BASE}/apps/ckan-client/public/bor/getBors`;
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

function limpiarUrl(url) {
  return normalizarEspacios(url).replace(/\s*=\s*/g, '=');
}

function fechaIsoAJsDateString(fechaISO) {
  const [year, month, day] = fechaISO.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toString().replace(/\s*\(.+\)$/, '');
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
  return mes ? `${match[3]}-${mes}-${dia}` : null;
}

async function obtenerSumarioBor(fechaISO = getFechaHoyISO()) {
  const body = new URLSearchParams({
    date: fechaIsoAJsDateString(fechaISO),
    numero: '',
    getDetalleBOR: 'true',
  });

  const { data } = await axios.post(BOR_AJAX_URL, body.toString(), {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  if (!data || data.status !== 'success' || !data.data?.bor) {
    throw new Error('No se ha podido obtener el sumario del BOR');
  }

  return data.data;
}

async function obtenerDocumentosDia(fechaISO = getFechaHoyISO()) {
  const sumario = await obtenerSumarioBor(fechaISO);
  const $ = cheerio.load(sumario.bor);
  const fechaBoletin = fechaTextoAISO($('.anuncio_header').text()) || fechaISO;
  const numero = normalizarEspacios($('.anuncio_header').text()).match(/N[uú]m\.\s*(\d+)/i)?.[1] || '';
  const docs = [];
  const vistos = new Set();

  $('.anuncio_text').each((_, el) => {
    const tituloLink = $(el).find('a[title*="Texto"]').first();
    const htmlLink = $(el).find('a.btn-success[href*="boranuncio"]').first();
    const titulo = normalizarEspacios(tituloLink.text()).slice(0, 300);
    const url = limpiarUrl(absoluteUrl(htmlLink.attr('href') || tituloLink.attr('href') || ''));

    if (!titulo || !url || vistos.has(url)) return;
    vistos.add(url);

    docs.push({
      titulo,
      url,
      fecha: fechaBoletin,
      boletin: numero,
    });
  });

  return docs;
}

async function obtenerTextoDocumento(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
    });
    const $ = cheerio.load(data);
    const texto = normalizarEspacios($('.anuncio').text() || $('.item-page').text() || $('body').text());
    return texto.slice(0, 12000);
  } catch {
    return '';
  }
}

async function obtenerDocumentosBorConTexto(fechaISO, esRuralRelevante) {
  const todos = await obtenerDocumentosDia(fechaISO || getFechaHoyISO());
  const resultado = [];

  for (const doc of todos) {
    if (!esRuralRelevante(doc.titulo)) continue;

    await sleep(DELAY_MS);
    const texto = await obtenerTextoDocumento(doc.url);
    resultado.push({ ...doc, texto: texto || doc.titulo });
  }

  console.log(`[BOR] ${resultado.length} documentos relevantes de ${todos.length} totales`);
  return resultado;
}

module.exports = {
  obtenerDocumentosBorConTexto,
  obtenerDocumentosDia,
  getFechaHoyISO,
};
