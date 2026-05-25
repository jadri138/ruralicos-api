const axios = require('axios');
const cheerio = require('cheerio');
const { htmlATexto } = require('../../../../utils/htmlParser');

const BASE = 'https://www.araba.eus';
const PORTADA = `${BASE}/BOTHA/Inicio/SGBO5001.aspx`;

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

function getFechaHoyISO() {
  const fmt = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [dd, mm, yyyy] = fmt.format(new Date()).split('/');
  return `${yyyy}-${mm}-${dd}`;
}

function normalizarEspacios(texto) {
  return String(texto || '').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(href) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  return new URL(href, BASE).toString();
}

function fechaTextoAISO(texto) {
  const match = normalizarEspacios(texto).toLowerCase().match(
    /(?:lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo),?\s+(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/
  );
  if (!match) return null;

  const dia = String(match[1]).padStart(2, '0');
  const mes = MESES[match[2].normalize('NFD').replace(/\p{Diacritic}/gu, '')];
  const year = match[3];
  return mes ? `${year}-${mes}-${dia}` : null;
}

function extraerDatosBoletin($) {
  const texto = normalizarEspacios($('body').text());
  const match = texto.match(/Sumario del Boletin n[ºo]\s*(\d+)\s+del\s+([^]+?)(?:El contenido|Bestelako|Otros formatos)/i);
  const numero = match?.[1] || '';
  const fecha = fechaTextoAISO(match?.[2] || texto) || getFechaHoyISO();
  return { numero, fecha };
}

function extraerIdOficial(href, textoCerca) {
  const deHref = String(href || '').match(/(?:^|[_/-])(\d{4})[_-]\d{3}[_-](\d{5})(?:[_./-]|$)/);
  if (deHref) return `${deHref[1]}/${Number(deHref[2])}`;

  const deTexto = String(textoCerca || '').match(/\b(\d{4})\/(\d{3,5})\b/);
  if (deTexto) return `${deTexto[1]}/${Number(deTexto[2])}`;

  return '';
}

function esTituloCandidato(texto) {
  const t = normalizarEspacios(texto);
  if (t.length < 30) return false;
  if (/^(pdf|texto bilingue|texto bilingüe|image|home|sumario)$/i.test(t)) return false;
  return true;
}

function esEnlaceDocumentoCastellano(href) {
  return /Resultado\.aspx\?File=Boletines\/\d{4}\/\d{3}\/\d{4}_\d{3}_\d{5}_C\.xml/i.test(String(href || ''));
}

function dedupeKey(doc) {
  return doc.idOficial || doc.url || doc.titulo;
}

function parsearSumario(html, esRuralRelevante) {
  const $ = cheerio.load(html);
  const boletin = extraerDatosBoletin($);
  const docs = [];
  const vistos = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!esEnlaceDocumentoCastellano(href)) return;

    const titulo = normalizarEspacios($(el).text()).slice(0, 300);
    if (!esTituloCandidato(titulo)) return;

    const url = absoluteUrl(href);
    const parentText = normalizarEspacios($(el).parent().text());
    const contexto = normalizarEspacios([
      $(el).parent().prevAll().slice(0, 4).text(),
      parentText,
      $(el).parent().nextAll().slice(0, 4).text(),
    ].join(' '));

    if (!esRuralRelevante(`${titulo} ${contexto}`)) return;

    const idOficial = extraerIdOficial(href, contexto);
    const key = idOficial || url || titulo;
    if (vistos.has(key)) return;
    vistos.add(key);

    docs.push({
      titulo,
      url,
      urlHtml: /\.html?(?:$|\?)/i.test(url) || !/\.pdf(?:$|\?)/i.test(url) ? url : '',
      urlPdf: /\.pdf(?:$|\?)/i.test(url) ? url : '',
      fecha: boletin.fecha,
      boletin: boletin.numero,
      idOficial,
      organismo: detectarOrganismo(contexto),
      seccion: detectarSeccion(contexto),
      texto: contexto || titulo,
    });
  });

  return docs.filter((doc) => {
    const key = dedupeKey(doc);
    if (!key || doc._duplicado) return false;
    const first = docs.find((item) => dedupeKey(item) === key);
    return first === doc;
  });
}

function detectarSeccion(texto) {
  const t = normalizarEspacios(texto);
  const secciones = [
    'Juntas Generales de Álava y Administración Foral del Territorio Histórico de Álava',
    'Administración Local del Territorio Histórico de Alava',
    'Municipios',
    'Concejos',
    'Comunidades de Regantes',
    'Varios',
  ];
  return secciones.find((seccion) => t.includes(seccion)) || '';
}

function detectarOrganismo(texto) {
  const t = normalizarEspacios(texto);
  const patrones = [
    /Diputación Foral de Álava/i,
    /AYUNTAMIENTO DE [A-ZÁÉÍÓÚÜÑ -]+/i,
    /JUNTA ADMINISTRATIVA DE [A-ZÁÉÍÓÚÜÑ -]+/i,
    /COMUNIDAD DE REGANTES [A-ZÁÉÍÓÚÜÑ -]+/i,
  ];

  for (const patron of patrones) {
    const match = t.match(patron);
    if (match) return normalizarEspacios(match[0]);
  }

  return '';
}

async function obtenerTextoDocumento(doc) {
  if (!doc.urlHtml) return doc.texto || doc.titulo;

  try {
    const { data } = await axios.get(doc.urlHtml, {
      timeout: 20000,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (RuralicosBot/2.0)',
        Referer: PORTADA,
      },
    });
    const texto = htmlATexto(String(data));
    return texto.length > 200 ? texto.slice(0, 15000) : (doc.texto || doc.titulo);
  } catch {
    return doc.texto || doc.titulo;
  }
}

async function obtenerDocumentosBothaConTexto(fechaISO, esRuralRelevante) {
  const { data: html } = await axios.get(PORTADA, {
    timeout: 30000,
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (RuralicosBot/2.0)',
    },
  });

  const docs = parsearSumario(String(html), esRuralRelevante);
  if (fechaISO && docs[0]?.fecha && docs[0].fecha !== fechaISO) {
    console.log(`[BOTHA] Boletin disponible (${docs[0].fecha}) no coincide con la fecha pedida (${fechaISO})`);
    return [];
  }

  const resultado = [];
  for (const doc of docs) {
    const texto = await obtenerTextoDocumento(doc);
    resultado.push({ ...doc, texto });
  }

  console.log(`[BOTHA] ${resultado.length} documentos relevantes`);
  return resultado;
}

module.exports = {
  getFechaHoyISO,
  obtenerDocumentosBothaConTexto,
  parsearSumario,
};
