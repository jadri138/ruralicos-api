// Scraper del BOPA (Boletín Oficial del Principado de Asturias).
//
// El sumario oficial publica, para cada disposición, un enlace HTML de detalle y
// un PDF firmado. La URL canónica histórica sigue siendo la de detalle (`doc.url`),
// mientras que el resto de enlaces se conserva para recuperar evidencia sin
// alterar la deduplicación.

const axios = require('axios');
const cheerio = require('cheerio');
const { esTextoErrorPortal } = require('../shared/portalErrorText');
const { evaluarPrefiltroRural } = require('../shared/ruralFilter');
const { extraerTextoPdf } = require('../../../../shared/pdfExtractor');

const MIN_TEXTO_UTIL = 180;
const MAX_TEXTO_EVIDENCIA = 12000;
const MAX_ALTERNATIVAS = 2;

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
  return String(texto || '').replace(/\s+/g, ' ').trim();
}

function normalizarBusqueda(texto) {
  return normalizarEspacios(texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function fechaIsoABopaParam(fechaISO) {
  const [yyyy, mm, dd] = fechaISO.split('-');
  return `${dd}%2F${mm}%2F${yyyy}`;
}

function extraerFechaDeHref(href) {
  const match = String(href || '').match(/p_r_p_summaryDate=(\d{2})%2F(\d{2})%2F(\d{4})/i);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function buildSumarioUrl(fechaISO) {
  return `${BASE_SUMARIO}?${SUMARIO_PARAMS}&p_r_p_summaryDate=${fechaIsoABopaParam(fechaISO)}`;
}

function resolverUrl(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function esUrlOficialBopa(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'asturias.es' || host.endsWith('.asturias.es');
  } catch {
    return false;
  }
}

async function getHtml(url) {
  const { data } = await axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)' },
  });
  return data;
}

async function obtenerBoletinesRecientes() {
  const html = await getHtml(LISTING_URL);
  const $ = cheerio.load(html);
  const boletines = [];
  const vistos = new Set();

  $('a[href*="bopa-sumario"][href*="p_r_p_summaryDate="]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const fecha = extraerFechaDeHref(href);
    const url = resolverUrl(href, LISTING_URL);
    if (!fecha || !url || vistos.has(fecha)) return;
    vistos.add(fecha);
    boletines.push({ fecha, url });
  });

  return boletines;
}

async function obtenerBoletinObjetivo(fechaISO) {
  if (fechaISO) return { fecha: fechaISO, url: buildSumarioUrl(fechaISO) };

  const boletines = await obtenerBoletinesRecientes();
  if (!boletines.length) throw new Error('No se han encontrado boletines recientes del BOPA');
  return boletines[0];
}

function enlaceEsDetalle($, el) {
  const href = $(el).attr('href') || '';
  const etiqueta = normalizarBusqueda(`${$(el).attr('title') || ''} ${$(el).text()}`);
  return /disposition(?:Reference|Text)|\/bopa(?:\/)?disposiciones|bopa-disposiciones/i.test(href)
    || etiqueta.includes('texto de la disposicion');
}

