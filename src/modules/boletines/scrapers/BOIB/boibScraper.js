// src/boletines/BOIB/boibScraper.js
//
// Scraper del BOIB (Boletin Oficial de las Illes Balears).
//
// Portada/ultimo numero:
//   https://www.caib.es/eboibfront/es/
// Sumario:
//   https://www.caib.es/eboibfront/es/YYYY/{ID}/?lang=es

const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.caib.es';
const LISTING_URL = `${BASE}/eboibfront/es/`;
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

  const textoNormal = normalizarEspacios(texto).toLowerCase();
  let match = textoNormal.match(/(\d{1,2})\s*\/\s*([a-záéíóúñ]+)\s*\/\s*(\d{4})/i);
  if (!match) {
    match = textoNormal.match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/i);
  }
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

async function obtenerBoletinesRecientes() {
  const html = await getHtml(LISTING_URL);
  const $ = cheerio.load(html);
  const boletines = [];
  const porKey = new Map();
  const mesSeleccionado = Number($('select[name="p_mes"] option[selected]').attr('value'));
  const anySeleccionado = $('select[name="p_any"] option[selected]').attr('value') || String(new Date().getFullYear());

  $('a[href*="/eboibfront/es/"][href*="?lang=es"], a[href*="/eboibfront/es/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const texto = normalizarEspacios($(el).text());
    const match = href.match(/\/eboibfront\/es\/(\d{4})\/(\d+)\/?/);
    if (!match) return;

    const key = `${match[1]}-${match[2]}`;
    const diaCalendario = texto.match(/^\d{1,2}/)?.[0];
    const fecha =
      fechaTextoAISO(texto) ||
      (Number.isInteger(mesSeleccionado) && diaCalendario
        ? `${anySeleccionado}-${String(mesSeleccionado + 1).padStart(2, '0')}-${String(Number(diaCalendario)).padStart(2, '0')}`
        : '');

    const boletin = porKey.get(key) || {
      year: match[1],
      id: match[2],
      fecha: '',
      titulo: texto,
      url: absoluteUrl(href.includes('?') ? href : `${href}?lang=es`),
    };

    boletin.fecha = boletin.fecha || fecha || '';
    if (!boletin.titulo || boletin.titulo === 'Último número') boletin.titulo = texto;
    porKey.set(key, boletin);
  });

  return Array.from(porKey.values());
}

async function obtenerBoletinObjetivo(fechaISO) {
  const boletines = await obtenerBoletinesRecientes();
  if (!boletines.length) throw new Error('No se encontraron boletines recientes del BOIB');

  if (fechaISO) {
    const exacto = boletines.find((b) => b.fecha === fechaISO);
    if (exacto) return exacto;
    console.log(`[BOIB] No hay boletin para la fecha pedida (${fechaISO})`);
    return null;
  }

  return boletines[0];
}

function limpiarTituloItem($, item) {
  const clone = $(item).clone();
  clone.find('ul.documents').remove();
  const texto = normalizarEspacios(clone.text())
    .replace(/N[uú]mero de edicto.*$/i, '')
    .replace(/P[aá]ginas?.*$/i, '')
    .trim();
  return texto.slice(0, 300);
}

async function obtenerDocumentosSumario(boletin) {
  const html = await getHtml(boletin.url);
  const $ = cheerio.load(html);
  const fecha = fechaTextoAISO($('title').text()) || fechaTextoAISO($('body').text()) || boletin.fecha || getFechaHoyISO();
  const numero = $('title').text().match(/N[uú]m\.\s*([0-9]+)/i)?.[1] || '';
  const docs = [];
  const vistos = new Set();

  $('a[href*="/eboibfront/es/"], a[href*="/dof/spa/html"]').each((_, el) => {
    const textoLink = normalizarEspacios($(el).text());
    if (!/^Versi[oó]n HTML$/i.test(textoLink)) return;

    const url = absoluteUrl($(el).attr('href') || '');
    if (!url || url.endsWith('/xml') || vistos.has(url)) return;
    vistos.add(url);

    const item = $(el).closest('ul.documents').parent();
    const titulo = limpiarTituloItem($, item);
    if (!titulo) return;

    docs.push({ titulo, url, fecha, boletin: numero });
  });

  return docs;
}

async function obtenerTextoDocumento(url) {
  try {
    const html = await getHtml(url);
    const $ = cheerio.load(html);
    const texto = normalizarEspacios($('.contenido').text() || $('body').text());
    return texto.slice(0, 12000);
  } catch {
    return '';
  }
}

async function obtenerDocumentosBoibConTexto(fechaISO, esRuralRelevante) {
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

  console.log(`[BOIB] ${resultado.length} documentos detectados (captura bruta) de ${todos.length}`);
  return resultado;
}

module.exports = {
  obtenerDocumentosBoibConTexto,
  obtenerBoletinesRecientes,
  getFechaHoyISO,
};
