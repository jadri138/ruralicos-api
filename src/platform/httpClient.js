const axios = require('axios');
const https = require('https');

const httpsInseguro = new https.Agent({ rejectUnauthorized: false });

// Cabeceras de navegador real. Varias webs oficiales (Joomla de ceuta.es,
// Domino de las diputaciones aragonesas, etc.) deprioritizan o "tarpitan" las
// peticiones cuyo User-Agent se anuncia como bot desde IPs de datacenter, lo
// que se manifiesta como conexiones que cuelgan hasta agotar el timeout. Usar
// un perfil de navegador completo reduce ese bloqueo.
const NAVEGADOR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function cabecerasNavegador(extra = {}) {
  return {
    'User-Agent': NAVEGADOR_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9',
    'Upgrade-Insecure-Requests': '1',
    ...extra,
  };
}

const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTlsCertificateError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();

  return TLS_ERROR_CODES.has(code)
    || message.includes('self-signed certificate')
    || message.includes('certificate chain')
    || message.includes('local issuer certificate')
    || message.includes('unable to get issuer certificate');
}

function isRetryableHttpError(error) {
  const code = String(error?.code || '').toUpperCase();
  if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(code)) return true;
  if (!error?.response) return true;

  const status = Number(error.response.status || 0);
  return status === 408 || status === 429 || status >= 500;
}

async function axiosGetWithRetry(url, config = {}, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 1));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs || 1000));
  const allowInsecureFallback = Boolean(options.allowInsecureFallback);
  let useInsecure = Boolean(options.insecure);
  let lastError = null;
  let attempt = 0;

  while (attempt < attempts) {
    attempt += 1;

    try {
      return await axios.get(url, {
        ...config,
        httpsAgent: useInsecure ? (config.httpsAgent || httpsInseguro) : config.httpsAgent,
      });
    } catch (error) {
      lastError = error;

      if (allowInsecureFallback && !useInsecure && isTlsCertificateError(error)) {
        useInsecure = true;
        attempt -= 1;
        continue;
      }

      if (attempt >= attempts || !isRetryableHttpError(error)) throw error;
      await sleep(retryDelayMs * attempt);
    }
  }

  throw lastError;
}

module.exports = {
  axiosGetWithRetry,
  httpsInseguro,
  isTlsCertificateError,
  isRetryableHttpError,
  NAVEGADOR_UA,
  cabecerasNavegador,
};
