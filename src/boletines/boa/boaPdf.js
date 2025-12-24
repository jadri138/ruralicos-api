// src/boletines/boa/boaPdf.js

const axios = require('axios');
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
//  OBTENER TODOS LOS MLKOB DE UN DÍA (OpenData JSON)
// =============================
// Motivo: la web "#/resultados-fecha" es SPA.
// Usamos OPENDATA JSON para sacar TODOS los documentos del día.
async function obtenerMlkobsPorFecha(fechaYYYYMMDD) {
  const fecha = fechaYYYYMMDD;
  const baseUrl = 'https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI';

  // Subimos DOCS por si hay muchos resultados (boletines largos).
  const urls = [
    `${baseUrl}?CMD=VERLST&OUTPUTMODE=JSON&BASE=BOLE&DOCS=1-800&SEC=OPENDATABOAJSON&SORT=-PUBL&SEPARADOR=&@PUBL-GE=${fecha}&@PUBL-LE=${fecha}`,
    `${baseUrl}?CMD=VERLST&OUTPUTMODE=JSON&BASE=BZHT&DOCS=1-800&SEC=OPENDATABOAJSON&SORT=-PUBL&SEPARADOR=&@PUBL-GE=${fecha}&@PUBL-LE=${fecha}`,

    // Fallbacks por si el servidor acepta otros filtros
    `${baseUrl}?CMD=VERLST&OUTPUTMODE=JSON&BASE=BOLE&DOCS=1-800&SEC=OPENDATABOAJSON&PUBL=${fecha}`,
    `${baseUrl}?CMD=VERLST&OUTPUTMODE=JSON&BASE=BZHT&DOCS=1-800&SEC=OPENDATABOAJSON&PUBL-C=${fecha}`,
  ];

  const mlkobs = new Set();

  for (const url of urls) {
    try {
      console.log('BOA OPENDATA →', url);
      const resp = await axios.get(url, { timeout: 20000 });

      // A veces devuelve objeto, a veces string JSON.
      const payload =
        typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;

      // Estrategia robusta: extraer TODOS los MLKOB del JSON serializado.
      const plano = JSON.stringify(payload);

      // Caso estándar: "MLKOB":"123..."
      for (const m of plano.matchAll(/"MLKOB"\s*:\s*"(\d+)"/g)) {
        if (m[1]) mlkobs.add(m[1]);
      }

      // Fallback: MLKOB=123...
      for (const m of plano.matchAll(/MLKOB=(\d+)/g)) {
        if (m[1]) mlkobs.add(m[1]);
      }
    } catch (e) {
      console.error('❌ Error OPENDATA BOA:', e.message);
    }
  }

  const lista = Array.from(mlkobs);

  // Ordenar numéricamente (como strings largas, usamos BigInt)
  lista.sort((a, b) => {
    try {
      return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
    } catch {
      return a.localeCompare(b);
    }
  });

  console.log(`✅ MLKOB encontrados para ${fecha}:`, lista.length);
  return lista;
}

// Conveniencia: hoy
async function obtenerMlkobsSumarioHoy() {
  const fecha = getFechaHoyYYYYMMDD();
  return obtenerMlkobsPorFecha(fecha);
}

// =============================
//  DESCARGAR PDF POR MLKOB (forzando type=pdf)
// =============================
async function descargarBoaPdf(mlkob) {
  const url = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}&type=pdf`;

  console.log('Descargando PDF del BOA:', url);

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: {
      Accept: 'application/pdf,*/*',
    },
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

  console.log('Procesando PDF del BOA con MLKOB:', mlkob);

  const pdfBuffer = await descargarBoaPdf(mlkob);
  console.log('PDF descargado, tamaño:', pdfBuffer.byteLength);

  const texto = await extraerTextoPdf(pdfBuffer);

  console.log('Primeros 600 caracteres del PDF:\n');
  console.log(texto.slice(0, 600));

  return texto;
}

// =============================
//  EXTRAER FECHA DEL BOLETÍN (si aparece como BOAYYYYMMDD)
// =============================
function extraerFechaBoletin(texto) {
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
    if (bloque.length > 80) disposiciones.push(bloque);
  }

  return disposiciones;
}

// =============================
//  PROCESAR UN MLKOB (descarga + texto + fecha detectada)
// =============================
async function procesarBoaPorMlkob(mlkob) {
  const texto = await procesarBoaPdf(mlkob);
  if (!texto) return null;
  const fechaBoletin = extraerFechaBoletin(texto);
  return { mlkob, texto, fechaBoletin };
}

module.exports = {
  // fecha
  getFechaHoyYYYYMMDD,

  // mlkobs
  obtenerMlkobsPorFecha,
  obtenerMlkobsSumarioHoy,

  // pdf/texto
  descargarBoaPdf,
  extraerTextoPdf,
  procesarBoaPdf,
  procesarBoaPorMlkob,

  // util
  extraerFechaBoletin,
  dividirEnDisposiciones,
};
