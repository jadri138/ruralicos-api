// src/modules/tareas/tareas.helpers.js
//
// Helpers compartidos entre las rutas de tareas (crons HTTP) y el runner de
// pipeline con checkpoints (pipelineRunner.js). Sin estado propio: todo recibe
// supabase/config por parametro.

const SCRAPE_PATHS_DEFAULT = [
  '/scrape-boe-oficial',
  '/scrape-boa-oficial',
  '/scrape-bocan-oficial',
  '/scrape-bocant-oficial',
  '/scrape-bocm-oficial',
  '/scrape-bocyl-oficial',
  '/scrape-boib-oficial',
  '/scrape-boja-oficial',
  '/scrape-bon-oficial',
  '/scrape-bopa-oficial',
  '/scrape-bopv-oficial',
  '/scrape-bor-oficial',
  '/scrape-borm-oficial',
  '/scrape-docm-oficial',
  '/scrape-doe-oficial',
  '/scrape-dog',
  '/scrape-dogc',
  '/scrape-dogv',
  '/scrape-bome-oficial',
  '/scrape-bocce-oficial',
  '/scrape-botha-oficial',
  '/scrape-bog-oficial',
  '/scrape-bopz-oficial',
  '/scrape-boph-oficial',
  '/scrape-bopt-oficial',
];

const COMPLEMENTARY_SCRAPE_PATHS_DEFAULT = [];

const FEGA_SCRAPE_PATH = '/scrape-fega-beneficiarios';

const SCRAPER_FUENTES = {
  '/scrape-boe-oficial': 'BOE',
  '/scrape-boa-oficial': 'BOA',
  '/scrape-bocan-oficial': 'BOCAN',
  '/scrape-bocant-oficial': 'BOCANT',
  '/scrape-bocm-oficial': 'BOCM',
  '/scrape-bocyl-oficial': 'BOCYL',
  '/scrape-boib-oficial': 'BOIB',
  '/scrape-boja-oficial': 'BOJA',
  '/scrape-bon-oficial': 'BON',
  '/scrape-bopa-oficial': 'BOPA',
  '/scrape-bopv-oficial': 'BOPV',
  '/scrape-botha-oficial': 'BOTHA',
  '/scrape-bog-oficial': 'BOG',
  '/scrape-bopz-oficial': 'BOPZ',
  '/scrape-boph-oficial': 'BOPH',
  '/scrape-bopt-oficial': 'BOPT',
  '/scrape-bor-oficial': 'BOR',
  '/scrape-borm-oficial': 'BORM',
  '/scrape-docm-oficial': 'DOCM',
  '/scrape-doe-oficial': 'DOE',
  '/scrape-dog': 'DOG',
  '/scrape-dogc': 'DOGC',
  '/scrape-dogv': 'DOGV',
  '/scrape-bome-oficial': 'BOME',
  '/scrape-bocce-oficial': 'BOCCE',
  [FEGA_SCRAPE_PATH]: 'FEGA',
};

function getScrapePaths() {
  return (process.env.PIPELINE_SCRAPE_PATHS || SCRAPE_PATHS_DEFAULT.join(','))
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean);
}

function getComplementaryScrapePaths() {
  return (process.env.COMPLEMENTARY_SCRAPE_PATHS || COMPLEMENTARY_SCRAPE_PATHS_DEFAULT.join(','))
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean);
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'si', 'on'].includes(String(value).trim().toLowerCase());
}

function uniquePaths(paths) {
  return Array.from(new Set(paths.filter(Boolean)));
}

function getAllowedScraperPaths() {
  return uniquePaths([
    ...SCRAPE_PATHS_DEFAULT,
    ...COMPLEMENTARY_SCRAPE_PATHS_DEFAULT,
    ...getScrapePaths(),
    ...getComplementaryScrapePaths(),
    FEGA_SCRAPE_PATH,
  ]);
}

function getPipelineScrapePaths(options = {}) {
  const {
    incluirComplementarios = true,
    incluirFega = false,
  } = options;

  const paths = [...getScrapePaths()];
  if (incluirComplementarios) paths.push(...getComplementaryScrapePaths());
  if (incluirFega) paths.push(FEGA_SCRAPE_PATH);

  return uniquePaths(paths);
}

function appendQuery(baseUrl, path, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  }

  const suffix = query.toString();
  return suffix ? `${baseUrl}${path}${path.includes('?') ? '&' : '?'}${suffix}` : `${baseUrl}${path}`;
}

function buildCronFetchOptions(token, method = 'GET', extra = {}) {
  return {
    ...extra,
    method,
    headers: {
      ...(extra.headers || {}),
      'x-cron-token': token,
    },
  };
}

function buildScrapeUrl(baseUrl, path, fechaISO) {
  const fecha = path.startsWith('/scrape-boe-')
    ? fechaISO.replace(/-/g, '')
    : fechaISO;
  return appendQuery(baseUrl, path, { fecha });
}

function buildComplementaryScrapeUrl(baseUrl, path, fechaISO, options = {}) {
  if (path === '/scrape-fega-beneficiarios') {
    return appendQuery(baseUrl, path, {
      ejercicio: options.ejercicio || null,
      enviar: options.enviarFega ? 'true' : null,
      detectar: options.detectar === false ? 'false' : null,
    });
  }

  return buildScrapeUrl(baseUrl, path, fechaISO);
}

function obtenerFuenteScraper(path) {
  return SCRAPER_FUENTES[path] || path.replace(/^\/scrape-/, '').replace(/-oficial$/, '').toUpperCase();
}

function numeroBody(body, keys) {
  for (const key of keys) {
    const value = Number(body?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

async function readResponseBody(response) {
  const raw = await response.text();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return { raw: raw.replace(/\s+/g, ' ').slice(0, 800) };
  }
}

function isRetryableStatus(status) {
  return [408, 429, 500, 502, 503, 504].includes(Number(status));
}

function isRetryableError(err) {
  return err?.retryable === true || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(String(err?.message || ''));
}

async function guardarScraperRun(supabase, run) {
  const { error } = await supabase.from('scraper_runs').insert([run]);
  if (error) {
    console.warn('[scraper_runs] No se pudo guardar ejecucion:', error.message);
  }
}

async function guardarPipelineRun(supabase, run) {
  const { error } = await supabase.from('pipeline_runs').insert([run]);
  if (error) {
    console.warn('[pipeline_runs] No se pudo guardar ejecucion:', error.message);
  }
}

module.exports = {
  SCRAPE_PATHS_DEFAULT,
  COMPLEMENTARY_SCRAPE_PATHS_DEFAULT,
  FEGA_SCRAPE_PATH,
  SCRAPER_FUENTES,
  getScrapePaths,
  getComplementaryScrapePaths,
  boolValue,
  uniquePaths,
  getAllowedScraperPaths,
  getPipelineScrapePaths,
  appendQuery,
  buildCronFetchOptions,
  buildScrapeUrl,
  buildComplementaryScrapeUrl,
  obtenerFuenteScraper,
  numeroBody,
  readResponseBody,
  isRetryableStatus,
  isRetryableError,
  guardarScraperRun,
  guardarPipelineRun,
};
