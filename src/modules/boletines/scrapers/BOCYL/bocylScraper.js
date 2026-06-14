// src/boletines/BOCYL/bocylScraper.js
//
// Scraper del BOCYL (Boletín Oficial de Castilla y León) usando scraping directo
// de la web oficial: https://bocyl.jcyl.es/boletin.do?fechaBoletin=DD/MM/YYYY
//
// La API OpenDataSoft anterior acumula retraso de horas el mismo día de publicación,
// lo que impedía procesar el boletín en el cron de las 8:30h.

const axios = require('axios');
const { htmlATexto }      = require('../../../../shared/htmlParser');
const { extraerTextoPdf } = require('../../../../shared/pdfExtractor');

const BOCYL_BASE  = 'https://bocyl.jcyl.es/';
const BOCYL_INDEX = 'https://bocyl.jcyl.es/boletin.do';

function getFechaHoyYYYYMMDD() {
  const fmt = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [dd, mm, yyyy] = fmt.format(new Date()).split('/');
  return `${yyyy}${mm}${dd}`;
}

// Elimina comentarios HTML antes de parsear para ignorar los <li> comentados
// que el BOCYL incluye como duplicados alternativos de cada enlace.
function quitarComentarios(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

// Extrae todas las disposiciones del HTML del índice diario.
// Patrón: <p>TÍTULO</p> + <ul class="descargaBoletin">PDF+HTML</ul>
// El organismo precede al bloque en un <h5>.
function parsearBocyl(html, fechaISO) {
  const limpio   = quitarComentarios(html);
  const entradas = [];

  // Posiciones de organismos (<h5>) para asociar cada bloque con su organismo
  const organismos = [];
  const reOrg = /<h5[^>]*>([\s\S]*?)<\/h5>/gi;
  let mo;
  while ((mo = reOrg.exec(limpio)) !== null) {
    const texto = mo[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (texto) organismos.push({ pos: mo.index, texto });
  }

  // Cada disposición: <p>TÍTULO</p> seguido de <ul class="descargaBoletin">...</ul>
  const reBloque = /<p>([\s\S]*?)<\/p>\s*\n?\s*<ul class="descargaBoletin">([\s\S]*?)<\/ul>/gi;
  let m;
  while ((m = reBloque.exec(limpio)) !== null) {
    const tituloRaw = m[1];
    const ulContent = m[2];

    const titulo = tituloRaw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 250);
    if (!titulo || titulo.length < 10) continue;

    // PDF: URL absoluta ya presente en el HTML
    const pdfMatch = ulContent.match(/href='(https:\/\/bocyl\.jcyl\.es\/boletines\/[^']+\.pdf)'/);
    const pdfUrl   = pdfMatch ? pdfMatch[1] : null;

    // HTML: URL relativa que empieza por html/
    const htmlMatch = ulContent.match(/href='(html\/[^']+\.do)'/);
    const htmlUrl   = htmlMatch ? BOCYL_BASE + htmlMatch[1] : null;

    if (!pdfUrl && !htmlUrl) continue;

    // Organismo más cercano anterior al bloque
    const pos = m.index;
    let organismo = '';
    for (const org of organismos) {
      if (org.pos < pos) organismo = org.texto;
      else break;
    }

    entradas.push({ titulo, pdfUrl, htmlUrl, fecha: fechaISO, organismo });
  }

  return entradas;
}

async function obtenerTextoDisposicion(htmlUrl, pdfUrl) {
  // Intento 1: HTML
  if (htmlUrl) {
    try {
      const { data } = await axios.get(htmlUrl, {
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0 (RuralicosBot/2.0)', Accept: 'text/html', Referer: BOCYL_BASE },
      });
      const texto = htmlATexto(String(data));
      if (texto.length > 200) return texto;
    } catch (e) {
      console.warn(`[BOCYL] HTML no disponible (${htmlUrl}): ${e.message}`);
    }
  }

  // Intento 2: PDF
  if (pdfUrl) {
    try {
      const { data } = await axios.get(pdfUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: { Accept: 'application/pdf,*/*', 'User-Agent': 'Mozilla/5.0 (RuralicosBot/2.0)', Referer: BOCYL_BASE },
        validateStatus: s => s >= 200 && s < 400,
      });
      const buf = Buffer.from(data);
      if (buf.slice(0, 4).toString('utf8') === '%PDF') {
        return await extraerTextoPdf(buf);
      }
    } catch (e) {
      console.warn(`[BOCYL] PDF no disponible (${pdfUrl}): ${e.message}`);
    }
  }

  return '';
}

async function obtenerDocumentosBocylPorFecha(fechaYYYYMMDD) {
  const año = fechaYYYYMMDD.slice(0, 4);
  const mes = fechaYYYYMMDD.slice(4, 6);
  const dia = fechaYYYYMMDD.slice(6, 8);
  const fechaISO   = `${año}-${mes}-${dia}`;
  const fechaSlash = `${dia}/${mes}/${año}`;

  const urlIndice = `${BOCYL_INDEX}?fechaBoletin=${fechaSlash}`;
  console.log('[BOCYL] Índice →', urlIndice);

  let html;
  try {
    const { data } = await axios.get(urlIndice, {
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0 (RuralicosBot/2.0)', Accept: 'text/html', Referer: BOCYL_BASE },
      validateStatus: s => s >= 200 && s < 400,
    });
    html = typeof data === 'string' ? data : '';
  } catch (e) {
    console.error('[BOCYL] Error obteniendo índice:', e.message);
    return [];
  }

  const entradas = parsearBocyl(html, fechaISO);
  if (!entradas.length) {
    console.log('[BOCYL] Sin boletín para', fechaISO);
    return [];
  }

  console.log(`[BOCYL] ${entradas.length} entradas encontradas`);

  const resultado = [];
  for (const entrada of entradas) {
    const texto = await obtenerTextoDisposicion(entrada.htmlUrl, entrada.pdfUrl);
    resultado.push({
      titulo:    entrada.titulo,
      url:       entrada.pdfUrl || entrada.htmlUrl,
      texto,
      fecha:     entrada.fecha,
      seccion:   '',
      organismo: entrada.organismo,
    });
  }

  return resultado;
}

module.exports = { getFechaHoyYYYYMMDD, obtenerDocumentosBocylPorFecha };
