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
//  OBTENER MLKOB DEL BOA DE HOY (OpenData JSON)
// =============================
// Motivo: la web "#/resultados-fecha" es SPA; rascar HTML no siempre funciona.
// Usamos el CGI del BOA en modo JSON para localizar MLKOB de forma robusta.
async function obtenerMlkobSumarioHoy() {
  const fecha = getFechaHoyYYYYMMDD();
  const baseUrl = 'https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI';

  // Probamos varias combinaciones por si cambian parámetros internos.
  const urls = [
    // Rango exacto del día (GE/LE)
    `${baseUrl}?CMD=VERLST&OUTPUTMODE=JSON&BASE=BOLE&DOCS=1-200&SEC=OPENDATABOAJSON&SORT=-PUBL&SEPARADOR=&@PUBL-GE=${fecha}&@PUBL-LE=${fecha}`,
    `${baseUrl}?CMD=VERLST&OUTPUTMODE=JSON&BASE=BZHT&DOCS=1-200&SEC=OPENDATABOAJSON&SORT=-PUBL&SEPARADOR=&@PUBL-GE=${fecha}&@PUBL-LE=${fecha}`,

    // Fallback: algunas instalaciones aceptan PUBL o PUBL-C
    `${baseUrl}?CMD=VERLST&OUTPUTMODE=JSON&BASE=BOLE&DOCS=1-200&SEC=OPENDATABOAJSON&PUBL=${fecha}`,
    `${baseUrl}?CMD=VERLST&OUTPUTMODE=JSON&BASE=BZHT&DOCS=1-200&SEC=OPENDATABOAJSON&PUBL-C=${fecha}`,
  ];

  for (const url of urls) {
    try {
      console.log('BOA OPENDATA →', url);
      const resp = await axios.get(url, { timeout: 20000 });

      // A veces devuelve objeto, a veces string JSON.
      const payload =
        typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;

      // Estrategia robusta: buscamos el primer MLKOB numérico dentro del payload.
      const plano = JSON.stringify(payload);
      const m1 = plano.match(/"MLKOB"\s*:\s*"(\d+)"/);
      if (m1 && m1[1]) {
        console.log('✅ MLKOB encontrado (JSON):', m1[1]);
        return m1[1];
      }

      // Fallback: por si viene como MLKOB=12345
      const m2 = plano.match(/MLKOB=(\d+)/);
      if (m2 && m2[1]) {
        console.log('✅ MLKOB encontrado (texto):', m2[1]);
        return m2[1];
      }

      console.log('⚠️ OPENDATA respondió pero sin MLKOB detectado.');
    } catch (e) {
      console.error('❌ Error OPENDATA BOA:', e.message);
    }
  }

  console.log(`⚠️ No se ha podido encontrar MLKOB para la fecha ${fecha}`);
  return null;
}

// =============================
//  DESCARGAR PDF POR MLKOB (forzando type=pdf)
// =============================
async function descargarBoaPdf(mlkob) {
  // Nota: forzamos PDF para evitar respuestas HTML.
  const url = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}&type=pdf`;

  console.log('Descargando PDF del BOA:', url);

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: {
      // A veces ayuda con servidores quisquillosos
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
//  EXTRAER FECHA DEL BOLETÍN
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
//  PROCESAR BOA DE HOY COMPLETO
// =============================
// Devuelve { mlkob, texto, fechaBoletin } o null
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
