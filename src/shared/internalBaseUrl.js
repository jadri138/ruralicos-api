const RETIRED_HOSTS = new Set(['api.ruralicos.es']);

function normalizarBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';

  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (RETIRED_HOSTS.has(url.hostname.toLowerCase())) return '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function getRequestBaseUrl(req) {
  if (!req || typeof req !== 'object') return '';

  const host = typeof req.get === 'function'
    ? req.get('host')
    : req.headers?.host;
  if (!host) return '';

  const forwardedProto = typeof req.get === 'function'
    ? req.get('x-forwarded-proto')
    : req.headers?.['x-forwarded-proto'];
  const protocol = String(forwardedProto || req.protocol || 'http')
    .split(',')[0]
    .trim()
    .replace(/:$/, '');

  return normalizarBaseUrl(`${protocol || 'http'}://${host}`);
}

function getInternalBaseUrl(req, env = process.env) {
  const explicit = normalizarBaseUrl(env.PIPELINE_INTERNAL_BASE_URL);
  if (explicit) return explicit;

  const requestBase = getRequestBaseUrl(req);
  if (requestBase) return requestBase;

  const publicBase = normalizarBaseUrl(env.PUBLIC_BASE_URL);
  if (publicBase) return publicBase;

  return `http://localhost:${env.PORT || 3000}`;
}

module.exports = {
  getInternalBaseUrl,
  getRequestBaseUrl,
  normalizarBaseUrl,
};
