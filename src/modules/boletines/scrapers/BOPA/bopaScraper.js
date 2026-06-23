// src/boletines/BOPA/bopaScraper.js
//
// Scraper del BOPA (Boletín Oficial del Principado de Asturias).
//
// El portal usa Liferay en miprincipado.asturias.es.
// La página de listado (sede.asturias.es/bopa) incluye links a sumarios con el patrón:
//   https://miprincipado.asturias.es/bopa-sumario?...&p_r_p_summaryDate=DD%2FMM%2FYYYY&...
// En el sumario, cada disposición se representa como un par <dt>/<dd>:
//   <dt>Título completo [Cód. YYYY-NNNNN]</dt>
//   <dd><a title="Texto de la disposición" href="..."></dd>
// El texto completo está en #main-content de la página de la disposición.

const axios = require('axios');
const cheerio = require('cheerio');
const { esTextoErrorPortal } = require('../shared/portalErrorText');
const { extraerTextoPdf } = require('../../../../shared/pdfExtractor');

// Texto minimo para considerar que una disposicion trae contenido oficial util.
// Por debajo de esto (o si es texto de error del portal) se intenta el PDF y, si
// tampoco hay evidencia, la alerta se marca needs_evidence en vez de listo.
const MIN_TEXTO_UTIL = 40;

const LISTING_URL = 'https://sede.asturias.es/bopa';
const BASE_SUMARIO = 'https://miprincipado.asturias.es/bopa-sumario';
const SUMARIO_PARAMS =
  'p_p_id=pa_sede_bopa_web_portlet_SedeBopaSummaryWeb' +
  '&p_p_lifecycle=0&p_p_state=normal&p_p_mode=view' +
  '&p_r_p_summaryIsSearch=false';

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

// YYYY-MM-DD → DD%2FMM%2FYYYY (formato que usa la URL del sumario BOPA)
function fechaIsoABopaParam(fechaISO) {
  const [yyyy, mm, dd] = fechaISO.split('-');
  return `${dd}%2F${mm}%2F${yyyy}`;
}

// Extrae la fecha ISO de un href de sumario BOPA (DD%2FMM%2FYYYY → YYYY-MM-DD)
function extraerFechaDeHref(href) {
  const match = href.match(/p_r_p_summaryDate=(\d{2})%2F(\d{2})%2F(\d{4})/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function buildSumarioUrl(fechaISO) {
  return `${BASE_SUMARIO}?${SUMARIO_PARAMS}&p_r_p_summaryDate=${fechaIsoABopaParam(fechaISO)}`;
}

async function getHtml(url) {
  const { data } = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
  });
  return data;
}

// Devuelve los boletines recientes listados en la página principal del BOPA.
async function obtenerBoletinesRecientes() {
  const html = await getHtml(LISTING_URL);
  const $ = cheerio.load(html);
  const boletines = [];
  const vistos = new Set();

  $('a[href*="bopa-sumario"][href*="p_r_p_summaryDate="]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const fecha = extraerFechaDeHref(href);
    if (!fecha || vistos.has(fecha)) return;
    vistos.add(fecha);
    boletines.push({ fecha, url: href });
  });

  return boletines;
}

// Devuelve el boletín más reciente (o el de la fecha pedida si existe).
async function obtenerBoletinObjetivo(fechaISO) {
  if (fechaISO) {
    // Construimos la URL directamente: no hace falta raspar el listado
    return { fecha: fechaISO, url: buildSumarioUrl(fechaISO) };
  }

  const boletines = await obtenerBoletinesRecientes();
  if (!boletines.length) throw new Error('No se han encontrado boletines recientes del BOPA');
  return boletines[0];
}

// Devuelve todos los documentos del sumario de un boletín.
// Estructura HTML: <dl> con pares <dt>título</dt><dd><a title="Texto de la disposición" ...></dd>
async function obtenerDocumentosSumario(boletin) {
  const html = await getHtml(boletin.url);
  const $ = cheerio.load(html);
  const docs = [];
  const vistos = new Set();

  $('a[title="Texto de la disposición"]').each((_, el) => {
    const url = $(el).attr('href') || '';
    if (!url || vistos.has(url)) return;
    vistos.add(url);

    // El título está en el <dt> anterior al <dd> que contiene este link
    const titulo = normalizarEspacios(
      $(el).closest('dd').prev('dt').text()
    )
      .replace(/\[Cód\.\s*[\d-]+\]/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);

    if (!titulo) return;

    docs.push({ titulo, url, fecha: boletin.fecha });
  });

  return docs;
}

