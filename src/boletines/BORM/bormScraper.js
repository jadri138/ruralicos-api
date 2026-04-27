// src/boletines/BORM/bormScraper.js
//
// Scraper del BORM (Boletín Oficial de la Región de Murcia).
//
// La web usa AngularJS con una API REST propia. Los endpoints relevantes:
//   GET services/boletin/fecha/DD-MM-YYYY/sumario → lista de anuncios del día
//   GET services/anuncio/{id}/txt                 → texto completo de cada anuncio
//
// La API requiere headers de navegador real (Referer + X-Requested-With)
// para no ser bloqueada por el sistema anti-bot Radware.

const axios = require('axios');

const BORM_BASE = 'https://www.borm.es/';

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Referer':         BORM_BASE,
  'Origin':          'https://www.borm.es',
  'X-Requested-With': 'XMLHttpRequest',
};

function getFechaHoyYYYYMMDD() {
  const fmt = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [dd, mm, yyyy] = fmt.format(new Date()).split('/');
  return `${yyyy}${mm}${dd}`;
}

// Convierte YYYYMMDD → DD-MM-YYYY (formato que usa la API del BORM)
function toApiFecha(fechaYYYYMMDD) {
  const yyyy = fechaYYYYMMDD.slice(0, 4);
  const mm   = fechaYYYYMMDD.slice(4, 6);
  const dd   = fechaYYYYMMDD.slice(6, 8);
  return `${dd}-${mm}-${yyyy}`;
}

async function obtenerTextoAnuncio(id) {
  try {
    const { data } = await axios.get(`${BORM_BASE}services/anuncio/${id}/txt`, {
      timeout: 20000,
      headers: HEADERS,
      responseType: 'arraybuffer',
    });
    return Buffer.from(data).toString('utf8').trim();
  } catch (e) {
    console.warn(`[BORM] Texto no disponible para anuncio ${id}: ${e.message}`);
    return '';
  }
}

async function obtenerDocumentosBormPorFecha(fechaYYYYMMDD) {
  const apiFecha = toApiFecha(fechaYYYYMMDD);
  const fechaISO = `${fechaYYYYMMDD.slice(0, 4)}-${fechaYYYYMMDD.slice(4, 6)}-${fechaYYYYMMDD.slice(6, 8)}`;

  const urlSumario = `${BORM_BASE}services/boletin/fecha/${apiFecha}/sumario`;
  console.log('[BORM] Sumario →', urlSumario);

  let anuncios;
  try {
    const { data } = await axios.get(urlSumario, { timeout: 30000, headers: HEADERS });
    anuncios = data.anunciosBoletin || [];
  } catch (e) {
    // 404 significa que no hay boletín para esa fecha
    if (e.response?.status === 404) {
      console.log('[BORM] Sin boletín para', fechaISO);
      return [];
    }
    console.error('[BORM] Error obteniendo sumario:', e.message);
    return [];
  }

  if (!anuncios.length) {
    console.log('[BORM] Sin anuncios para', fechaISO);
    return [];
  }

  console.log(`[BORM] ${anuncios.length} anuncios encontrados`);

  const resultado = [];
  for (const anuncio of anuncios) {
    const texto = await obtenerTextoAnuncio(anuncio.id);
    resultado.push({
      titulo:    (anuncio.sumario || '').replace(/\s+/g, ' ').trim().slice(0, 250),
      url:       `${BORM_BASE}services/anuncio/${anuncio.id}/pdf`,
      texto,
      fecha:     fechaISO,
      seccion:   anuncio.subApartado || anuncio.apartado || '',
      organismo: anuncio.anunciante  || '',
    });
  }

  return resultado;
}

module.exports = { getFechaHoyYYYYMMDD, obtenerDocumentosBormPorFecha };
