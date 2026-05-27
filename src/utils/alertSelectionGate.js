const { diagnosticarAlertaUsuario } = require('./alertaMatcher');
const { evaluarCalidadAlerta } = require('../mia/alertQuality');
const { evaluarRelevanciaExperta } = require('../mia/expertRelevance');

function nivelRiesgoDecision({ base, calidad, exclusion, exclusionCalidad }) {
  if (!base?.ok) return 'alto';
  if (exclusionCalidad || calidad?.critical) return 'alto';
  if (exclusion) return 'medio';
  if (Number(calidad?.score || 0) < 75) return 'medio';
  return 'bajo';
}

function resumirCalidad(calidad = {}) {
  return {
    score: calidad.score,
    grade: calidad.grade,
    flags: Array.isArray(calidad.flags) ? calidad.flags : [],
    critical: Boolean(calidad.critical),
    ready_for_digest: Boolean(calidad.ready_for_digest),
  };
}

function normalizarTextoLocal(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function listaPreferencia(value) {
  if (Array.isArray(value)) return value.map(normalizarTextoLocal).filter((item) => item.length >= 3);
  if (!value) return [];
  return String(value)
    .split(/[,;\n]/g)
    .map(normalizarTextoLocal)
    .filter((item) => item.length >= 3);
}

function textoAlerta(alerta = {}) {
  return normalizarTextoLocal([
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen,
    alerta.contenido,
  ].filter(Boolean).join(' '));
}

function tieneInteresLocalExplicito(alerta = {}, user = {}) {
  const prefs = user.preferences || {};
  const municipios = [
    ...listaPreferencia(prefs.municipios),
    ...listaPreferencia(prefs.municipio),
    ...listaPreferencia(prefs.localidades),
    ...listaPreferencia(prefs.localidad),
    ...listaPreferencia(prefs.terminos_municipales),
    ...listaPreferencia(prefs.termino_municipal),
    ...listaPreferencia(user.municipios),
    ...listaPreferencia(user.municipio),
    ...listaPreferencia(user.localidades),
    ...listaPreferencia(user.localidad),
  ];

  if (municipios.length === 0) return false;
  const texto = textoAlerta(alerta);
  return municipios.some((municipio) => texto.includes(municipio));
}

function bloqueoCalidadDigest({ calidad, alerta, user, qualityGate, minQualityScore }) {
  if (!qualityGate) return null;

  const flags = Array.isArray(calidad?.flags) ? calidad.flags : [];
  if (calidad?.critical) return 'calidad_insuficiente';
  if (Number(calidad?.score || 0) < minQualityScore) return 'calidad_insuficiente';
  if (flags.includes('ia_no_lista') || flags.includes('ia_atascada')) return 'calidad_insuficiente';

  if (flags.includes('expediente_individual') && !tieneInteresLocalExplicito(alerta, user)) {
    return 'expediente_individual_sin_municipio';
  }

  return null;
}

function decidirAlertaParaDigest(alerta, user, options = {}) {
  const {
    qualityGate = true,
    minQualityScore = 65,
    minExpertScore = 68,
    exclusionPreferencias = null,
  } = options;

  const base = diagnosticarAlertaUsuario(alerta, user);
  const calidad = evaluarCalidadAlerta(alerta);
  const experto = evaluarRelevanciaExperta(alerta, user, {
    qualityGate,
    minQualityScore,
    minExpertScore,
  });
  const bloqueoCalidad = base.ok
    ? bloqueoCalidadDigest({ calidad, alerta, user, qualityGate, minQualityScore })
    : null;
  const bloqueoExperto = base.ok && !bloqueoCalidad
    ? (
      experto.blocks?.[0]?.code ||
      (experto.veredicto === 'bloquear'
        ? 'relevancia_experta_baja'
        : experto.veredicto === 'revisar'
          ? 'relevancia_experta_para_revisar'
          : null)
    )
    : null;
  const exclusion = base.ok && typeof exclusionPreferencias === 'function'
    ? exclusionPreferencias(alerta)
    : null;
  const incluir = Boolean(base.ok && !exclusion && !bloqueoCalidad && !bloqueoExperto && experto.veredicto === 'incluir');
  const motivo = incluir
    ? 'incluida'
    : (bloqueoCalidad || bloqueoExperto || exclusion?.motivo || base.motivo || 'no_incluir');

  return {
    incluir,
    motivo,
    riesgo: experto.riesgo || nivelRiesgoDecision({ base, calidad, exclusion, exclusionCalidad: Boolean(bloqueoCalidad || bloqueoExperto) }),
    detalle: exclusion || base.detalle || null,
    diagnostico: {
      matcher: base.motivo || null,
      calidad: resumirCalidad(calidad),
      experto: {
        score: experto.score,
        veredicto: experto.veredicto,
        blocks: experto.blocks,
        reasons: experto.reasons.slice(0, 8),
        features: experto.features,
      },
    },
  };
}

function anotarDecisionAlerta(alerta, decision) {
  return {
    ...alerta,
    decision_digest: decision,
    motivo_seleccion_mia: decision?.incluir
      ? `incluida:${decision.motivo}:riesgo_${decision.riesgo}`
      : `excluida:${decision?.motivo || 'desconocido'}`,
  };
}

function filtrarAlertasParaDigest(alertas = [], user, options = {}) {
  const decisiones = [];
  const incluidas = [];
  const excluidas = [];

  for (const alerta of alertas || []) {
    const decision = decidirAlertaParaDigest(alerta, user, options);
    const anotada = anotarDecisionAlerta(alerta, decision);
    const item = {
      id: alerta.id,
      titulo: alerta.titulo,
      fuente: alerta.fuente || 'BOE',
      ...decision,
    };

    decisiones.push(item);
    if (decision.incluir) incluidas.push(anotada);
    else excluidas.push(item);
  }

  return {
    alertas: incluidas,
    decisiones,
    excluidas,
    resumen: decisiones.reduce((acc, item) => {
      const key = item.incluir ? 'incluidas' : item.motivo;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
}

module.exports = {
  decidirAlertaParaDigest,
  filtrarAlertasParaDigest,
  anotarDecisionAlerta,
};
