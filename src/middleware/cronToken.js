// src/middleware/cronToken.js
const crypto = require('crypto');

function timingSafeTokenEqual(expected, received) {
  const expectedText = String(expected || '').trim();
  const receivedText = String(received || '').trim();
  if (!expectedText || !receivedText) return false;

  const expectedBuffer = Buffer.from(expectedText);
  const receivedBuffer = Buffer.from(receivedText);
  return expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function extractCronToken(req) {
  const authHeader = String(req.get('authorization') || '');
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const allowQueryToken =
    process.env.NODE_ENV !== 'production' ||
    String(process.env.ALLOW_CRON_TOKEN_QUERY || '').toLowerCase() === 'true';

  return req.get('x-cron-token') || bearerToken || (allowQueryToken ? req.query.token : null);
}

function hasCronToken(req) {
  return timingSafeTokenEqual(process.env.CRON_TOKEN, extractCronToken(req));
}

function checkCronToken(req, res) {
  if (!hasCronToken(req)) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }

  return true;
}

module.exports = {
  checkCronToken,
  extractCronToken,
  hasCronToken,
  timingSafeTokenEqual,
};
