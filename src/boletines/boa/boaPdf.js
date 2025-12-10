// src/boletines/boa/boaPdf.js

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
//  OBTENER MLKOB DEL BOA DE HOY (probando varias URLs)
// =============================
async function buscarMlkobEnUrl(url) {
  console.log('Probando listado BOA:', url);

  let response;
  try {
    response = await axios.get(url);
  } catch (e) {
    console.error('❌ Error HTTP al pedir listado BOA:', e.message);
    return null;
  }

  const html = response.data;
  const $ = cheerio.load(html);

  let mlkob = null;

  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('CMD=VEROBJ') && href.includes('MLKOB=')) {
      const match = href.match(/MLKOB=(\d+)/);
      if (match) {
        mlkob = match[1];
        return false; // cortar el bucle
      }
    }
  });

  if (!mlkob) {
    console.log('⚠️ En este listado no se ha encontrado ningún MLKOB');
    return null;
  }

  console.log('✅ MLKOB encontrado en este listado:', mlkob);
  return mlkob;
}

async function obtenerMlkobSumarioHoy() {
  const fecha = getFechaHoyYYYYMMDD();
  const base = 'https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI';

  // Probamos varias combinaciones “razonables” que usa el CGI del BOA
  const urls = [
    // La que ya tenías
    `${base}?BASE=BZHT&CMD=VERLST&DOCS=1-200&PUBL=&PUBL-C=${fecha}&RNG=200&SEC=FIRMA&SECC-C=&SEPARADOR=`,
    // Misma pero usando PUBL=fecha
    `${base}?BASE=BZHT&CMD=VERLST&DOCS=1-200&PUBL=${fecha}&RNG=200&SEC=FIRMA&SECC-C=&SEPARADOR=`,
    // Sin SEC=FIRMA, por si el sumario está en otra sección
    `${base}?BASE=BZHT&CMD=VERLST&DOCS=1-200&PUBL=${fecha}&RNG=200&SEPARADOR=`,
    // Variante sin PUBL (por si usan PUBL-C internamente)
    `${base}?BASE=BZHT&CMD=VERLST&DOCS=1-200&PUBL-C=${fecha}&RNG=200&SEPARADOR=`
  ];

  for (const url of urls) {
    const mlkob = await buscarMlkobEnUrl(url);
    if (mlkob) {
      console.log('✅ Usaremos este MLKOB para el BOA de hoy:', mlkob);
      return mlkob;
    }
  }

  console.log(
    `⚠️ No se ha podido encontrar ningún MLKOB para la fecha ${fecha} en ninguno de los listados probados`
  );
  return null;
}

// =============================
//  DESCARGAR PDF POR MLKOB
// =============================
async function descargarBoaPdf(mlkob) {
  const url = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;

  console.log('Descargando PDF del BOA:', url);

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
    const strings = content.items.map((item) => item.str).join(' ');
    texto += strings + '\n';
  }

  return texto;
}

// =============================
//  PROCESAR PDF COMPLETO (por MLKOB)
// =============================
async function procesarBoaPdf(mlkob) {
  if (!mlkob) {
    console.log('⚠️ procesarBoaPdf llamado sin MLKOB');
    return null;
  }

  console.log('Descargando PDF del BOA con MLKOB:', mlkob);

  const pdfBuffer = await descargarBoaPdf(mlkob);
  console.log('PDF descargado, tamaño:', pdfBuffer.byteLength);

  const texto = await extraerTextoPdf(pdfBuffer);

  console.log('Primeros 1000 caracteres del PDF:\n');
  console.log(texto.slice(0, 1000));

  return texto;
}

// =============================
//  EXTRAER FECHA DEL BOLETÍN
// =============================
function extraerFechaBoletin(texto) {
  // Busca BOA20251205 dentro del texto
  const match = texto && texto.match(/BOA(\d{8})/);
  return match ? match[1] : null;
}

// =============================
//  DIVIDIR TEXTO EN DISPOSICIONES
// =============================
function dividirEnDisposiciones(texto) {
  const patrones = [
    /ORDEN\s+[A-ZÁÉÍÓÚ0-9\/\-]+/g,
    /RESOLUCIÓN\s+de\s+/g,
    /ANUNCIO\s+de\s+/g,
    /DEPARTAMENTO\s+DE\s+[A-ZÁÉÍÓÚÑ ]+/g,
  ];

  const regex = new RegExp(patrones.map((p) => p.source).join('|'), 'g');

  const indices = [];
  let match;
  while ((match = regex.exec(texto)) !== null) {
    indices.push(match.index);
  }

  if (indices.length === 0) return [texto];

  const disposiciones = [];

  for (let i = 0; i < indices.length; i++) {
    const inicio = indices[i];
    const fin = indices[i + 1] ?? texto.length;
    const bloque = texto.slice(inicio, fin).trim();
    if (bloque.length > 80) {
      disposiciones.push(bloque);
    }
  }

  return disposiciones;
}

// =============================
//  PROCESAR BOA DE HOY COMPLETO
// =============================
//
// Devuelve { mlkob, texto, fechaBoletin } o null
// ya NO bloqueamos si la fecha del PDF no coincide con hoy.
//
async function procesarBoaDeHoy() {
  const hoy = getFechaHoyYYYYMMDD();
  const mlkob = await obtenerMlkobSumarioHoy();

  if (!mlkob) {
    console.log(`⚠️ No se ha encontrado MLKOB para hoy (${hoy}), no se procesa nada.`);
    return null;
  }

  const texto = await procesarBoaPdf(mlkob);
  if (!texto) {
    console.log('⚠️ No se ha podido extraer texto del PDF del BOA');
    return null;
  }

  const fechaBoletin = extraerFechaBoletin(texto);
  console.log(`ℹ️ Fecha detectada dentro del PDF: ${fechaBoletin} (hoy ${hoy})`);

  return { mlkob, texto, fechaBoletin };
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
  dividirEnDisposiciones,
};
