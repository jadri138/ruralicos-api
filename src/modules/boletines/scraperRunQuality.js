function numeroBody(body, keys) {
  for (const key of keys) {
    const value = Number(body?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function textoBody(body, keys) {
  for (const key of keys) {
    const value = body?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function evaluarRespuestaScraper({
  responseOk = true,
  httpStatus = 200,
  body = null,
  fuente = '',
  endpoint = '',
} = {}) {
  const flags = [];
  const recommendations = [];

  if (!responseOk) {
    flags.push('http_error');
    recommendations.push('Revisar disponibilidad del endpoint y cambios de la fuente oficial.');
  }

  if (!body || typeof body !== 'object') {
    flags.push('respuesta_vacia');
    recommendations.push('El scraper debe devolver JSON operativo con metricas.');
  } else if (body.raw) {
    flags.push('respuesta_no_json');
    recommendations.push('El endpoint devolvio texto/HTML en vez de JSON.');
  }

  const errores = numeroBody(body, ['errores']) || 0;
  if (errores > 0 || body?.error) {
    flags.push('errores_reportados');
    recommendations.push('Revisar error interno del scraper.');
  }

  const nuevas = numeroBody(body, ['nuevas']);
  const duplicadas = numeroBody(body, ['duplicadas']);
  const relevantes = numeroBody(body, ['relevantes', 'documentos_insertables', 'coincidencias']);
  const totales = numeroBody(body, ['totales', 'total', 'documentos', 'documentos_totales']);
  const tieneMetricasVolumen = [nuevas, duplicadas, relevantes, totales].some((value) => value !== null);

  if (responseOk && !tieneMetricasVolumen) {
    flags.push('sin_metrica_volumen');
    recommendations.push('Incluir nuevas/duplicadas/relevantes/totales en la respuesta del scraper.');
  }

  const volumen = [nuevas, duplicadas, relevantes, totales]
    .filter((value) => value !== null)
    .reduce((sum, value) => sum + Number(value || 0), 0);
  const mensaje = textoBody(body, ['mensaje', 'message']);
  const mensajeSinDocs = /no hay|sin documentos|sin alertas|no se encontraron/i.test(mensaje);

  if (responseOk && tieneMetricasVolumen && volumen === 0 && !mensajeSinDocs) {
    flags.push('sin_volumen_no_explicado');
    recommendations.push('Confirmar si la fuente realmente no publico nada o si fallo el parseo.');
  }

  const severity = !responseOk || flags.includes('respuesta_vacia') || flags.includes('respuesta_no_json') || flags.includes('errores_reportados')
    ? 'error'
    : flags.length > 0
      ? 'warning'
      : 'ok';

  return {
    ok: severity === 'ok',
    severity,
    fuente: fuente || null,
    endpoint: endpoint || null,
    http_status: httpStatus,
    flags,
    metrics: {
      nuevas: nuevas ?? 0,
      duplicadas: duplicadas ?? 0,
      relevantes: relevantes ?? null,
      totales: totales ?? null,
      errores,
    },
    recommendations: [...new Set(recommendations)].slice(0, 5),
  };
}

function statusDesdeCalidadScraper(responseOk, body, context = {}) {
  const quality = evaluarRespuestaScraper({ responseOk, body, ...context });
  return quality.severity;
}

module.exports = {
  evaluarRespuestaScraper,
  statusDesdeCalidadScraper,
};