function enlaceEsPdf($, el) {
  const href = $(el).attr('href') || '';
  const etiqueta = normalizarBusqueda(`${$(el).attr('title') || ''} ${$(el).text()}`);
  return /\.pdf(?:[?#]|$)/i.test(href) || etiqueta.includes('pdf de la disposicion');
}

function enlaceEsAlternativa($, el) {
  const etiqueta = normalizarBusqueda(`${$(el).attr('title') || ''} ${$(el).text()}`);
  return /(version imprimible|imprimir|descargar texto|descarga de la disposicion)/i.test(etiqueta);
}

async function obtenerDocumentosSumario(boletin, deps = {}) {
  const fetchHtml = deps.getHtml || getHtml;
  const html = await fetchHtml(boletin.url);
  const $ = cheerio.load(html);
  const docs = [];
  const vistos = new Set();

  $('dd').each((_, dd) => {
    const anchors = $(dd).find('a[href]').toArray();
    const detalle = anchors.find((el) => enlaceEsDetalle($, el));
    const pdf = anchors.find((el) => enlaceEsPdf($, el));
    const alternativas = anchors.filter((el) => enlaceEsAlternativa($, el));
    if (!detalle && !pdf) return;

    const tituloConCodigo = normalizarEspacios($(dd).prev('dt').text());
    const codigo = tituloConCodigo.match(/\[\s*C[oó]d\.\s*([0-9]{4}-[0-9]{5})\s*\]/i)?.[1] || null;
    const titulo = tituloConCodigo
      .replace(/\[\s*C[oó]d\.\s*[0-9-]+\s*\]/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    if (!titulo) return;

    const detalleResuelto = resolverUrl(detalle ? $(detalle).attr('href') : null, boletin.url);
    const pdfResuelto = resolverUrl(pdf ? $(pdf).attr('href') : null, boletin.url);
    const urlDetalle = detalleResuelto && esUrlOficialBopa(detalleResuelto) ? detalleResuelto : null;
    const urlPdf = pdfResuelto && esUrlOficialBopa(pdfResuelto) ? pdfResuelto : null;
    const urlsAlternativasOficiales = alternativas
      .map((el) => resolverUrl($(el).attr('href'), boletin.url))
      .filter((url) => url && esUrlOficialBopa(url));
    const urlCanonica = urlDetalle || urlPdf;
    if (!urlCanonica || vistos.has(urlCanonica)) return;
    vistos.add(urlCanonica);

    docs.push({
      titulo,
      url: urlCanonica,
      urlHtml: urlDetalle,
      urlTexto: urlDetalle,
      urlPdf,
      urlDescarga: urlsAlternativasOficiales[0] || null,
      urlsAlternativasOficiales,
      idOficial: codigo,
      id_oficial: codigo,
      fecha: boletin.fecha,
      metadata_json: {
        bopa: {
          sumario_url: boletin.url,
          detail_url: urlDetalle,
          text_url: urlDetalle,
          summary_pdf_url: urlPdf,
          official_alternative_urls: urlsAlternativasOficiales,
          official_id: codigo,
        },
      },
    });
  });

  return docs;
}

function evaluarCalidadEvidencia(texto) {
  const limpio = normalizarEspacios(texto);
  const normalizado = normalizarBusqueda(limpio);

  if (!limpio) return { valida: false, razon: 'sin_texto_util', longitud: 0 };
  if (esTextoErrorPortal(limpio)) {
    return { valida: false, razon: 'portal_error', longitud: limpio.length };
  }
  if (/^(?:cargando|loading)(?:\.{3})?$/i.test(normalizado) || /\bcargando(?:\.{3})?(?:\s|$)/i.test(normalizado)) {
    return { valida: false, razon: 'loading_placeholder', longitud: limpio.length };
  }
  if (limpio.length < MIN_TEXTO_UTIL) {
    return { valida: false, razon: 'texto_demasiado_corto', longitud: limpio.length };
  }

  const pareceDisposicion = /\b(resolucion|decreto|orden|ley|anuncio|acuerdo|edicto|extracto|convocatoria|bases reguladoras|informacion publica)\b/i.test(normalizado);
  const contextoOficial = /\b(consejeria|ayuntamiento|principado de asturias|boletin oficial|administracion|codigo|cod\.)\b/i.test(normalizado);
  if (!pareceDisposicion || !contextoOficial) {
    return { valida: false, razon: 'no_parece_disposicion_oficial', longitud: limpio.length };
  }

  const frases = normalizado
    .split(/[.!?]+/)
    .map((frase) => frase.trim())
    .filter((frase) => frase.length >= 35);
  const repeticiones = new Map();
  for (const frase of frases) repeticiones.set(frase, (repeticiones.get(frase) || 0) + 1);
  if ([...repeticiones.values()].some((cantidad) => cantidad >= 3)) {
    return { valida: false, razon: 'boilerplate_repetido', longitud: limpio.length };
  }

  return { valida: true, razon: null, longitud: limpio.length };
}

function extraerTextoOficialHtml($) {
  for (const selector of ['#bopa-articulo', '.article-disposition', '#main-content']) {
    const texto = normalizarEspacios($(selector).first().text());
    if (texto) return texto.slice(0, MAX_TEXTO_EVIDENCIA);
  }
  return '';
}

async function obtenerTextoPdfUrl(url, deps = {}) {
  if (!url) return { texto: '', evidencia: false, motivo: 'pdf_missing', url: null };

  try {
    let data;
    if (deps.fetchPdfBuffer) {
      data = await deps.fetchPdfBuffer(url);
    } else {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
          Accept: 'application/pdf,*/*',
          'User-Agent': 'Mozilla/5.0 (compatible; Ruralicos/1.0)',
        },
      });
      data = response.data;
    }

    const buffer = Buffer.from(data || '');
    if (buffer.slice(0, 4).toString('utf8') !== '%PDF') {
      return { texto: '', evidencia: false, motivo: 'pdf_invalid', url };
    }

    let texto;
    try {
      const extractPdfText = deps.extraerTextoPdf || extraerTextoPdf;
      texto = normalizarEspacios(await extractPdfText(buffer));
    } catch {
      return { texto: '', evidencia: false, motivo: 'pdf_ilegible', url };
    }

    const calidad = evaluarCalidadEvidencia(texto);
    if (!calidad.valida) {
      return {
        texto: '',
        evidencia: false,
        motivo: calidad.razon === 'sin_texto_util' ? 'pdf_ilegible' : calidad.razon,
        url,
      };
    }

    return {
      texto: texto.slice(0, MAX_TEXTO_EVIDENCIA),
      evidencia: true,
      motivo: null,
      url,
    };
  } catch {
    return { texto: '', evidencia: false, motivo: 'fetch_error', url };
  }
}

