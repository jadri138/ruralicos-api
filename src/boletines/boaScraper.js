// src/boletines/boa.js
const axios = require('axios');

const CKAN_BASE_URL = 'https://opendata.aragon.es/api/action';

// ==========================
// 1) Dataset BOA (CKAN)
// ==========================
async function getBoaDataset() {
  const response = await axios.get(`${CKAN_BASE_URL}/package_show`, {
    params: { id: 'boletin-oficial-aragon-diario' },
  });

  if (!response.data || !response.data.success) {
    throw new Error('Error al pedir el dataset del BOA a CKAN');
  }

  return response.data.result;
}

async function listarRecursosBoa() {
  const dataset = await getBoaDataset();

  console.log('Título dataset BOA:', dataset.title);
  console.log('---------------------------');
  console.log('Recursos encontrados:\n');

  (dataset.resources || []).forEach((r, i) => {
    console.log(`Recurso #${i + 1}`);
    console.log('  name   :', r.name);
    console.log('  format :', r.format);
    console.log('  url    :', r.url);
    console.log('---------------------------');
  });
}

async function testBoa() {
  try {
    await listarRecursosBoa();
  } catch (err) {
    console.error('Error testBoa:', err.message);
  }
}

// ==========================
// 2) Fecha de hoy
// ==========================
function getFechaHoyYYYYMMDDguiones() {
  const hoy = new Date();
  const year = hoy.getFullYear();
  const month = String(hoy.getMonth() + 1).padStart(2, '0');
  const day = String(hoy.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`; // 2025-12-06
}

// ==========================
// 3) BOA en JSON (últimos anuncios)
// ==========================

/**
 * Descarga los ÚLTIMOS anuncios del BOA en JSON (texto bruto).
 * NO filtramos todavía por fecha.
 */
async function fetchBoaJsonRaw() {
  const url =
    'https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VERLST' +
    '&OUTPUTMODE=JSON' +
    '&BASE=BOLE' +
    '&DOCS=1-500' +
    '&SEC=OPENDATABOAJSON' +
    '&SORT=-PUBL' +
    '&SEPARADOR=';

  const response = await axios.get(url, {
    responseType: 'text',       // <- importante: lo tratamos como texto
    headers: {
      Accept: 'application/json,*/*',
    },
  });

  return response.data; // string
}

/**
 * Intenta parsear el JSON del BOA.
 * Si falla, muestra en consola el error y un trozo del texto recibido.
 */
async function descargarBoaJSONUltimos() {
  const raw = await fetchBoaJsonRaw();

  console.log('Primeros 200 caracteres del JSON bruto del BOA:');
  console.log(raw.slice(0, 200));
  console.log('----------------------------------------------');

  let data;

  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error('Error al hacer JSON.parse del BOA:', e.message);
    console.log('TEXTO RECIBIDO (primeros 500 caracteres):');
    console.log(raw.slice(0, 500));
    throw e; // re-lanzamos para que el test lo vea
  }

  return data;
}

/**
 * (A FUTURO) – Cuando sepamos la estructura exacta del JSON,
 * aquí filtraremos por FechaPublicacion = hoy y devolveremos sólo las filas de hoy.
 */
async function descargarBoaHoyJSON() {
  const hoy = getFechaHoyYYYYMMDDguiones();
  const data = await descargarBoaJSONUltimos();

  // De momento solo devolvemos todo; ya filtraremos cuando veamos la estructura real.
  console.log('Fecha de hoy para filtrar:', hoy);
  return data;
}

// ==========================
// EXPORTS
// ==========================
module.exports = {
  getBoaDataset,
  listarRecursosBoa,
  testBoa,
  getFechaHoyYYYYMMDDguiones,
  fetchBoaJsonRaw,
  descargarBoaJSONUltimos,
  descargarBoaHoyJSON,
};
