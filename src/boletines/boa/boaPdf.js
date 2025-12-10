// ==========================
//  BOA SCRAPER - API NUEVA
// ==========================

const axios = require("axios");
const pdfjsLib = require("pdfjs-dist/build/pdf.js");

// Obtener fecha actual en formato YYYY-MM-DD (formato API nueva)
function getFechaHoyISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Obtener fecha actual en formato YYYYMMDD (para validaciones internas)
function getFechaHoyYYYYMMDD() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// ==========================================================
// 🚀 1) OBTENER TODAS LAS PUBLICACIONES DEL DÍA DESDE LA API NUEVA
// ==========================================================
async function obtenerPublicacionesDeHoy() {
  const hoyISO = getFechaHoyISO();

  const url = `https://www.boa.aragon.es/api/buscador/documents?fechaPublicacion=${hoyISO}&page=0&size=200`;

  console.log("Consultando API nueva del BOA:", url);

  const response = await axios.get(url);
  const json = response.data;

  if (!json || !json.content || json.content.length === 0) {
    console.log(`⚠️ La API del BOA no devuelve publicaciones para hoy (${hoyISO})`);
    return [];
  }

  return json.content; // contiene MLKOB, títulos, tipos, etc.
}

// ==========================================================
// 🚀 2) OBTENER TODOS LOS MLKOB DISPONIBLES HOY
// ==========================================================
async function obtenerMlkobsDeHoy() {
  const publicaciones = await obtenerPublicacionesDeHoy();
  return publicaciones.map(p => p.mlkob).filter(Boolean);
}

// ==========================================================
// 🚀 3) DESCARGAR PDF POR MLKOB
// ==========================================================
async function descargarBoaPdf(mlkob) {
  const url = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;

  const response = await axios.get(url, { responseType: "arraybuffer" });

  return Buffer.from(response.data);
}

// ==========================================================
// 🚀 4) EXTRAER TEXTO DEL PDF COMPLETO
// ==========================================================
async function extraerTextoPdf(buffer) {
  const uint8 = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data: uint8 });
  const pdf = await loadingTask.promise;

  let texto = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    texto += content.items.map(obj => obj.str).join(" ") + "\n";
  }

  return texto;
}

// ==========================================================
// 🚀 5) PROCESAR UN MLKOB (descargar + extraer texto)
// ==========================================================
async function procesarBoaPdf(mlkob) {
  console.log("Descargando PDF MLKOB:", mlkob);
  const pdf = await descargarBoaPdf(mlkob);
  const texto = await extraerTextoPdf(pdf);
  return texto;
}

// ==========================================================
// 🚀 6) EXTRAER FECHA DEL TEXTO DEL PDF
// ==========================================================
function extraerFechaBoletin(texto) {
  const match = texto.match(/BOA\s*(\d{8})/);
  return match ? match[1] : null;
}

// ==========================================================
// 🚀 7) DIVIDIR EN DISPOSICIONES
// ==========================================================
function dividirEnDisposiciones(texto) {
  const regex = /(ORDEN\s+[A-Z0-9\/\-]+)|(RESOLUCIÓN\s+de)|(ANUNCIO\s+de)|(DEPARTAMENTO\s+DE\s+[A-ZÁÉÍÓÚÑ ]+)/g;

  const indices = [];
  let match;
  while ((match = regex.exec(texto)) !== null) {
    indices.push(match.index);
  }

  if (indices.length === 0) return [texto];

  const bloques = [];
  for (let i = 0; i < indices.length; i++) {
    const inicio = indices[i];
    const fin = indices[i + 1] ?? texto.length;
    const parte = texto.slice(inicio, fin).trim();
    if (parte.length > 50) bloques.push(parte);
  }

  return bloques;
}

// ==========================================================
// 🚀 8) PROCESAR TODOS LOS MLKOB DE HOY
// ==========================================================
async function procesarBoaDeHoy() {
  const hoy = getFechaHoyYYYYMMDD();
  const mlkobs = await obtenerMlkobsDeHoy();

  if (!mlkobs.length) {
    console.log("⚠️ No hay MLKOBs hoy");
    return [];
  }

  console.log("MLKOBs obtenidos:", mlkobs);

  const resultados = [];

  for (const mlkob of mlkobs) {
    const texto = await procesarBoaPdf(mlkob);
    resultados.push({ mlkob, texto });
  }

  return resultados; // ← ahora devuelve ARRAY de PDFs
}

module.exports = {
  getFechaHoyYYYYMMDD,
  obtenerPublicacionesDeHoy,
  obtenerMlkobsDeHoy,
  procesarBoaPdf,
  procesarBoaDeHoy,
  extraerFechaBoletin,
  dividirEnDisposiciones,
};
