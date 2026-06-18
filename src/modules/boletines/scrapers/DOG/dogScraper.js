// src/boletines/DOG/dogScraper.js
//
// Scraper del DOG (Diario Oficial de Galicia).
//
// Estructura de URLs (HTML estático, sin API):
//   Secciones: https://www.xunta.gal/dog/Publicados/{YEAR}/{YYYYMMDD}/Secciones{N}_es.html
//   Documento: https://www.xunta.gal/dog/Publicados/{YEAR}/{YYYYMMDD}/Anuncio{CODE}_es.html

const axios   = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.xunta.gal';
const DELAY_MS = 600;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getFechaHoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fechaAFolderPath(fechaISO) {
  const year  = fechaISO.slice(0, 4);
  const yyyymmdd = fechaISO.replace(/-/g, '');
  return `/dog/Publicados/${year}/${yyyymmdd}`;
}

// ─────────────────────────────────────────────
// Paso 1: recoger todos los documentos del día
// desde todas las secciones que existen (1..5)
// ─────────────────────────────────────────────
async function obtenerDocumentosDia(fechaISO) {
  const folder = fechaAFolderPath(fechaISO);
  const docs   = [];

  for (let n = 1; n <= 5; n++) {
    const url = `${BASE}${folder}/Secciones${n}_es.html`;
    let html;
    try {
      const { data, status } = await axios.get(url, {
        timeout: 12000,
        validateStatus: s => s < 500,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
      });
      if (status === 404) continue;
      html = data;
    } catch {
      continue;
    }

    const $ = cheerio.load(html);
    $('li.dog-toc-sumario a[href]').each((_, el) => {
      const href  = $(el).attr('href') || '';
      const titulo = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 250);
      if (!href.includes('Anuncio') || !href.includes('_es.html')) return;
      const docUrl = href.startsWith('http') ? href : `${BASE}${href}`;
      docs.push({ titulo, url: docUrl });
    });
  }

  return docs;
}

// ─────────────────────────────────────────────
// Paso 2: texto completo de un documento HTML
// ─────────────────────────────────────────────
async function obtenerTextoDocumento(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
    });
    const $ = cheerio.load(data);
    const texto = $('#audioid .story').text()
      || $('div.story').text()
      || $('main').text();
    return texto.replace(/\s+/g, ' ').trim().slice(0, 12000);
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────
// Función principal exportada
// ─────────────────────────────────────────────
async function obtenerDocumentosDogConTexto(fechaISO, esRuralRelevante) {
  const todos    = await obtenerDocumentosDia(fechaISO);
  const resultado = [];

  // Captura bruta: se devuelven TODOS los detectados anotados con `_relevante`; el
  // texto solo se descarga para los relevantes (coste idéntico al de antes).
  for (const doc of todos) {
    if (!esRuralRelevante(doc.titulo)) {
      resultado.push({ ...doc, fecha: fechaISO, _relevante: false });
      continue;
    }

    await sleep(DELAY_MS);
    const texto = await obtenerTextoDocumento(doc.url);

    resultado.push({ ...doc, fecha: fechaISO, texto: texto || doc.titulo, _relevante: true });
  }

  console.log(`[DOG] ${resultado.length} documentos detectados (captura bruta) de ${todos.length}`);
  return resultado;
}

module.exports = { obtenerDocumentosDogConTexto, getFechaHoyISO };
