// src/utils/checkCronToken.js
function checkCronToken(req, res) {
  const authHeader = String(req.get('authorization') || '');
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const token = req.query.token || req.get('x-cron-token') || bearerToken;

  if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }

  return true;
}

module.exports = { checkCronToken };
