process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const axios = require('axios');
const scenarios = require('./fixtures/bopz/resilience-scenarios.json');
const {
  obtenerDocumentosBopzConTexto,
  __testing,
} = require('../src/modules/boletines/scrapers/provinciales/aragon/scraper');
const { __testing: routeTesting } = require('../src/modules/boletines/rutas/provinciales/aragon/bopAragon');
const { evaluarRespuestaScraper } = require('../src/modules/boletines/scraperRunQuality');
const { crearEjecutorHttp } = require('../src/modules/tareas/pipelineRunner');

const originalGet = axios.get;
const originalFetch = global.fetch;
const originalEnv = {
  BOPZ_BASE_URLS: process.env.BOPZ_BASE_URLS,
  BOPZ_HTML_ATTEMPTS: process.env.BOPZ_HTML_ATTEMPTS,
  BOPZ_RETRY_BACKOFF_MS: process.env.BOPZ_RETRY_BACKOFF_MS,
  BOPZ_MAX_DOCUMENTS: process.env.BOPZ_MAX_DOCUMENTS,
};

function response(html) {
  return { data: Buffer.from(html, 'latin1'), headers: {} };
}

function timeoutError() {
  const error = new Error('socket timed out');
  error.code = 'ETIMEDOUT';
  return error;
}

function summary(count = 1) {
  const links = Array.from({ length: count }, (_, index) => `
    <div class="row">Ayuntamiento ${index + 1}</div>
    <div class="row"><a class="enlaceEdicto" onclick="abreVentanaDetalleEdicto('ID-${index + 1}')">Ayuda rural ${index + 1}</a></div>
  `).join('');
  return `<input name="numBop" value="155"><input name="fechaPub" value="22/07/2026">${links}`;
}

async function expectRejectCode(promise, code) {
  let caught = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert(caught, `se esperaba error ${code}`);
  assert.strictEqual(caught.code, code);
  return caught;
}

(async () => {
  process.env.BOPZ_BASE_URLS = scenarios.endpoints.join(',');
  process.env.BOPZ_HTML_ATTEMPTS = '2';
  process.env.BOPZ_RETRY_BACKOFF_MS = '1';
  process.env.BOPZ_MAX_DOCUMENTS = String(scenarios.expected.max_documents);

  let primaryAttempts = 0;
  axios.get = async (url) => {
    if (url === `${scenarios.endpoints[0]}/BOPZ/`) {
      primaryAttempts += 1;
      if (primaryAttempts === 1) throw timeoutError();
      return response(summary());
    }
    if (url.includes('obtenerContenidoEdicto')) return response('<main>Ayuda para explotaciones agrarias</main>');
    throw new Error(`URL inesperada ${url}`);
  };
  const retryRecovered = await obtenerDocumentosBopzConTexto(scenarios.fecha);
  assert.strictEqual(retryRecovered.length, 1);
  assert.strictEqual(primaryAttempts, 2, 'reintento limitado recupera el endpoint primario');

  axios.get = async (url) => {
    if (url === `${scenarios.endpoints[0]}/BOPZ/`) throw timeoutError();
    if (url === `${scenarios.endpoints[1]}/BOPZ/`) return response(summary());
    if (url.includes('obtenerContenidoEdicto')) return response('<main>Subvencion agraria</main>');
    throw timeoutError();
  };
  const fallbackRecovered = await obtenerDocumentosBopzConTexto(scenarios.fecha);
  assert.strictEqual(fallbackRecovered.length, 1, 'fallback al segundo endpoint');

  axios.get = async () => { throw timeoutError(); };
  const totalTimeout = await expectRejectCode(
    obtenerDocumentosBopzConTexto(scenarios.fecha),
    scenarios.expected.total_timeout_code
  );
  const timeoutResponse = routeTesting.construirErrorBopz(totalTimeout);
  assert.strictEqual(timeoutResponse.status, 504);
  assert.strictEqual(timeoutResponse.body.scrape_state, 'timeout');
  assert.strictEqual(timeoutResponse.body.retryable, false, 'no duplica fuera los retries internos agotados');
  assert.strictEqual(
    evaluarRespuestaScraper({ responseOk: false, httpStatus: 504, body: timeoutResponse.body }).severity,
    'error'
  );

  axios.get = async (url) => {
    if (url.endsWith('/BOPZ/')) return response('<html><body>Portal rediseñado sin selectores conocidos</body></html>');
    throw new Error(`URL inesperada ${url}`);
  };
  await expectRejectCode(
    obtenerDocumentosBopzConTexto(scenarios.fecha),
    scenarios.expected.broken_parse_code
  );

  axios.get = async (url) => {
    if (url.endsWith('/BOPZ/')) return response('<html><body>No hay boletin publicado para la fecha solicitada</body></html>');
    throw new Error(`URL inesperada ${url}`);
  };
  const noPublication = await obtenerDocumentosBopzConTexto(scenarios.fecha);
  assert.strictEqual(noPublication.length, 0);
  assert.strictEqual(noPublication.scrape_diagnostics.state, scenarios.expected.no_publication_state);
  const noPublicationBody = routeTesting.construirRespuestaBopz(noPublication, {
    totales: 0,
    nuevas: 0,
    duplicadas: 0,
    errores: 0,
  });
  assert.strictEqual(
    evaluarRespuestaScraper({ responseOk: true, body: noPublicationBody }).severity,
    'ok',
    'sin publicacion real no se registra como fallo'
  );

  axios.get = async (url) => {
    if (url.endsWith('/BOPZ/')) return response(summary(4));
    if (url.includes('obtenerContenidoEdicto')) return response('<main>Ayuda para agricultores</main>');
    throw new Error(`URL inesperada ${url}`);
  };
  const limited = await obtenerDocumentosBopzConTexto(scenarios.fecha);
  assert.strictEqual(limited.length, scenarios.expected.max_documents, 'limite de descarga acotado');
  const limitedBody = routeTesting.construirRespuestaBopz(limited, {
    totales: limited.length,
    nuevas: limited.length,
    duplicadas: 0,
    errores: 0,
  });
  assert.strictEqual(limitedBody.scrape_state, 'partial_recovery');
  assert.strictEqual(
    evaluarRespuestaScraper({ responseOk: true, body: limitedBody }).severity,
    'warning',
    'una captura truncada queda warning, no exito silencioso'
  );

  assert.strictEqual(__testing.clasificarErrorBopz(timeoutError()).state, 'timeout');
  assert.strictEqual(__testing.clasificarErrorBopz(new Error('ECONNREFUSED')).state, 'portal_down');

  let outerCalls = 0;
  global.fetch = async () => {
    outerCalls += 1;
    return {
      ok: false,
      status: 504,
      text: async () => JSON.stringify(timeoutResponse.body),
    };
  };
  const ejecutar = crearEjecutorHttp({
    baseUrl: 'https://ruralicos.test',
    token: 'test-token',
    fecha: scenarios.fecha,
    httpRetries: 3,
    httpRetryDelayMs: 1,
    sleep: async () => {},
  });
  await assert.rejects(() => ejecutar('/scrape-bopz-oficial'), /504/);
  assert.strictEqual(outerCalls, 1, 'el pipeline no repite todo el scraper tras agotar retries internos');
  console.log('OK: BOPZ simulado cubre timeout, retry, fallback, parseo, sin publicacion y limites');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  axios.get = originalGet;
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
