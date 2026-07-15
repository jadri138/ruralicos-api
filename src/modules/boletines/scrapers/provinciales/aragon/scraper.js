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

async function getHtml(url, options = {}) {
  const timeout = Number(options.timeout || process.env.BOP_ARAGON_HTML_TIMEOUT_MS || 45000);
  const attempts = Math.max(1, Number(options.attempts || process.env.BOP_ARAGON_HTML_ATTEMPTS || 2));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const extraHeaders = {};
      if (options.referer) extraHeaders.Referer = options.referer;
      if (options.cookie) extraHeaders.Cookie = options.cookie;
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout,
        httpsAgent: options.insecure ? agenteResilienteInseguro : agenteResiliente,
        headers: cabecerasNavegador(extraHeaders),
      });
      const { data } = response;
      const html = options.latin1 ? decodeLatin1(data) : Buffer.from(data).toString('utf8');
      return options.withHeaders ? { html, headers: response.headers } : html;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
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

async function obtenerDocumentosBopzConTexto(fechaISO) {
  let html = '';
  let baseUrl = '';
  const errores = [];

  // La Diputacion publica el mismo BOP bajo dos hostnames. Desde Render el
  // hostname historico lleva dias agotando el timeout aunque ambos respondan
  // desde otras redes; probarlos por separado evita perder toda la fuente.
  for (const candidateBase of bopzBases()) {
    try {
      html = await getHtml(`${candidateBase}/BOPZ/`, {
        insecure: true,
        latin1: true,
        timeout: Number(process.env.BOPZ_HTML_TIMEOUT_MS || 15000),
        attempts: Number(process.env.BOPZ_HTML_ATTEMPTS || 1),
      });
      baseUrl = candidateBase;
      break;
    } catch (error) {
      const hostname = new URL(candidateBase).hostname;
      const ip = ipConocida(hostname);
      errores.push(`${hostname}: ${error.message} [ip=${ip ? `${ip.ip} (${ip.origen})` : 'sin resolver'}]`);
    }
  }

  if (!html || !baseUrl) {
    const error = new Error(`ningun endpoint oficial respondio (${errores.join(' | ')})`);
    console.error(`[BOPZ] Error operativo obteniendo el sumario/portada: ${error.message}`);
    throw error;
  }

  const candidatos = extraerBopzSumario(html, { baseUrl });
  console.log(`[BOPZ] ${candidatos.length} documentos detectados en el sumario`);

  if (fechaISO && candidatos[0]?.fecha && candidatos[0].fecha !== fechaISO) return [];

  // Captura bruta: se devuelven TODOS los detectados anotados con `_relevante`. Si
  // no se puede leer el detalle, el documento se registra igual (no se pierde).
  const docs = [];
  for (const doc of candidatos) {
    let htmlDetalle = '';
    try {
      htmlDetalle = await getHtml(doc.urlHtml, {
        insecure: true,
        referer: `${baseUrl}/BOPZ/`,
        latin1: true,
        timeout: Number(process.env.BOPZ_DETAIL_TIMEOUT_MS || 45000),
        attempts: Number(process.env.BOPZ_DETAIL_ATTEMPTS || 2),
      });
    } catch (error) {
      console.warn(`[BOPZ] No se pudo leer detalle ${doc.id}: ${error.message}`);
      docs.push({ ...doc, _relevante: false });
      continue;
    }

    const texto = htmlATexto(htmlDetalle).slice(0, 15000);
    if (!esProvincialRelevante(`${doc.contexto} ${texto}`)) {
      docs.push({ ...doc, texto, _relevante: false });
      continue;
    }

    docs.push({
      ...doc,
      titulo: generarTitulo('BOPZ', doc.titulo, doc.fecha),
      texto,
      _relevante: true,
    });
  }

  console.log(`[BOPZ] ${docs.length} documentos detectados (captura bruta)`);
  return docs;
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
  // PDF solo se descarga para los relevantes (coste idéntico al de antes).
  const docs = [];
  for (const doc of candidatos) {
    if (!esProvincialRelevante(doc.contexto)) {
      docs.push({ ...doc, _relevante: false });
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
    if (!esProvincialRelevante(`${doc.contexto} ${texto}`)) {
      docs.push({ ...doc, texto, _relevante: false });
      continue;
    }

    docs.push({
      ...doc,
      titulo: generarTitulo('BOPT', doc.titulo, doc.fecha),
      texto,
      _relevante: true,
    });
  }

  console.log(`[BOPT] ${docs.length} documentos detectados (captura bruta)`);
  return docs;
}

module.exports = {
  obtenerDocumentosBopzConTexto,
  obtenerDocumentosBophConTexto,
  obtenerDocumentosBoptConTexto,
  __testing: {
    bopzBases,
    fechaTextoAISO,
    extraerBopzSumario,
    extraerBophListadoUrl,
    extraerBophTotalPaginas,
    extraerBophPdfUrl,
    extraerBophEntradas,
    extraerCookieHeader,
  },
};
