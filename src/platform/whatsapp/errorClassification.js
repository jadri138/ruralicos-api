function clasificarFalloUltraMsg({ httpStatus = null, code = '', message = '', sent = null } = {}) {
  const status = Number(httpStatus);
  const text = `${code || ''} ${message || ''}`.toLowerCase();
  const permanentPattern = /invalid|not[ _-]?valid|bad request|unauthori|forbidden|token|instance|phone|number|blocked|blacklist|not found|empty|too long|max length/;
  const transientPattern = /tempor|timeout|timed out|rate|limit|queue|busy|unavailable|disconnect|network|reset|econn|eai_again|enotfound|server error/;
  const connectionDefinitelyFailed = /enotfound|eai_again|econnrefused/;
  const ambiguous = /timeout|timed out|etimedout|econnreset|socket hang up|terminated/.test(text);

  if (Number.isFinite(status) && status > 0) {
    if ([408, 425, 429, 500, 502, 503, 504].includes(status)) {
      return { retryable: true, permanent: false, ambiguous: false, code: code || `http_${status}` };
    }
    if (status >= 400 && status < 500) {
      return { retryable: false, permanent: true, ambiguous: false, code: code || `http_${status}` };
    }
  }

  if (connectionDefinitelyFailed.test(text)) {
    return { retryable: true, permanent: false, ambiguous: false, code: code || 'connection_failed' };
  }
  if (ambiguous) {
    return { retryable: false, permanent: false, ambiguous: true, code: code || 'transport_ambiguous' };
  }
  if (permanentPattern.test(text) || sent === false) {
    return { retryable: false, permanent: true, ambiguous: false, code: code || 'provider_rejected' };
  }
  if (transientPattern.test(text)) {
    return { retryable: true, permanent: false, ambiguous: false, code: code || 'provider_transient' };
  }
  return { retryable: false, permanent: true, ambiguous: false, code: code || 'provider_error_unknown' };
}

module.exports = { clasificarFalloUltraMsg };
