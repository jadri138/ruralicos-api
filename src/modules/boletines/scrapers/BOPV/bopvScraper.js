// src/boletines/BOPV/bopvScraper.js
//
// Scraper del BOPV / EHAA (Boletin Oficial del Pais Vasco).
//
// Ultimo boletin:
//   https://www.euskadi.eus/web01-bopv/es/bopv2/datos/Ultimo.shtml
// Disposicion HTML:
//   https://www.euskadi.eus/web01-bopv/es/bopv2/datos/YYYY/MM/NNNNNNNa.shtml

const cheerio = require('cheerio');
const { axiosGetWithRetry } = require('../../../../platform/httpClient');

const BASE = 'https://www.euskadi.eus';
const LISTING_URL = `${BASE}/web01-bopv/es/bopv2/datos/Ultimo.shtml`;
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
  if (href.startsWith('http')) return href;
  if (href.startsWith('/')) return `${BASE}${href}`;
  return `${BASE}/web01-bopv/es/bopv2/datos/${href}`;
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

async function getHtml(url) {
  const { data, headers } = await axiosGetWithRetry(url, {
    responseType: 'arraybuffer',
    timeout: Number(process.env.BOPV_HTTP_TIMEOUT_MS || 30000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
  }, {
    attempts: Number(process.env.BOPV_HTTP_ATTEMPTS || 2),
    allowInsecureFallback: true,
  });

  const contentType = String(headers['content-type'] || '').toLowerCase();
  const encoding = contentType.includes('iso-8859-1') ? 'iso-8859-1' : 'utf-8';
  return new TextDecoder(encoding).decode(Buffer.from(data));
}

function obtenerFechaBoletin($) {
  const texto = normalizarEspacios($('.colCentral h3, .colCentralinterior h3').first().text() || $('body').text());
  return fechaTextoAISO(texto) || getFechaHoyISO();
}

async function obtenerDocumentosDia() {
  const html = await getHtml(LISTING_URL);
  const $ = cheerio.load(html);
  const fecha = obtenerFechaBoletin($);
  const numero = normalizarEspacios($('.colCentral h3').first().text()).match(/n\.?[º°]?\s*(\d+)/i)?.[1] || '';
  const docs = [];
  const vistos = new Set();

  $('a[href$="a.shtml"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const titulo = normalizarEspacios($(el).text()).slice(0, 300);
    if (!titulo) return;

    const url = absoluteUrl(href);
    if (vistos.has(url)) return;
    vistos.add(url);

    const bloque = $(el).closest('.txtBloque');
    const orden = normalizarEspacios(bloque.find('.BOPVSumarioOrden').text());
    docs.push({ titulo, url, fecha, boletin: numero, orden });
  });

  return docs;
}

async function obtenerTextoDocumento(url) {
  try {
    const html = await getHtml(url);
    const $ = cheerio.load(html);
    const partes = [];

    $('.BOPVSeccion, .BOPVSubseccion, .BOPVOrganismo, .BOPVOrden, .BOPVTitulo, .BOPVDetalle, .BOPVClave, .BOPVDisposicion')
      .each((_, el) => {
        const texto = normalizarEspacios($(el).text());
        if (texto) partes.push(texto);
      });

    return partes.join(' ').slice(0, 12000);
  } catch {
    return '';
  }
}

async function obtenerDocumentosBopvConTexto(fechaISO, esRuralRelevante) {
  const todos = await obtenerDocumentosDia();
  const resultado = [];
  const fechaBoletin = todos[0]?.fecha || getFechaHoyISO();

  if (fechaISO && fechaISO !== fechaBoletin) {
    console.warn(`[BOPV] Solo se procesa el ultimo boletin (${fechaBoletin}); fecha solicitada: ${fechaISO}`);
    return [];
  }

  for (const doc of todos) {
    if (!esRuralRelevante(doc.titulo)) continue;

    await sleep(DELAY_MS);
    const texto = await obtenerTextoDocumento(doc.url);
    resultado.push({ ...doc, texto: texto || doc.titulo });
  }

  console.log(`[BOPV] ${resultado.length} documentos relevantes de ${todos.length} totales`);
  return resultado;
}

module.exports = {
  obtenerDocumentosBopvConTexto,
  obtenerDocumentosDia,
  getFechaHoyISO,
};
