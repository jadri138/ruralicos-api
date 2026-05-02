// src/boletines/BOCANT/bocantScraper.js
//
// Scraper del BOC (Boletin Oficial de Cantabria).
//
// Calendario AJAX:
//   https://boc.cantabria.es/boces/busquedaBoletines.do?mes={M}&year={YYYY}
// Sumario:
//   https://boc.cantabria.es/boces/verBoletin.do?idBolOrd={ID}
// Anuncio PDF:
//   https://boc.cantabria.es/boces/verAnuncioAction.do?idAnuBlob={ID}

const axios = require('axios');
const cheerio = require('cheerio');
const { PDFParse } = require('pdf-parse');

const BASE = 'https://boc.cantabria.es/boces';
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
  return href.startsWith('http') ? href : `${BASE}/${href.replace(/^\/+/, '')}`;
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
  const { data } = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
  });
  return data;
}

async function obtenerBoletinesMes(year, month) {
  const { data } = await axios.post(`${BASE}/busquedaBoletines.do?mes=${month}&year=${year}`, null, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  return Array.isArray(data) ? data : [];
}

async function obtenerBoletinesRecientes(fechaISO = getFechaHoyISO()) {
  const year = Number(fechaISO.slice(0, 4));
  const month = Number(fechaISO.slice(5, 7));
  const boletines = await obtenerBoletinesMes(year, month);

  return boletines
    .map((b) => ({
      id: b.id,
      numero: b.numBol,
      tipo: Number(b.tipoBol),
      fecha: fechaTextoAISO(b.fecBolString) || '',
      titulo: b.fecBolString,
      url: Number(b.tipoBol) === 1
        ? `${BASE}/verBoletinExtraordinario.do?id=${b.id}`
        : `${BASE}/verBoletin.do?idBolOrd=${b.id}`,
    }))
    .filter((b) => b.id && b.fecha)
    .sort((a, b) => `${b.fecha}-${b.id}`.localeCompare(`${a.fecha}-${a.id}`));
}

async function obtenerBoletinObjetivo(fechaISO) {
  const boletines = await obtenerBoletinesRecientes(fechaISO || getFechaHoyISO());
  if (!boletines.length) throw new Error('No se encontraron boletines recientes del BOC Cantabria');

  if (fechaISO) {
    const ordinario = boletines.find((b) => b.fecha === fechaISO && b.tipo === 0);
    if (ordinario) return ordinario;

    const exacto = boletines.find((b) => b.fecha === fechaISO);
    if (exacto) return exacto;

    console.log(`[BOCANT] No hay boletin para la fecha pedida (${fechaISO})`);
    return null;
  }

  return boletines.find((b) => b.tipo === 0) || boletines[0];
}

function obtenerOrgano($, enlacesDoc) {
  let node = $(enlacesDoc).prev();
  while (node.length) {
    if (node.is('.spanH4')) return normalizarEspacios(node.text());
    node = node.prev();
  }
  return '';
}

async function obtenerDocumentosSumario(boletin) {
  const html = await getHtml(boletin.url);
  const $ = cheerio.load(html);
  const docs = [];
  const vistos = new Set();

  $('.enlacesDoc').each((_, enlaces) => {
    const titleNode = $(enlaces).prevAll('p').first();
    const tituloBase = normalizarEspacios(titleNode.text()).slice(0, 300);
    const organo = obtenerOrgano($, enlaces);
    const link = $(enlaces).find('a[href*="verAnuncioAction"]').first();
    const href = link.attr('href') || '';

    if (!tituloBase || !href) return;
    const url = absoluteUrl(href);
    if (vistos.has(url)) return;
    vistos.add(url);

    docs.push({
      titulo: tituloBase,
      organo,
      url,
      fecha: boletin.fecha,
      boletin: String(boletin.numero || ''),
    });
  });

  return docs;
}

async function obtenerTextoPdf(url) {
  let parser;
  try {
    const { data } = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 25000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
    });
    parser = new PDFParse({ data: Buffer.from(data) });
    const result = await parser.getText();
    return normalizarEspacios(result.text).slice(0, 12000);
  } catch {
    return '';
  } finally {
    if (parser && typeof parser.destroy === 'function') {
      await parser.destroy();
    }
  }
}

async function obtenerDocumentosBocantConTexto(fechaISO, esRuralRelevante) {
  const boletin = await obtenerBoletinObjetivo(fechaISO || null);
  if (!boletin) return [];

  const todos = await obtenerDocumentosSumario(boletin);
  const resultado = [];

  for (const doc of todos) {
    const textoFiltro = `${doc.organo} ${doc.titulo}`;
    if (!esRuralRelevante(textoFiltro)) continue;

    await sleep(DELAY_MS);
    const texto = await obtenerTextoPdf(doc.url);
    resultado.push({ ...doc, texto: texto || textoFiltro });
  }

  console.log(`[BOCANT] ${resultado.length} documentos relevantes de ${todos.length} totales`);
  return resultado;
}

module.exports = {
  obtenerDocumentosBocantConTexto,
  obtenerBoletinesRecientes,
  getFechaHoyISO,
};
