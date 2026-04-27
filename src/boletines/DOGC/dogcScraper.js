// src/boletines/DOGC/dogcScraper.js
//
// Scraper del DOGC (Diari Oficial de la Generalitat de Catalunya).
//
// Fuente de datos: API Socrata (datos abiertos de la Generalitat)
//   https://analisi.transparenciacatalunya.cat/resource/n6hn-rmy7.json
//
// Cubre: Lleis, Decrets, Ordres, Resolucions, Acords y Anuncis
// publicados en el DOGC para una fecha concreta.
//
// Para cada disposición relevante se intenta obtener el texto completo
// desde la URL HTML oficial. Si falla, se usa el título como contenido.

const axios  = require('axios');
const cheerio = require('cheerio');

const SOCRATA_URL = 'https://analisi.transparenciacatalunya.cat/resource/n6hn-rmy7.json';
const DELAY_MS    = 800; // delay entre fetches de HTML para no saturar

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function getFechaHoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Extrae texto limpio de una página HTML del DOGC
async function fetchTextoHtml(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 15000,
      headers: {
        'Accept': 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)',
      },
    });
    const $ = cheerio.load(data);
    // Eliminar nav, header, footer, scripts y estilos
    $('nav, header, footer, script, style, .menu, .breadcrumb, .related').remove();
    // Intentar extraer el contenido principal
    const main = $('article, main, .contingut, #contingut, .document-content, .cos-document').text()
      || $('body').text();
    return main.replace(/\s+/g, ' ').trim().slice(0, 12000);
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────
// Función principal
// ─────────────────────────────────────────────
async function obtenerDocumentosDogcPorFecha(fechaISO) {
  const fechaSiguiente = new Date(fechaISO);
  fechaSiguiente.setDate(fechaSiguiente.getDate() + 1);
  const fechaSigStr = fechaSiguiente.toISOString().slice(0, 10);

  const where  = `data_de_publicaci_del_diari >= '${fechaISO}T00:00:00.000' AND data_de_publicaci_del_diari < '${fechaSigStr}T00:00:00.000'`;
  const params = new URLSearchParams({
    '$where': where,
    '$limit': '200',
    '$order': 'data_de_publicaci_del_diari ASC',
  });

  console.log('[DOGC] Consultando Socrata para', fechaISO);
  const { data } = await axios.get(`${SOCRATA_URL}?${params}`, {
    timeout: 20000,
    headers: { Accept: 'application/json' },
  });

  if (!Array.isArray(data) || data.length === 0) {
    console.log('[DOGC] Sin disposiciones para', fechaISO);
    return [];
  }

  console.log(`[DOGC] ${data.length} disposiciones encontradas`);

  return data.map(d => {
    // Preferimos título en castellano; fallback al catalán
    const titulo = (d.t_tol_de_la_norma_es || d.t_tol_de_la_norma || '').replace(/\s+/g, ' ').trim().slice(0, 250);
    const rang   = d.rang_de_norma || '';
    const numero = d.n_mero_de_diari || '';

    // URL HTML en castellano preferida; fallback catalán
    const urlHtml = d.url_es_formato_html?.url || d.format_html?.url || null;
    const urlPdf  = d.url_es_formato_pdf?.url  || d.format_pdf?.url  || null;

    return {
      titulo,
      rang,
      url:    urlHtml || urlPdf || '',
      urlPdf: urlPdf || null,
      fecha:  fechaISO,
      seccion: rang,
      // texto se rellena luego para los relevantes
      texto: titulo,
      _urlHtml: urlHtml,
    };
  }).filter(d => d.url);
}

async function obtenerDocumentosDogcConTexto(fechaISO, esRuralRelevante) {
  const docs = await obtenerDocumentosDogcPorFecha(fechaISO);
  const resultado = [];

  for (const doc of docs) {
    // Pre-filtro por título antes de hacer fetch de HTML
    if (!esRuralRelevante(doc.titulo)) continue;

    // Intentar obtener texto completo
    let texto = doc.titulo;
    if (doc._urlHtml) {
      await sleep(DELAY_MS);
      const contenidoHtml = await fetchTextoHtml(doc._urlHtml);
      if (contenidoHtml.length > 100) texto = contenidoHtml;
    }

    resultado.push({ ...doc, texto });
  }

  return resultado;
}

module.exports = { obtenerDocumentosDogcConTexto, getFechaHoyISO };
