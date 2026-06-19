const cheerio = require('cheerio');
const { htmlATexto } = require('../../../../../../shared/htmlParser');
const { axiosGetWithRetry } = require('../../../../../../platform/httpClient');
const { esProvincialRelevante } = require('../../shared/provincialFilter');

const BASE = 'https://egoitza.gipuzkoa.eus';
const PORTADA = `${BASE}/es/bog`;

function normalizarEspacios(texto) {
  return String(texto || '').replace(/\s+/g, ' ').trim();
}

function getFechaMadridISO() {
  const fmt = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [dd, mm, yyyy] = fmt.format(new Date()).split('/');
  return `${yyyy}-${mm}-${dd}`;
}

function fechaAPath(fechaISO) {
  const [yyyy, mm, dd] = fechaISO.split('-');
  const yy = yyyy.slice(2);
  return {
    yyyy,
    mm,
    dd,
    yy,
    url: `${BASE}/gao-bog/castell/bog/${yyyy}/${mm}/${dd}/bc${yy}${mm}${dd}.htm`,
  };
}

async function getHtml(url) {
  const { data } = await axiosGetWithRetry(url, {
    timeout: Number(process.env.BOG_HTTP_TIMEOUT_MS || 45000),
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (RuralicosBot/2.0)',
      Referer: PORTADA,
    },
  }, {
    attempts: Number(process.env.BOG_HTTP_ATTEMPTS || 2),
    allowInsecureFallback: true,
  });
  return String(data || '');
}

function extraerUrlBoletinDia(html) {
  const $ = cheerio.load(html);
  let href = '';

  $('a[href]').each((_, el) => {
    const text = normalizarEspacios($(el).text());
    const candidate = $(el).attr('href') || '';
    if (!href && /bolet[ií]n del d[ií]a/i.test(text) && /\/gao-bog\/castell\/bog\/\d{4}\/\d{2}\/\d{2}\/bc\d{6}\.htm/i.test(candidate)) {
      href = candidate;
    }
  });

  return href ? new URL(href, BASE).toString() : '';
}

function extraerDatosBoletin($, url) {
  const texto = normalizarEspacios($('body').text());
  const fechaUrl = String(url || '').match(/\/(\d{4})\/(\d{2})\/(\d{2})\/bc/);
  const fecha = fechaUrl ? `${fechaUrl[1]}-${fechaUrl[2]}-${fechaUrl[3]}` : getFechaMadridISO();
  const boletin = (texto.match(/N[uú]mero\s+(\d+)/i) || [])[1] || '';
  return { fecha, boletin };
}

function parsearSumarioBog(html, url) {
  const $ = cheerio.load(html);
  const boletin = extraerDatosBoletin($, url);
  const docs = [];
  const vistos = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!/\/c\d+\.htm$/i.test(href)) return;

    const titulo = normalizarEspacios($(el).parent().prev().text());
    if (titulo.length < 25) return;

    const urlHtml = new URL(href, url).toString();
    if (vistos.has(urlHtml)) return;
    vistos.add(urlHtml);

    const urlPdf = urlHtml.replace(/\.htm$/i, '.pdf');
    const idOficial = (urlHtml.match(/\/(c\d+)\.htm$/i) || [])[1] || '';

    docs.push({
      titulo,
      url: urlHtml,
      urlHtml,
      urlPdf,
      fecha: boletin.fecha,
      boletin: boletin.boletin,
      idOficial,
      organismo: '',
      seccion: '',
      contexto: titulo,
    });
  });

  return docs;
}

async function obtenerDocumentosBogConTexto(fechaISO) {
  const url = fechaISO
    ? fechaAPath(fechaISO).url
    : extraerUrlBoletinDia(await getHtml(PORTADA)) || fechaAPath(getFechaMadridISO()).url;
  const html = await getHtml(url);
  const candidatos = parsearSumarioBog(html, url);

  // Captura bruta: se devuelven TODOS los detectados anotados con `_relevante`; el
  // texto solo se descarga para los relevantes (coste idéntico al de antes).
  const docs = [];
  for (const doc of candidatos) {
    if (!esProvincialRelevante(doc.contexto)) {
      docs.push({ ...doc, _relevante: false });
      continue;
    }

    let texto = doc.contexto;
    try {
      texto = htmlATexto(await getHtml(doc.urlHtml)).slice(0, 15000) || doc.contexto;
    } catch {
      texto = doc.contexto;
    }

    docs.push({
      ...doc,
      titulo: `BOG - ${doc.titulo.slice(0, 180)} (${doc.fecha})`,
      texto,
      _relevante: true,
    });
  }

  console.log(`[BOG] ${docs.length} documentos detectados (captura bruta)`);
  return docs;
}

module.exports = {
  getFechaMadridISO,
  obtenerDocumentosBogConTexto,
  parsearSumarioBog,
};
