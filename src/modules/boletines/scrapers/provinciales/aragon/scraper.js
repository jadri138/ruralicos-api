const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const { htmlATexto } = require('../../../../../shared/htmlParser');
const { extraerTextoPdf } = require('../../../../../shared/pdfExtractor');
const { cabecerasNavegador } = require('../../../../../platform/httpClient');

const { esProvincialRelevante } = require('../shared/provincialFilter');

const httpsInseguro = new https.Agent({ rejectUnauthorized: false });

const BOPZ_BASE = 'https://boletin.dpz.es';
const BOPZ_PORTADA = `${BOPZ_BASE}/BOPZ/`;
const BOPH_BASE = 'https://bop.dphuesca.es';
const BOPH_DIA = `${BOPH_BASE}/index.php/mod.menus/mem.detalle/idmenu.50004/seccion.portal/chk.bcf2d2adca169242e8c4578dcc86d6cf.html`;
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

async function getHtml(url, options = {}) {
  const timeout = Number(options.timeout || process.env.BOP_ARAGON_HTML_TIMEOUT_MS || 45000);
  const attempts = Math.max(1, Number(options.attempts || process.env.BOP_ARAGON_HTML_ATTEMPTS || 2));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { data } = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout,
        httpsAgent: options.insecure ? httpsInseguro : undefined,
        headers: cabecerasNavegador({ Referer: options.referer }),
      });
      return options.latin1 ? decodeLatin1(data) : Buffer.from(data).toString('utf8');
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
    httpsAgent: options.insecure ? httpsInseguro : undefined,
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

  match = normal.match(/\b(\d{1,2})-(\d{1,2})-(\d{4})\b/);
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

function extraerBopzSumario(html) {
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
    const pagina = `${BOPZ_BASE}/BOPZ/obtenerContenidoEdicto.do?idEdicto=${encodeURIComponent(id)}&numBop=${encodeURIComponent(numBop)}&fechaPub=${encodeURIComponent(fechaPub)}`;

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
  const html = await getHtml(BOPZ_PORTADA, {
    insecure: true,
    latin1: true,
    timeout: Number(process.env.BOPZ_HTML_TIMEOUT_MS || 40000),
    attempts: Number(process.env.BOPZ_HTML_ATTEMPTS || 3),
  });
  const candidatos = extraerBopzSumario(html);

  if (fechaISO && candidatos[0]?.fecha && candidatos[0].fecha !== fechaISO) return [];

  // Captura bruta: se devuelven TODOS los detectados anotados con `_relevante`. Si
  // no se puede leer el detalle, el documento se registra igual (no se pierde).
  const docs = [];
  for (const doc of candidatos) {
    let htmlDetalle = '';
    try {
      htmlDetalle = await getHtml(doc.urlHtml, {
        insecure: true,
        referer: BOPZ_PORTADA,
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

function extraerBophEntradas(html) {
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

async function obtenerDocumentosBophConTexto(fechaISO) {
  const html = await getHtml(BOPH_DIA, { latin1: true });
  const candidatos = extraerBophEntradas(html);

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
    try {
      texto = (await getPdfText(doc.urlPdf, { referer: BOPH_DIA })).slice(0, 15000) || doc.contexto;
    } catch {
      texto = doc.contexto;
    }

    docs.push({
      ...doc,
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
};
