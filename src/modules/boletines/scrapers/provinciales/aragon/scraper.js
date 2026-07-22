const axios = require('axios');
const cheerio = require('cheerio');
const { htmlATexto } = require('../../../../../shared/htmlParser');
const { extraerTextoPdf } = require('../../../../../shared/pdfExtractor');
const { cabecerasNavegador } = require('../../../../../platform/httpClient');
const {
  agenteResiliente,
  agenteResilienteInseguro,
  ipConocida,
} = require('../../../../../platform/dnsResiliente');

const { esProvincialRelevante } = require('../shared/provincialFilter');

const BOPZ_DEFAULT_BASES = ['https://bop.dpz.es', 'https://boletin.dpz.es'];
const BOPZ_STATE = Object.freeze({
  SUCCESS: 'success',
  NO_PUBLICATION: 'no_publication',
  PARTIAL_RECOVERY: 'partial_recovery',
  TIMEOUT: 'timeout',
  PORTAL_DOWN: 'portal_down',
  PARSE_ERROR: 'parse_error',
});
const BOPH_BASE = 'https://bop.dphuesca.es';
const BOPH_PORTADA = `${BOPH_BASE}/publica/consulta-de-bops/`;
const BOPT_BASE = 'https://236ws.dpteruel.es';
const BOPT_DIA = `${BOPT_BASE}/DPT/bopt.nsf/inicio.xsp`;

const MESES = {
  enero: '01',
  febrero: '02',
  marzo: '03',
  abril: '04',
  mayo: '05',
  junio: '06',
  julio: '07',
  agosto: '08',
  septiembre: '09',
  octubre: '10',
  noviembre: '11',
  diciembre: '12',
};

function normalizarEspacios(texto) {
  return String(texto || '').replace(/\s+/g, ' ').trim();
}

function decodeLatin1(buffer) {
  return Buffer.from(buffer).toString('latin1');
}

function bopzBases(env = process.env) {
  const configured = String(env.BOPZ_BASE_URLS || '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter((value) => /^https:\/\//i.test(value));
  return [...new Set([...configured, ...BOPZ_DEFAULT_BASES])];
}

function enteroAcotado(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.trunc(parsed)))
    : fallback;
}

function clasificarErrorBopz(error = {}) {
  if (error.code === 'BOPZ_PARSE_ERROR') {
    return { code: 'BOPZ_PARSE_ERROR', state: BOPZ_STATE.PARSE_ERROR };
  }
  if (error.code === 'BOPZ_TIMEOUT'
    || /(?:ETIMEDOUT|ECONNABORTED|timeout|timed out|aborted)/i.test(`${error.code || ''} ${error.message || ''}`)) {
    return { code: 'BOPZ_TIMEOUT', state: BOPZ_STATE.TIMEOUT };
  }
  return { code: 'BOPZ_PORTAL_DOWN', state: BOPZ_STATE.PORTAL_DOWN };
}

function crearErrorBopz(code, message, diagnostics = {}, cause = null) {
  const error = new Error(message);
  error.code = code;
  error.scrape_diagnostics = diagnostics;
  if (cause) error.cause = cause;
  return error;
}

function adjuntarDiagnosticoScrape(docs, diagnostics) {
  Object.defineProperty(docs, 'scrape_diagnostics', {
    value: diagnostics,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return docs;
}

async function getHtml(url, options = {}) {
  const timeout = Number(options.timeout || process.env.BOP_ARAGON_HTML_TIMEOUT_MS || 45000);
  const attempts = enteroAcotado(
    options.attempts || process.env.BOP_ARAGON_HTML_ATTEMPTS,
    2,
    1,
    3
  );
  const retryBackoffMs = enteroAcotado(
    options.retryBackoffMs || process.env.BOP_ARAGON_RETRY_BACKOFF_MS,
    1000,
    0,
    5000
  );
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const remainingMs = options.deadlineMs
        ? Math.max(0, options.deadlineMs - Date.now())
        : timeout;
      if (remainingMs <= 0) {
        throw Object.assign(new Error('presupuesto total de descarga agotado'), { code: 'ETIMEDOUT' });
      }
      const extraHeaders = {};
      if (options.referer) extraHeaders.Referer = options.referer;
      if (options.cookie) extraHeaders.Cookie = options.cookie;
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: Math.min(timeout, remainingMs),
        httpsAgent: options.insecure ? agenteResilienteInseguro : agenteResiliente,
        headers: cabecerasNavegador(extraHeaders),
      });
      const { data } = response;
      const html = options.latin1 ? decodeLatin1(data) : Buffer.from(data).toString('utf8');
      return options.withHeaders ? { html, headers: response.headers } : html;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        const delay = retryBackoffMs * attempt;
        const remainingMs = options.deadlineMs ? options.deadlineMs - Date.now() : Infinity;
        if (remainingMs <= delay) break;
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

async function getPdfText(url, options = {}) {
  const { data } = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 45000,
    httpsAgent: options.insecure ? agenteResilienteInseguro : agenteResiliente,
    headers: cabecerasNavegador({ Accept: 'application/pdf,*/*', Referer: options.referer }),
  });
  return extraerTextoPdf(Buffer.from(data));
}

