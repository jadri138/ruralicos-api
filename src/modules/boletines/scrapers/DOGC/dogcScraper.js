// src/boletines/DOGC/dogcScraper.js
//
// Scraper del DOGC (Diari Oficial de la Generalitat de Catalunya).
//
// Fuente de datos: API interna de portaldogc.gencat.cat (real-time, mismo día)
//   POST /eadop-rest/api/dogc/summaryLastPublishedDOGC  → número DOGC del día
//   POST /eadop-rest/api/dogc/summaryDOGC               → documentos del número

const axios   = require('axios');
const cheerio = require('cheerio');

const BASE_REST  = 'https://portaldogc.gencat.cat/eadop-rest/api/dogc';
const BASE_HTML  = 'https://dogc.gencat.cat/es/document-del-dogc/';
const DELAY_MS   = 800;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function getFechaHoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Extrae documentId del PDF URL:
// https://portaldogc.gencat.cat/utilsEADOP/AppJava/PdfProviderServlet?documentId=1042861&type=01...
function extraerDocumentId(pdfUrl) {
  if (!pdfUrl) return null;
  const m = pdfUrl.match(/documentId=(\d+)/);
  return m ? m[1] : null;
}

// Recorre la estructura anidada section → header → document y devuelve lista plana
function extraerDocumentos(sections) {
  const docs = [];
  if (!Array.isArray(sections)) return docs;

  for (const section of sections) {
    // Recursión en subsecciones
    if (Array.isArray(section.section)) {
      docs.push(...extraerDocumentos(section.section));
    }
    if (!Array.isArray(section.header)) continue;
    for (const header of section.header) {
      if (!Array.isArray(header.document)) continue;
      for (const doc of header.document) {
        const titulo = (doc.title || '').replace(/\s+/g, ' ').trim().slice(0, 250);
        const pdfUrl = doc.linkDownloadDocumentPDF || null;
        const docId  = extraerDocumentId(pdfUrl);
        const urlHtml = docId
          ? `${BASE_HTML}?action=fitxa&documentId=${docId}`
          : null;

        docs.push({
          titulo,
          docId,
          url:    urlHtml || pdfUrl || '',
          urlPdf: pdfUrl || null,
          _urlHtml: urlHtml,
        });
      }
    }
  }
  return docs;
}

// Fetch texto limpio de la página HTML del DOGC
async function fetchTextoHtml(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 15000,
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)',
      },
    });
    const $ = cheerio.load(data);
    $('nav, header, footer, script, style, .menu, .breadcrumb, .related').remove();
    const main = $('article, main, .contingut, #contingut, .document-content, .cos-document').text()
      || $('body').text();
    return main.replace(/\s+/g, ' ').trim().slice(0, 12000);
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────
// Paso 1: obtener número del DOGC publicado hoy
// ─────────────────────────────────────────────
async function obtenerNumDogcHoy() {
  const { data } = await axios.post(
    `${BASE_REST}/summaryLastPublishedDOGC`,
    'language=es',
    {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    },
  );

  const numDOGC = data?.sumaris?.[0]?.numDOGC;
  if (!numDOGC) throw new Error('[DOGC] No se obtuvo numDOGC de summaryLastPublishedDOGC');
  console.log('[DOGC] Número DOGC hoy:', numDOGC);
  return numDOGC;
}

// ─────────────────────────────────────────────
// Paso 2: obtener lista de documentos del DOGC
// seccion=1 cubre Disposicions generals + Altres disposicions + Anuncis
// ─────────────────────────────────────────────
async function obtenerDocumentosDogcPorNumero(numDOGC) {
  const { data } = await axios.post(
    `${BASE_REST}/summaryDOGC`,
    `language=es&numDOGC=${numDOGC}&seccion=1`,
    {
      timeout: 20000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    },
  );

  const sections = data?.sumaris?.[0]?.section;
  const docs = extraerDocumentos(sections);
  console.log(`[DOGC] ${docs.length} documentos encontrados en DOGC ${numDOGC}`);
  return docs;
}

// ─────────────────────────────────────────────
// Función principal exportada
// ─────────────────────────────────────────────
async function obtenerDocumentosDogcConTexto(fechaISO, esRuralRelevante, deps = {}) {
  const obtenerNum = deps.obtenerNumDogcHoy || obtenerNumDogcHoy;
  const obtenerDocs = deps.obtenerDocumentosDogcPorNumero || obtenerDocumentosDogcPorNumero;
  const traerTexto = deps.fetchTextoHtml || fetchTextoHtml;

  const numDOGC = await obtenerNum();
  const todos   = await obtenerDocs(numDOGC);

  const resultado = [];

  // Captura bruta: se devuelven TODOS los documentos detectados (incluidos los que
  // no tienen URL, que antes se descartaban en silencio) anotados con `_relevante`.
  // El texto solo se descarga para los relevantes (coste idéntico al de antes).
  for (const doc of todos) {
    if (!esRuralRelevante(doc.titulo)) {
      resultado.push({ ...doc, fecha: fechaISO, _relevante: false });
      continue;
    }

    let texto = doc.titulo;
    if (doc._urlHtml) {
      await sleep(DELAY_MS);
      const contenidoHtml = await traerTexto(doc._urlHtml);
      if (contenidoHtml.length > 100) texto = contenidoHtml;
    }

    resultado.push({ ...doc, fecha: fechaISO, texto, _relevante: true });
  }

  console.log(`[DOGC] ${resultado.length} documentos detectados (captura bruta)`);
  return resultado;
}

module.exports = { obtenerDocumentosDogcConTexto, getFechaHoyISO };
