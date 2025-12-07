// src/boletines/boaPdf.js
const axios = require('axios');
const cheerio = require('cheerio');
const pdfjsLib = require('pdfjs-dist/build/pdf.js');

// =============================
//  FECHA HOY (YYYYMMDD)
// =============================
function getFechaHoyYYYYMMDD() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

// =============================
//  OBTENER MLKOB DEL BOA DE HOY
// =============================
async function obtenerMlkobSumarioHoy() {
  const fecha = getFechaHoyYYYYMMDD();

  const url =
    'https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI' +
    `?BASE=BZHT&CMD=VERLST&DOCS=1-200&PUBL=&PUBL-C=${fecha}` +
    '&RNG=200&SEC=FIRMA&SECC-C=&SEPARADOR=';

  const response = await axios.get(url);
  const html = response.data;
  const $ = cheerio.load(html);

  let mlkob = null;

  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('CMD=VEROBJ') && href.includes('MLKOB=')) {
      const match = href.match(/MLKOB=(\d+)/);
      if (match) {
        mlkob = match[1];
        return false;
      }
    }
  });

  if (!mlkob) {
    throw new Error('No se ha encontrado el MLKOB del BOA de hoy');
  }

  return mlkob;
}

// =============================
//  DESCARGAR PDF POR MLKOB
// =============================
async function descargarBoaPdf(mlkob) {
  const url = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
  });

  return Buffer.from(response.data);
}

// =============================
//  EXTRAER TEXTO DEL PDF
// =============================
async function extraerTextoPdf(bufferPdf) {
  const uint8Array = new Uint8Array(bufferPdf);
  const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
  const pdf = await loadingTask.promise;

  let texto = '';

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const strings = content.items.map(item => item.str).join(' ');
    texto += strings + '\n';
  }

  return texto;
}

// =============================
//  PROCESAR PDF COMPLETO
// =============================
async function procesarBoaPdf(mlkob) {
  console.log('Descargando PDF del BOA con MLKOB:', mlkob);

  const pdfBuffer = await descargarBoaPdf(mlkob);
  console.log('PDF descargado, tamaño:', pdfBuffer.byteLength);

  const texto = await extraerTextoPdf(pdfBuffer);

  console.log('Primeros 500 caracteres del PDF:\n');
  console.log(texto.slice(0, 500));

  return texto;
}

// =============================
//  PROCESAR BOA DE HOY COMPLETO
// =============================
async function procesarBoaDeHoy() {
  const hoy = getFechaHoyYYYYMMDD();
  const mlkob = await obtenerMlkobSumarioHoy();
  const texto = await procesarBoaPdf(mlkob);

  const fechaBoletin = extraerFechaBoletin(texto);

  // Si no hay PDF para hoy → no procesar
  if (!fechaBoletin || fechaBoletin !== hoy) {
    console.log(`⚠️ Hoy (${hoy}) NO hay BOA disponible. Último publicado: ${fechaBoletin}`);
    console.log("⛔ No se guarda nada en la BD.");
    return null;
  }

  console.log(`✅ BOA de hoy ${hoy} confirmado.`);
  return texto;
}

function extraerFechaBoletin(texto) {
  // Busca BOA20251205 dentro del texto
  const match = texto.match(/BOA(\d{8})/);
  return match ? match[1] : null;
}

// =============================
//  EXPORTS
// =============================
module.exports = {
  getFechaHoyYYYYMMDD,
  obtenerMlkobSumarioHoy,
  descargarBoaPdf,
  extraerTextoPdf,
  procesarBoaPdf,
  procesarBoaDeHoy,
  extraerFechaBoletin,
};
