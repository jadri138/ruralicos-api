function getFechaMadridISO(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getFechaMadridYYYYMMDD(date = new Date()) {
  return getFechaMadridISO(date).replace(/-/g, '');
}

function getOffsetMadridMs(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    timeZoneName: 'shortOffset',
  }).formatToParts(date);

  const value = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT+0';
  const match = value.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return 0;

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  return sign * ((hours * 60) + minutes) * 60 * 1000;
}

function getRangoDiaMadridUTC(fechaISO = getFechaMadridISO()) {
  const [year, month, day] = fechaISO.split('-').map(Number);
  const inicioBase = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const finBase = new Date(Date.UTC(year, month - 1, day + 1, 12, 0, 0));
  const inicioLocal = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - getOffsetMadridMs(inicioBase));
  const finLocal = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0) - getOffsetMadridMs(finBase));
  return {
    inicio: inicioLocal.toISOString(),
    fin: finLocal.toISOString(),
  };
}

module.exports = {
  getFechaMadridISO,
  getFechaMadridYYYYMMDD,
  getRangoDiaMadridUTC,
};