async function obtenerTextoPdfAlternativo($, baseUrl, deps = {}) {
  const excluidas = new Set((deps.excludeUrls || []).filter(Boolean));
  const urls = [];
  $('a[href]').each((_, el) => {
    if (!enlaceEsPdf($, el)) return;
    const url = resolverUrl($(el).attr('href'), baseUrl);
    if (!url || excluidas.has(url) || urls.includes(url) || !esUrlOficialBopa(url)) return;
    urls.push(url);
  });

  if (!urls.length) return { texto: '', evidencia: false, motivo: 'pdf_missing', url: null };

  const fetchPdf = deps.obtenerTextoPdfUrl || ((url) => obtenerTextoPdfUrl(url, deps));
  let ultimo = null;
  for (const url of urls.slice(0, MAX_ALTERNATIVAS)) {
    ultimo = await fetchPdf(url);
    if (ultimo?.evidencia) return { ...ultimo, url: ultimo.url || url };
  }
  return ultimo || { texto: '', evidencia: false, motivo: 'pdf_missing', url: null };
}

function extraerAlternativasOficiales($, baseUrl, declaradas = []) {
  const urls = [];
  const anadir = (url) => {
    if (url && esUrlOficialBopa(url) && !urls.includes(url)) urls.push(url);
  };
  for (const url of declaradas || []) anadir(resolverUrl(url, baseUrl));
  if ($) {
    $('a[href]').each((_, el) => {
      if (!enlaceEsAlternativa($, el) || enlaceEsPdf($, el)) return;
      anadir(resolverUrl($(el).attr('href'), baseUrl));
    });
  }
  return urls.slice(0, MAX_ALTERNATIVAS);
}

function normalizarResultadoEvidencia(resultado, url) {
  if (!resultado) return { texto: '', evidencia: false, motivo: 'pdf_missing', url: url || null };
  if (resultado.evidencia === false) return { ...resultado, url: resultado.url || url || null };

  const texto = normalizarEspacios(resultado.texto);
  const calidad = evaluarCalidadEvidencia(texto);
  if (!calidad.valida) {
    return { texto: '', evidencia: false, motivo: calidad.razon, url: resultado.url || url || null };
  }
  return {
    ...resultado,
    texto: texto.slice(0, MAX_TEXTO_EVIDENCIA),
    evidencia: true,
    motivo: null,
    url: resultado.url || url || null,
  };
}

function registrarIntento(attempts, source, url, resultado, statusForzado = null) {
  const exito = resultado?.evidencia === true;
  attempts.push({
    source,
    url: url || resultado?.url || null,
    status: statusForzado || (exito ? 'success' : 'failed'),
    reason: exito ? null : (resultado?.motivo || 'sin_texto_util'),
    text_length: normalizarEspacios(resultado?.texto).length,
  });
}

