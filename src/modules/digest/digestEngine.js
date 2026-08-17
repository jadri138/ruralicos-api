const DIGEST_ENGINES = Object.freeze(['v1', 'v2']);

function resolveDigestEngine(value = process.env.DIGEST_ENGINE) {
  const normalized = String(value || 'v2')
    .trim()
    .toLowerCase();
  if (!DIGEST_ENGINES.includes(normalized)) {
    throw new Error(`DIGEST_ENGINE invalido: ${normalized || '(vacio)'}. Usa v1 o v2.`);
  }
  return normalized;
}

module.exports = {
  DIGEST_ENGINES,
  resolveDigestEngine,
};