// Intenta extraer texto oficial de un PDF alternativo enlazado en la página de la
// disposición (cuando el HTML del portal devolvió error/boilerplate). Best-effort:
// si no hay enlace PDF, no es un PDF real o no se puede parsear, devuelve null.
async function obtenerTextoPdfAlternativo($, baseUrl) {
  const href = $('a[href$=".pdf"], a[href*=".pdf?"], a[href*="type=pdf"]').first().attr('href');
  if (!href) return null;

  let pdfUrl;
  try {
    pdfUrl = new URL(href, baseUrl).toString();
  } catch {
    return null;
  }

  const { data } = await axios.get(pdfUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 5,
    headers: { Accept: 'application/pdf,*/*', 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const buf = Buffer.from(data);
  if (buf.slice(0, 4).toString('utf8') !== '%PDF') return null;

  const texto = normalizarEspacios(await extraerTextoPdf(buf));
  return texto ? { texto, url: pdfUrl } : null;
}

// Extrae el contenido oficial de una disposición. Devuelve un objeto con la
// evidencia: si el portal responde con texto de error/boilerplate o sin contenido
// util, intenta el PDF alternativo; si tampoco hay evidencia, marca evidencia=false
// (la alerta no debe marcarse como lista) y conserva el texto del portal para auditoría.
async function obtenerTextoDocumento(url, deps = {}) {
  const fetchHtml = deps.getHtml || getHtml;
  const fetchPdf = deps.obtenerTextoPdfAlternativo || obtenerTextoPdfAlternativo;

  let textoPortal = '';
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    textoPortal = normalizarEspacios($('#main-content').text()).slice(0, 12000);

    if (textoPortal && !esTextoErrorPortal(textoPortal) && textoPortal.length >= MIN_TEXTO_UTIL) {
      return { texto: textoPortal, evidencia: true };
    }

    // El portal devolvió error/boilerplate o texto insuficiente → intentar PDF oficial.
    const pdf = await Promise.resolve()
      .then(() => fetchPdf($, url))
      .catch(() => null);
    if (pdf?.texto && !esTextoErrorPortal(pdf.texto) && pdf.texto.length >= MIN_TEXTO_UTIL) {
      return { texto: pdf.texto.slice(0, 12000), evidencia: true, urlPdf: pdf.url || null };
    }

    return {
      texto: '',
      evidencia: false,
      motivo: esTextoErrorPortal(textoPortal) ? 'portal_error' : 'sin_texto_util',
      texto_original: textoPortal,
    };
  } catch {
    return { texto: '', evidencia: false, motivo: 'fetch_error', texto_original: textoPortal };
  }
}

// Función principal: documentos del BOPA del día indicado que pasan el filtro rural.
// `deps` permite inyectar las dependencias de red para tests (mismo patrón que DOGV/DOGC).
async function obtenerDocumentosBopaConTexto(fechaISO, esRuralRelevante, deps = {}) {
  const obtenerBoletin = deps.obtenerBoletinObjetivo || obtenerBoletinObjetivo;
  const obtenerDocs = deps.obtenerDocumentosSumario || obtenerDocumentosSumario;
  const obtenerTexto = deps.obtenerTextoDocumento || obtenerTextoDocumento;

  const boletin = await obtenerBoletin(fechaISO || null);
  const todos = await obtenerDocs(boletin);
  const resultado = [];
  let sinEvidencia = 0;

  // Captura bruta: se devuelven TODOS los detectados anotados con `_relevante`; el
  // texto solo se descarga para los relevantes (coste idéntico al de antes).
  for (const doc of todos) {
    if (!esRuralRelevante(doc.titulo)) {
      resultado.push({ ...doc, _relevante: false });
      continue;
    }

    await sleep(DELAY_MS);
    const evidencia = await obtenerTexto(doc.url, deps);

    if (evidencia.evidencia) {
      resultado.push({
        ...doc,
        texto: evidencia.texto,
        ...(evidencia.urlPdf ? { urlPdf: evidencia.urlPdf } : {}),
        _relevante: true,
      });
      continue;
    }

    // Sin evidencia oficial: la alerta se inserta como needs_evidence (no llega a
    // 'listo'). NO se pasa el boilerplate como contenido; se conserva en texto_raw
    // para que el raw_document quede auditado.
    sinEvidencia++;
    resultado.push({
      ...doc,
      texto: '',
      texto_raw: evidencia.texto_original || '',
      _relevante: true,
      _sin_evidencia: true,
      _estado_ia: 'needs_evidence',
      _evidence_reason: evidencia.motivo || 'sin_evidencia',
    });
  }

  console.log(`[BOPA] ${resultado.length} documentos detectados (captura bruta) de ${todos.length}; ${sinEvidencia} sin evidencia (needs_evidence)`);
  return resultado;
}

module.exports = {
  obtenerDocumentosBopaConTexto,
  obtenerTextoDocumento,
  obtenerTextoPdfAlternativo,
  obtenerBoletinesRecientes,
  getFechaHoyISO,
};