function evidenciaRecuperada(resultado, fuente, attempts, timestamp) {
  return {
    texto: resultado.texto,
    evidencia: true,
    motivo: null,
    fuente_evidencia: fuente,
    urlPdf: fuente.includes('pdf') ? (resultado.url || null) : null,
    attempts,
    recovered_at: timestamp,
  };
}

async function obtenerTextoDocumento(documento, deps = {}) {
  const doc = typeof documento === 'string'
    ? { url: documento, urlHtml: documento }
    : { ...(documento || {}) };
  const detailUrl = doc.urlHtml || doc.urlTexto || doc.url || null;
  const fetchHtml = deps.getHtml || getHtml;
  const fetchPdfUrl = deps.obtenerTextoPdfUrl || ((url) => obtenerTextoPdfUrl(url, deps));
  const fetchDetailPdf = deps.obtenerTextoPdfAlternativo || obtenerTextoPdfAlternativo;
  const timestamp = typeof deps.now === 'function' ? deps.now() : new Date().toISOString();
  const attempts = [];
  let paginaDetalle = null;
  let textoPortal = '';
  let razonHtml = 'fetch_error';

  if (detailUrl) {
    try {
      const html = await fetchHtml(detailUrl);
      paginaDetalle = cheerio.load(html);
      textoPortal = extraerTextoOficialHtml(paginaDetalle);
      const calidad = evaluarCalidadEvidencia(textoPortal);
      razonHtml = calidad.razon || null;
      const resultadoHtml = calidad.valida
        ? { texto: textoPortal, evidencia: true, motivo: null, url: detailUrl }
        : { texto: '', evidencia: false, motivo: calidad.razon, url: detailUrl };
      registrarIntento(attempts, 'html', detailUrl, resultadoHtml);
      if (calidad.valida) return evidenciaRecuperada(resultadoHtml, 'html', attempts, timestamp);
    } catch {
      razonHtml = 'fetch_error';
      registrarIntento(attempts, 'html', detailUrl, { evidencia: false, motivo: 'fetch_error' });
    }
  } else {
    razonHtml = 'missing_url';
    registrarIntento(attempts, 'html', null, { evidencia: false, motivo: 'missing_url' }, 'skipped');
  }

  if (doc.urlPdf) {
    const directo = normalizarResultadoEvidencia(
      await Promise.resolve().then(() => fetchPdfUrl(doc.urlPdf)).catch(() => ({ evidencia: false, motivo: 'fetch_error' })),
      doc.urlPdf
    );
    registrarIntento(attempts, 'summary_pdf', doc.urlPdf, directo);
    if (directo.evidencia) return evidenciaRecuperada(directo, 'summary_pdf', attempts, timestamp);
  } else {
    registrarIntento(attempts, 'summary_pdf', null, { evidencia: false, motivo: 'pdf_missing' }, 'skipped');
  }

  let detallePdf = { texto: '', evidencia: false, motivo: 'pdf_missing', url: null };
  if (paginaDetalle && detailUrl) {
    detallePdf = normalizarResultadoEvidencia(
      await Promise.resolve()
        .then(() => fetchDetailPdf(paginaDetalle, detailUrl, { ...deps, excludeUrls: [doc.urlPdf] }))
        .catch(() => ({ evidencia: false, motivo: 'fetch_error' })),
      null
    );
    registrarIntento(attempts, 'detail_pdf', detallePdf.url, detallePdf);
    if (detallePdf.evidencia) return evidenciaRecuperada(detallePdf, 'detail_pdf', attempts, timestamp);
  } else {
    registrarIntento(attempts, 'detail_pdf', null, detallePdf, 'skipped');
  }

  const alternativas = extraerAlternativasOficiales(
    paginaDetalle,
    detailUrl || doc.url,
    doc.urlsAlternativasOficiales || doc.metadata_json?.bopa?.official_alternative_urls || []
  ).filter((url) => url !== detailUrl && url !== doc.urlPdf);
  let resultadoAlternativa = null;
  for (const url of alternativas) {
    try {
      const html = await fetchHtml(url);
      const $ = cheerio.load(html);
      const texto = extraerTextoOficialHtml($);
      const calidad = evaluarCalidadEvidencia(texto);
      resultadoAlternativa = calidad.valida
        ? { texto, evidencia: true, motivo: null, url }
        : { texto: '', evidencia: false, motivo: calidad.razon, url };
    } catch {
      resultadoAlternativa = { texto: '', evidencia: false, motivo: 'fetch_error', url };
    }
    registrarIntento(attempts, 'official_alternative', url, resultadoAlternativa);
    if (resultadoAlternativa.evidencia) {
      return evidenciaRecuperada(resultadoAlternativa, 'official_alternative', attempts, timestamp);
    }
  }
  if (!alternativas.length) {
    registrarIntento(attempts, 'official_alternative', null, { evidencia: false, motivo: 'sin_alternativa_oficial' }, 'skipped');
  }

  const motivo = ['portal_error', 'loading_placeholder'].includes(razonHtml)
    ? razonHtml
    : (resultadoAlternativa?.motivo || detallePdf.motivo || razonHtml || 'sin_texto_util');
  return {
    texto: '',
    evidencia: false,
    motivo,
    fuente_evidencia: null,
    texto_original: textoPortal,
    attempts,
    recovered_at: null,
    attempted_at: timestamp,
  };
}