function absoluteUrl(href, base) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  return new URL(href, base).toString();
}

function fechaTextoAISO(texto) {
  const normal = normalizarEspacios(texto).toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

  let match = normal.match(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/);
  if (match) {
    const dia = String(match[1]).padStart(2, '0');
    const mes = MESES[match[2]];
    return mes ? `${match[3]}-${mes}-${dia}` : null;
  }

  match = normal.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (match) {
    return `${match[3]}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
  }

  match = normal.match(/\bdia=(\d{4})(\d{2})(\d{2})\b/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;

  return null;
}

function generarTitulo(fuente, titulo, fecha) {
  return `${fuente} - ${normalizarEspacios(titulo).slice(0, 180)} (${fecha})`;
}

function extraerBopzSumario(html, { baseUrl = BOPZ_DEFAULT_BASES[0] } = {}) {
  const $ = cheerio.load(html);
  const numBop = $('input[name="numBop"]').toArray().map((el) => $(el).attr('value')).find(Boolean) || '';
  const fechaPub = $('input[name="fechaPub"]').toArray().map((el) => $(el).attr('value')).find(Boolean) || '';
  const fecha = fechaTextoAISO(fechaPub) || '';
  const docs = [];

  $('a.enlaceEdicto[onclick]').each((_, el) => {
    const onclick = $(el).attr('onclick') || '';
    const id = (onclick.match(/abreVentanaDetalleEdicto\('([^']+)'\)/) || [])[1];
    const titulo = normalizarEspacios($(el).text());
    if (!id || !titulo) return;

    const organismo = normalizarEspacios($(el).closest('.row').prevAll('.row').first().text());
    const pagina = `${baseUrl}/BOPZ/obtenerContenidoEdicto.do?idEdicto=${encodeURIComponent(id)}&numBop=${encodeURIComponent(numBop)}&fechaPub=${encodeURIComponent(fechaPub)}`;

    docs.push({
      id,
      titulo,
      url: pagina,
      urlHtml: pagina,
      fecha,
      boletin: numBop,
      organismo,
      seccion: '',
      contexto: normalizarEspacios(`${organismo} ${titulo}`),
    });
  });

  return docs;
}

function esPaginaBopzSinPublicacion(html) {
  const texto = normalizarEspacios(cheerio.load(html || '')('body').text())
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  return /\b(?:no hay|no existe|sin) boletin\b|\bboletin (?:no publicado|pendiente de publicacion)\b|\bdia (?:festivo|sin publicacion)\b/.test(texto);
}

async function obtenerDocumentosBopzConTexto(fechaISO, options = {}) {
  let html = '';
  let baseUrl = '';
  let candidatosDetectados = [];
  const errores = [];
  const env = options.env || process.env;
  const requestHtml = options.getHtml || getHtml;
  const bases = bopzBases(env).slice(0, enteroAcotado(env.BOPZ_MAX_ENDPOINTS, 3, 2, 5));
  const indexTimeoutMs = enteroAcotado(env.BOPZ_HTML_TIMEOUT_MS, 3000, 1000, 8000);
  const indexAttempts = enteroAcotado(env.BOPZ_HTML_ATTEMPTS, 2, 1, 3);
  const retryBackoffMs = enteroAcotado(env.BOPZ_RETRY_BACKOFF_MS, 500, 0, 5000);
  const indexBudgetMs = enteroAcotado(env.BOPZ_INDEX_TOTAL_BUDGET_MS, 7500, 3000, 12000);
  const indexDeadlineMs = Date.now() + indexBudgetMs;

  for (const candidateBase of bases) {
    try {
      const candidateHtml = await requestHtml(`${candidateBase}/BOPZ/`, {
        insecure: true,
        latin1: true,
        timeout: indexTimeoutMs,
        attempts: indexAttempts,
        retryBackoffMs,
        deadlineMs: indexDeadlineMs,
        sleep: options.sleep,
      });
      const candidateDocs = extraerBopzSumario(candidateHtml, { baseUrl: candidateBase });
      if (candidateDocs.length === 0 && !esPaginaBopzSinPublicacion(candidateHtml)) {
        throw crearErrorBopz(
          'BOPZ_PARSE_ERROR',
          'el sumario no contiene los selectores oficiales esperados'
        );
      }
      html = candidateHtml;
      candidatosDetectados = candidateDocs;
      baseUrl = candidateBase;
      break;
    } catch (error) {
      const hostname = new URL(candidateBase).hostname;
      const ip = ipConocida(hostname);
      errores.push({
        endpoint: candidateBase,
        message: error.message,
        error_code: error.code || null,
        state: clasificarErrorBopz(error).state,
        dns: ip ? `${ip.ip} (${ip.origen})` : 'sin resolver',
      });
    }
  }

  if (!html || !baseUrl) {
    const allTimeout = errores.length > 0
      && errores.every(({ state }) => state === BOPZ_STATE.TIMEOUT);
    const anyParseError = errores.some(({ state }) => state === BOPZ_STATE.PARSE_ERROR);
    const code = allTimeout
      ? 'BOPZ_TIMEOUT'
      : anyParseError
        ? 'BOPZ_PARSE_ERROR'
        : 'BOPZ_PORTAL_DOWN';
    const state = allTimeout
      ? BOPZ_STATE.TIMEOUT
      : anyParseError
        ? BOPZ_STATE.PARSE_ERROR
        : BOPZ_STATE.PORTAL_DOWN;
    const details = errores.map(({ endpoint, message, dns }) =>
      `${new URL(endpoint).hostname}: ${message} [ip=${dns}]`
    ).join(' | ');
    const failureSummary = anyParseError
      ? 'ningun endpoint produjo un sumario parseable'
      : 'ningun endpoint oficial respondio';
    const error = crearErrorBopz(
      code,
      `${failureSummary} (${details})`,
      {
        state,
        endpoints_considered: bases,
        endpoint_errors: errores,
        timeout_strategy: 'axios_total_request_with_global_budget',
        split_connect_read_timeout_supported: false,
        index_timeout_ms: indexTimeoutMs,
        index_total_budget_ms: indexBudgetMs,
        attempts_per_endpoint: indexAttempts,
        retry_backoff_ms: retryBackoffMs,
      }
    );
    console.error(`[BOPZ] Error operativo obteniendo el sumario/portada: ${error.message}`);
    throw error;
  }

  console.log(`[BOPZ] ${candidatosDetectados.length} documentos detectados en el sumario`);

  const baseDiagnostics = {
    endpoints_considered: bases,
    endpoint_used: baseUrl,
    fallback_used: baseUrl !== bases[0],
    endpoint_errors: errores,
    timeout_strategy: 'axios_total_request_with_global_budget',
    split_connect_read_timeout_supported: false,
    index_timeout_ms: indexTimeoutMs,
    index_total_budget_ms: indexBudgetMs,
    attempts_per_endpoint: indexAttempts,
    retry_backoff_ms: retryBackoffMs,
  };

  if (candidatosDetectados.length === 0) {
    if (esPaginaBopzSinPublicacion(html)) {
      return adjuntarDiagnosticoScrape([], {
        ...baseDiagnostics,
        state: BOPZ_STATE.NO_PUBLICATION,
        reason: 'official_page_reports_no_publication',
      });
    }
    throw crearErrorBopz('BOPZ_PARSE_ERROR', 'sumario oficial sin documentos ni aviso de no publicacion', {
      ...baseDiagnostics,
      state: BOPZ_STATE.PARSE_ERROR,
    });
  }

  if (fechaISO && candidatosDetectados[0]?.fecha && candidatosDetectados[0].fecha !== fechaISO) {
    return adjuntarDiagnosticoScrape([], {
      ...baseDiagnostics,
      state: BOPZ_STATE.NO_PUBLICATION,
      reason: 'published_issue_date_does_not_match_target',
      published_date: candidatosDetectados[0].fecha,
    });
  }

  const maxDocuments = enteroAcotado(env.BOPZ_MAX_DOCUMENTS, 200, 1, 500);
  const candidatos = candidatosDetectados.slice(0, maxDocuments);
  const detailTimeoutMs = enteroAcotado(env.BOPZ_DETAIL_TIMEOUT_MS, 3000, 1000, 8000);
  const detailAttempts = enteroAcotado(env.BOPZ_DETAIL_ATTEMPTS, 2, 1, 3);
  const detailBudgetMs = enteroAcotado(env.BOPZ_DETAIL_TOTAL_BUDGET_MS, 9500, 3000, 12000);
  const detailDeadlineMs = Date.now() + detailBudgetMs;
  let detailErrors = 0;

  // Captura bruta: se devuelven TODOS los detectados anotados con `_relevante`. Si
  // no se puede leer el detalle, el documento se registra igual (no se pierde).
  const docs = [];
  for (const doc of candidatos) {
    let htmlDetalle = '';
    try {
      if (Date.now() >= detailDeadlineMs) {
        throw Object.assign(new Error('presupuesto de detalles agotado'), { code: 'ETIMEDOUT' });
      }
      htmlDetalle = await requestHtml(doc.urlHtml, {
        insecure: true,
        referer: `${baseUrl}/BOPZ/`,
        latin1: true,
        timeout: detailTimeoutMs,
        attempts: detailAttempts,
        retryBackoffMs,
        deadlineMs: detailDeadlineMs,
        sleep: options.sleep,
      });
    } catch (error) {
      detailErrors += 1;
      console.warn(`[BOPZ] No se pudo leer detalle ${doc.id}: ${error.message}`);
      docs.push({
        ...doc,
        _prefiltro_rural: {
          action: 'review',
          positiveSignals: [],
          negativeSignals: [],
          reasonCode: 'source_detail_unavailable',
        },
        _relevante: true,
      });
      continue;
    }

    const texto = htmlATexto(htmlDetalle).slice(0, 15000);
    const decision = esProvincialRelevante(`${doc.contexto} ${texto}`);
    if (decision.action === 'discard') {
      docs.push({ ...doc, texto, _prefiltro_rural: decision, _relevante: false });
      continue;
    }

    docs.push({
      ...doc,
      titulo: generarTitulo('BOPZ', doc.titulo, doc.fecha),
      texto,
      _prefiltro_rural: decision,
      _relevante: true,
    });
  }

  console.log(`[BOPZ] ${docs.length} documentos detectados (captura bruta)`);
  return adjuntarDiagnosticoScrape(docs, {
    ...baseDiagnostics,
    state: detailErrors > 0 || candidatosDetectados.length > candidatos.length
      ? BOPZ_STATE.PARTIAL_RECOVERY
      : BOPZ_STATE.SUCCESS,
    candidates_detected: candidatosDetectados.length,
    documents_processed: docs.length,
    documents_truncated: Math.max(0, candidatosDetectados.length - candidatos.length),
    max_documents: maxDocuments,
    detail_timeout_ms: detailTimeoutMs,
    detail_total_budget_ms: detailBudgetMs,
    detail_attempts: detailAttempts,
    detail_errors: detailErrors,
  });
}

function extraerBophEntradasLegacy(html) {
  const $ = cheerio.load(html);
  const texto = normalizarEspacios($('body').text());
  const fecha = fechaTextoAISO(texto) || '';
  const boletin = (texto.match(/Numero:\s*(\d+)/i) || texto.match(/N[uú]mero:\s*(\d+)/i) || [])[1] || '';
  const links = $('a[href*="mod.bopanuncios"][href*="visualizarpdf"]').toArray();
  const partes = texto.split(/\+\s+(\d{4}\s*\/\s*\d+)\s*-\s*/).slice(1);
  const docs = [];

  for (let i = 0; i < partes.length; i += 2) {
    const idOficial = normalizarEspacios(partes[i]);
    const bloque = normalizarEspacios(partes[i + 1] || '');
    const link = links[i / 2];
    if (!idOficial || !bloque || !link) continue;

    const href = $(link).attr('href') || '';
    const titulo = bloque
      .replace(/Pulse aqui para ver el anuncio completo.*$/i, '')
      .replace(/Pulse aqu[ií] para ver el anuncio completo.*$/i, '')
      .trim();

    docs.push({
      titulo,
      url: absoluteUrl(href, BOPH_BASE),
      urlPdf: absoluteUrl(href, BOPH_BASE),
      fecha,
      boletin,
      idOficial,
      organismo: (titulo.match(/^[A-ZÁÉÍÓÚÑÜ0-9 /.-]{6,80}/) || [])[0] || '',
      seccion: '',
      contexto: titulo,
    });
  }

  return docs;
}

function extraerCookieHeader(headers = {}) {
  const setCookie = headers['set-cookie'];
  const values = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  return values
    .map((value) => String(value).split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function extraerBophListadoUrl(html) {
  const $ = cheerio.load(html);
  const href = $('a[href*="/publica/consulta-de-bops/buscador/BOP-"]').first().attr('href');
  return absoluteUrl(href, BOPH_BASE);
}

function extraerBophTotalPaginas(html) {
  const $ = cheerio.load(html);
  let total = 1;
  $('a[href*="page="]').each((_, element) => {
    const page = Number((($(element).attr('href') || '').match(/[?&]page=(\d+)/) || [])[1]);
    if (Number.isFinite(page)) total = Math.max(total, page);
  });
  return total;
}

function extraerBophPdfUrl(html) {
  const $ = cheerio.load(html);
  const href = $('a[href*="Documentos-Anuncios-en-PDF"], a[href$=".pdf"]')
    .toArray()
    .map((element) => $(element).attr('href'))
    .find(Boolean);
  return absoluteUrl(href, BOPH_BASE);
}

function extraerBophEntradas(html) {
  const $ = cheerio.load(html);
  const texto = normalizarEspacios($('body').text());
  const boletin = (texto.match(/BOP\s*(?:n[uú]m\.?|n[ºo]\.?|numero)?\s*(\d+)/i) || [])[1] || '';
  const docs = [];

  $('li.elementoListado').each((_, element) => {
    const item = $(element);
    const link = item.find('a.enlace_elemento[href]').first();
    const titulo = normalizarEspacios(item.find('h3.titulo_elemento').first().text() || link.attr('title'));
    const href = link.attr('href') || '';
    const fecha = fechaTextoAISO(item.find('.fecha_elemento').first().text()) || fechaTextoAISO(texto) || '';
    const organismo = normalizarEspacios(item.find('.campo_1').first().text());
    const seccion = normalizarEspacios(item.find('.campo_2').first().text());
    const idOficial = normalizarEspacios(item.find('.campo_3').first().text());
    if (!titulo || !href) return;

    const url = absoluteUrl(href, BOPH_BASE);
    docs.push({
      titulo,
      url,
      urlHtml: url,
      urlPdf: '',
      fecha,
      boletin,
      idOficial,
      organismo,
      seccion,
      contexto: normalizarEspacios(`${organismo} ${seccion} ${titulo}`),
    });
  });

  return docs.length > 0 ? docs : extraerBophEntradasLegacy(html);
}

async function obtenerDocumentosBophConTexto(fechaISO) {
  const portadaResponse = await getHtml(BOPH_PORTADA, { withHeaders: true });
  const portadaHtml = portadaResponse.html;
  let cookie = extraerCookieHeader(portadaResponse.headers);
  const listadoUrl = extraerBophListadoUrl(portadaHtml);
  if (!listadoUrl) throw new Error('BOPH no publico enlace al boletin del dia');

  const listadoResponse = await getHtml(listadoUrl, { withHeaders: true, cookie });
  const primeraPagina = listadoResponse.html;
  cookie = extraerCookieHeader(listadoResponse.headers) || cookie;
  const paginas = Math.min(20, extraerBophTotalPaginas(primeraPagina));
  const candidatosPorId = new Map(
    extraerBophEntradas(primeraPagina).map((doc) => [doc.idOficial || doc.url, doc])
  );

  // El buscador se sirve desde varios nodos con instantaneas de paginacion
  // distintas: la misma pagina puede devolver 15 elementos pero solapar cuatro
  // con la anterior. Recorremos unas pocas instantaneas y unimos por ID oficial
  // para no perder anuncios (observado en produccion el 15-07-2026: 31 vs 35).
  let pasadasSinNuevos = 0;
  for (let pasada = 0; pasada < 6 && pasadasSinNuevos < 3; pasada++) {
    const totalAntes = candidatosPorId.size;
    let cookiePasada = cookie;

    if (pasada > 0) {
      // Sesion nueva para poder caer en otra instantanea/nodo del buscador.
      const refresco = await getHtml(listadoUrl, { withHeaders: true });
      cookiePasada = extraerCookieHeader(refresco.headers);
      for (const doc of extraerBophEntradas(refresco.html)) {
        candidatosPorId.set(doc.idOficial || doc.url, doc);
      }
    }

    for (let page = 2; page <= paginas; page++) {
      const separador = listadoUrl.includes('?') ? '&' : '?';
      const pageHtml = await getHtml(`${listadoUrl}${separador}reloaded&page=${page}`, { cookie: cookiePasada });
      for (const doc of extraerBophEntradas(pageHtml)) {
        candidatosPorId.set(doc.idOficial || doc.url, doc);
      }
    }
    pasadasSinNuevos = candidatosPorId.size === totalAntes ? pasadasSinNuevos + 1 : 0;
  }

  const candidatos = [...candidatosPorId.values()];

  if (fechaISO && candidatos[0]?.fecha && candidatos[0].fecha !== fechaISO) return [];

  // Captura bruta: se devuelven TODOS los detectados anotados con `_relevante`; el
  // El PDF se descarga para pass/review; solo discard evita la descarga.
  const docs = [];
  for (const doc of candidatos) {
    const decision = esProvincialRelevante(doc.contexto);
    if (decision.action === 'discard') {
      docs.push({ ...doc, _prefiltro_rural: decision, _relevante: false });
      continue;
    }

    let texto = doc.contexto;
    let urlPdf = '';
    try {
      const detalleHtml = await getHtml(doc.urlHtml, { referer: listadoUrl });
      urlPdf = extraerBophPdfUrl(detalleHtml);
      if (urlPdf) {
        texto = (await getPdfText(urlPdf, { referer: doc.urlHtml })).slice(0, 15000) || doc.contexto;
      } else {
        texto = htmlATexto(detalleHtml).slice(0, 15000) || doc.contexto;
      }
    } catch {
      texto = doc.contexto;
    }

    docs.push({
      ...doc,
      urlPdf,
      titulo: generarTitulo('BOPH', doc.titulo, doc.fecha),
      texto,
      _prefiltro_rural: decision,
      _relevante: true,
    });
  }

  console.log(`[BOPH] ${docs.length} documentos detectados (captura bruta)`);
  return docs;
}

function extraerBoptEntradas(html) {
  const $ = cheerio.load(html);
  const texto = normalizarEspacios($('body').text());
  const fecha = fechaTextoAISO(texto) || fechaTextoAISO($('a[href*="Redireccion"]').attr('href') || '') || '';
  const boletin = ($('span[id*="computedField1"]').first().text().match(/\d+/) || [])[0] || '';
  const docs = [];

  $('a[href^="0/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const titulo = normalizarEspacios($(el).text());
    if (!href || titulo.length < 20) return;

    const url = absoluteUrl(`/DPT/bopt.nsf/${href}`, BOPT_BASE);
    docs.push({
      titulo,
      url,
      urlHtml: url,
      fecha,
      boletin,
      idOficial: href.replace(/^0\//, ''),
      organismo: '',
      seccion: '',
      contexto: titulo,
    });
  });

  return docs;
}

async function obtenerDocumentosBoptConTexto(fechaISO) {
  const html = await getHtml(BOPT_DIA);
  const candidatos = extraerBoptEntradas(html);

  if (fechaISO && candidatos[0]?.fecha && candidatos[0].fecha !== fechaISO) return [];

  // Captura bruta: se devuelven TODOS los detectados anotados con `_relevante`.
  const docs = [];
  for (const doc of candidatos) {
    const htmlDetalle = await getHtml(doc.urlHtml, { referer: BOPT_DIA });
    const $ = cheerio.load(htmlDetalle);
    $('script,style,noscript').remove();
    const texto = normalizarEspacios($('body').text()).slice(0, 15000);
    const decision = esProvincialRelevante(`${doc.contexto} ${texto}`);
    if (decision.action === 'discard') {
      docs.push({ ...doc, texto, _prefiltro_rural: decision, _relevante: false });
      continue;
    }

    docs.push({
      ...doc,
      titulo: generarTitulo('BOPT', doc.titulo, doc.fecha),
      texto,
      _prefiltro_rural: decision,
      _relevante: true,
    });
  }

  console.log(`[BOPT] ${docs.length} documentos detectados (captura bruta)`);
  return docs;
}

module.exports = {
  BOPZ_STATE,
  clasificarErrorBopz,
  obtenerDocumentosBopzConTexto,
  obtenerDocumentosBophConTexto,
  obtenerDocumentosBoptConTexto,
  __testing: {
    BOPZ_STATE,
    adjuntarDiagnosticoScrape,
    bopzBases,
    clasificarErrorBopz,
    esPaginaBopzSinPublicacion,
    fechaTextoAISO,
    extraerBopzSumario,
    extraerBophListadoUrl,
    extraerBophTotalPaginas,
    extraerBophPdfUrl,
    extraerBophEntradas,
    extraerCookieHeader,
  },
};
