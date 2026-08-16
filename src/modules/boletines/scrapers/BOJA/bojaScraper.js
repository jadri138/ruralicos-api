// src/boletines/BOJA/bojaScraper.js
//
// Scraper del BOJA (Boletín Oficial de la Junta de Andalucía) usando la API REST oficial.
//
// API base (sin autenticación, documentada con OpenAPI):
//   https://datos.juntadeandalucia.es/api/v0/boja/
//
// Estrategia:
//   1. GET /get/calendar?year=YYYY  → encontrar el nº de boletín para la fecha de hoy
//   2. GET /get/bulletin?year=YYYY&number=NN  → todas las disposiciones del boletín
//   3. Cada disposición incluye bodyNoHtml (texto completo) → sin descargar PDFs
//
// Tipos de boletín:
//   - Ordinarios (nº 1–4 dígitos):  ~4–5 por semana
//   - Extraordinarios (nº 3 dígitos tipo 501…): raros
//   - Complementarios (nº 6 dígitos tipo 200101): ignorados aquí

const axios = require('axios');
const { isRetryableHttpError } = require('../../../../platform/httpClient');
const { agenteResiliente } = require('../../../../platform/dnsResiliente');

const BOJA_API = 'https://datos.juntadeandalucia.es/api/v0/boja';

function enteroAcotado(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.trunc(parsed)))
    : fallback;
}

function esFinDeSemanaYYYYMMDD(fechaYYYYMMDD) {
  const match = String(fechaYYYYMMDD || '').match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return false;

  const fecha = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  if (fecha.getUTCFullYear() !== Number(match[1])
    || fecha.getUTCMonth() !== Number(match[2]) - 1
    || fecha.getUTCDate() !== Number(match[3])) return false;

  return fecha.getUTCDay() === 0 || fecha.getUTCDay() === 6;
}

async function solicitarJsonBoja(url, options = {}) {
  const env = options.env || process.env;
  const request = options.request || axios.get;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = enteroAcotado(env.BOJA_HTTP_ATTEMPTS, 2, 1, 3);
  const timeoutMs = enteroAcotado(env.BOJA_HTTP_TIMEOUT_MS, 7000, 1000, 12000);
  const retryBackoffMs = enteroAcotado(env.BOJA_RETRY_BACKOFF_MS, 300, 0, 3000);
  const deadlineMs = options.deadlineMs || (Date.now() + timeoutMs);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw Object.assign(new Error('presupuesto total BOJA agotado'), { code: 'ETIMEDOUT' });
      }

      return await request(url, {
        timeout: Math.min(timeoutMs, remainingMs),
        httpsAgent: agenteResiliente,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Ruralicos/1.0 (+https://ruralicos.es)',
        },
      });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableHttpError(error)) throw error;

      const delay = retryBackoffMs * attempt;
      if (deadlineMs - Date.now() <= delay) break;
      await sleep(delay);
    }
  }

  throw lastError;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function getFechaHoyYYYYMMDD() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// Elimina etiquetas HTML residuales de campos como organism o sectionN1
function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────
// Paso 1: obtener el número de boletín ordinario para una fecha.
// El calendario devuelve: { columns: [...], rows: [[nº, "DD/MM/YYYY"], ...] }
// Se filtran boletines ordinarios (nº ≤ 4 dígitos) para excluir
// complementarios (6 dígitos) y extraordinarios (3 dígitos tipo 501…).
// ─────────────────────────────────────────────
async function obtenerNumerosBoletin(fechaDDMMYYYY, options = {}) {
  const year = fechaDDMMYYYY.slice(6); // YYYY al final de DD/MM/YYYY
  const url  = `${BOJA_API}/get/calendar?year=${year}`;
  console.log('[BOJA] Calendario →', url);

  const { data } = await solicitarJsonBoja(url, options);

  // Puede devolver arrays de [número, "DD/MM/YYYY"] o [número, fecha, ...]
  const rows = data.rows || [];
  return rows
    .filter(r => r[1] === fechaDDMMYYYY && String(r[0]).length <= 4)
    .map(r => String(r[0]));
}

