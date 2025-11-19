// src/utils/checkCronToken.js
function checkCronToken(req, res) {
  const token = req.query.token;

  if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }

  return true;
}

module.exports = { checkCronToken };