function crearAuditoriaEvidencia(evidencia = {}) {
  const recuperada = evidencia.evidencia === true;
  const attemptedAt = evidencia.attempted_at || evidencia.recovered_at || new Date().toISOString();
  const attempts = Array.isArray(evidencia.attempts) ? evidencia.attempts : [];
  const fuenteFallida = attempts.find((intento) =>
    intento.reason === evidencia.motivo
    && ['html', 'summary_pdf', 'detail_pdf', 'official_alternative'].includes(intento.source)
  )?.source || null;
  return {
    status: recuperada ? 'recovered' : 'missing',
    source: recuperada ? evidencia.fuente_evidencia : fuenteFallida,
    reason: recuperada ? null : (evidencia.motivo || 'sin_texto_util'),
    attempts,
    recovered_at: recuperada ? (evidencia.recovered_at || attemptedAt) : null,
    last_attempt_at: attemptedAt,
  };
}

async function obtenerDocumentosBopaConTexto(fechaISO, esRuralRelevante, deps = {}) {
  const obtenerBoletin = deps.obtenerBoletinObjetivo || obtenerBoletinObjetivo;
  const obtenerDocs = deps.obtenerDocumentosSumario || obtenerDocumentosSumario;
  const obtenerTexto = deps.obtenerTextoDocumento || obtenerTextoDocumento;
  const esperar = deps.sleep || sleep;

  const boletin = await obtenerBoletin(fechaISO || null);
  const todos = await obtenerDocs(boletin, deps);
  const resultado = [];
  let sinEvidencia = 0;

  for (const doc of todos) {
    const decision = evaluarPrefiltroRural(esRuralRelevante, doc.titulo);
    if (decision.action === 'discard') {
      resultado.push({ ...doc, _prefiltro_rural: decision, _relevante: false });
      continue;
    }

    await esperar(DELAY_MS);
    const evidencia = await obtenerTexto(doc, deps);
    const metadataJson = {
      ...(doc.metadata_json || {}),
      evidence: crearAuditoriaEvidencia(evidencia),
    };

    if (evidencia.evidencia) {
      resultado.push({
        ...doc,
        texto: evidencia.texto,
        ...(evidencia.urlPdf ? { urlPdf: evidencia.urlPdf } : {}),
        metadata_json: metadataJson,
        _evidence_source: evidencia.fuente_evidencia,
        _prefiltro_rural: decision,
        _relevante: true,
      });
      continue;
    }

    sinEvidencia++;
    resultado.push({
      ...doc,
      texto: '',
      texto_raw: evidencia.texto_original || '',
      metadata_json: metadataJson,
      _prefiltro_rural: decision,
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
  crearAuditoriaEvidencia,
  esUrlOficialBopa,
  evaluarCalidadEvidencia,
  obtenerBoletinesRecientes,
  obtenerDocumentosBopaConTexto,
  obtenerDocumentosSumario,
  obtenerTextoDocumento,
  obtenerTextoPdfAlternativo,
  obtenerTextoPdfUrl,
  getFechaHoyISO,
};
