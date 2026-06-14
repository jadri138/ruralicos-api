// src/boletines/DOGV/dogvScraper.js
//
// Scraper del DOGV (Diari Oficial de la Generalitat Valenciana).
//
// API interna (real-time, sin lag):
//   GET /dogv-portal/dogv/latest?lang=es          → todos los documentos del día
//   GET /dogv-portal/disposicion/{id}?lang=es     → texto HTML completo del documento

const axios   = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://dogv.gva.es/dogv-portal';
const DATOS = 'https://dogv.gva.es/datos';
const DELAY_MS = 600;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getFechaHoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Extrae texto limpio del HTML que devuelve la API
function htmlATexto(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  return $.text().replace(/\s+/g, ' ').trim().slice(0, 12000);
}

// ─────────────────────────────────────────────
// Paso 1: todos los documentos del DOGV de hoy
// ─────────────────────────────────────────────
async function obtenerDocumentosHoy() {
  const { data } = await axios.get(`${BASE}/dogv/latest`, {
    params: { lang: 'es' },
    timeout: 15000,
    headers: { Accept: 'application/json' },
  });

  if (!data || !Array.isArray(data.disposiciones)) {
    console.log('[DOGV] Sin disposiciones hoy');
    return [];
  }

  console.log(`[DOGV] ${data.disposiciones.length} disposiciones encontradas`);
  return data.disposiciones;
}

// ─────────────────────────────────────────────
// Paso 2: texto completo de un documento
// ─────────────────────────────────────────────
async function obtenerTextoDisposicion(id) {
  try {
    const { data } = await axios.get(`${BASE}/disposicion/${id}`, {
      params: { lang: 'es' },
      timeout: 15000,
      headers: { Accept: 'application/json' },
    });
    return htmlATexto(data?.texto || '');
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────
// Función principal exportada
// ─────────────────────────────────────────────
async function obtenerDocumentosDogvConTexto(fechaISO, esRuralRelevante) {
  const disposiciones = await obtenerDocumentosHoy();
  const resultado = [];

  for (const doc of disposiciones) {
    const titulo = (doc.titulo || '').replace(/\s+/g, ' ').trim().slice(0, 250);
    if (!esRuralRelevante(titulo)) continue;

    await sleep(DELAY_MS);
    const texto = await obtenerTextoDisposicion(doc.id);

    const urlPdf = doc.urlPdf ? `${DATOS}${doc.urlPdf}` : '';

    resultado.push({
      titulo,
      url:    urlPdf,
      urlPdf: urlPdf,
      fecha:  fechaISO,
      texto:  texto || titulo,
    });
  }

  console.log(`[DOGV] ${resultado.length} documentos relevantes para insertar`);
  return resultado;
}

module.exports = { obtenerDocumentosDogvConTexto, getFechaHoyISO };