// ─────────────────────────────────────────────
// Paso 2: obtener todas las disposiciones de un boletín.
// Devuelve el array de hits tal como los devuelve la API.
// ─────────────────────────────────────────────
async function obtenerHitsBoletín(year, numBoletin, options = {}) {
  const url = `${BOJA_API}/get/bulletin?year=${year}&number=${numBoletin}`;
  console.log('[BOJA] Boletín →', url);

  const { data } = await solicitarJsonBoja(url, options);

  const hits = Array.isArray(data.results) ? data.results : [];
  console.log(`[BOJA] Boletín nº${numBoletin}: ${hits.length} disposiciones (total_hits: ${data.total_hits ?? hits.length})`);
  return hits;
}

// ─────────────────────────────────────────────
// Función principal
// Devuelve array de disposiciones con texto completo para una fecha (YYYYMMDD).
// ─────────────────────────────────────────────
async function obtenerDocumentosBojaPorFecha(fechaYYYYMMDD, options = {}) {
  // El scraper cubre boletines ordinarios, que el BOJA publica de lunes a
  // viernes. Evita convertir una caída del portal durante el fin de semana en
  // un falso fallo de cobertura.
  if (esFinDeSemanaYYYYMMDD(fechaYYYYMMDD)) {
    console.log(`[BOJA] ${fechaYYYYMMDD} es fin de semana; no se consulta el calendario ordinario`);
    return [];
  }

  const año = fechaYYYYMMDD.slice(0, 4);
  const mes = fechaYYYYMMDD.slice(4, 6);
  const dia = fechaYYYYMMDD.slice(6, 8);
  const fechaISO      = `${año}-${mes}-${dia}`;       // YYYY-MM-DD
  const fechaDDMMYYYY = `${dia}/${mes}/${año}`;        // DD/MM/YYYY (formato del calendario)

  // Buscar boletines ordinarios publicados hoy
  const env = options.env || process.env;
  const totalBudgetMs = enteroAcotado(env.BOJA_TOTAL_BUDGET_MS, 15000, 5000, 19000);
  const deadlineMs = Date.now() + totalBudgetMs;
  const requestOptions = { ...options, env, deadlineMs };

  const numeros = await obtenerNumerosBoletin(fechaDDMMYYYY, requestOptions);
  if (!numeros.length) {
    console.log(`[BOJA] No hay boletín ordinario para ${fechaYYYYMMDD}`);
    return [];
  }

  // Procesar todos los boletines del día (normalmente solo 1; excepcionalmente 2)
  const todasLasDisposiciones = [];
  for (const num of numeros) {
    const hits = await obtenerHitsBoletín(año, num, requestOptions);
    todasLasDisposiciones.push(...hits.map(d => ({ ...d, _numBoletin: num })));
  }

  // Mapear a la estructura que espera la ruta
  return todasLasDisposiciones.map(d => {
    const organismo  = d.organisation || stripHtml(d.organism || '');
    const seccion    = stripHtml(d.sectionN1 || '');
    const numBoletin = d._numBoletin;
    const dispNum    = d.dispositionNumber || '';

    // Título: campo summaryNoHtml (resumen oficial) o construido desde organism + rango
    const titulo = (
      d.summaryNoHtml ||
      stripHtml(d.summary || '') ||
      `${d.rango || ''} ${organismo}`
    ).replace(/\s+/g, ' ').trim().slice(0, 250);

    // Texto completo: bodyNoHtml (campo del API) con summaryNoHtml como cabecera si existe
    const cuerpo = (d.bodyNoHtml || stripHtml(d.body || '')).trim();
    const texto  = cuerpo
      ? (d.summaryNoHtml ? `${d.summaryNoHtml}\n\n${cuerpo}` : cuerpo)
      : (d.summaryNoHtml || titulo);

    // URLs: HTML canónica (estable) + PDF si existe
    const urlHtml = `https://www.juntadeandalucia.es/boja/${año}/${numBoletin}/${dispNum}`;
    const urlPdf  = d.pdf?.[0]?.publicUrl || null;

    return {
      titulo,
      url:       urlHtml,          // URL canónica estable para la BD
      urlPdf:    urlPdf || null,
      texto:     texto.slice(0, 15000),
      fecha:     fechaISO,
      seccion,
      organismo,
    };
  });
}

module.exports = {
  getFechaHoyYYYYMMDD,
  obtenerDocumentosBojaPorFecha,
  __testing: {
    esFinDeSemanaYYYYMMDD,
    obtenerHitsBoletín,
    obtenerNumerosBoletin,
    solicitarJsonBoja,
  },
};
