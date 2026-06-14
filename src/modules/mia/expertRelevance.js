const { diagnosticarAlertaUsuario } = require('../../utils/alertaMatcher');
const { extraerFeaturesAlerta } = require('../../brain/alertFeatures');
const { evaluarCalidadAlerta } = require('./alertQuality');

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function norm(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function lista(value) {
  if (Array.isArray(value)) return value.map(norm).filter(Boolean);
  if (!value) return [];
  return String(value).split(/[,;\n]/g).map(norm).filter(Boolean);
}

function textoAlerta(alerta = {}) {
  return norm([
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen,
    alerta.contenido,
    alerta.fuente,
    ...(Array.isArray(alerta.provincias) ? alerta.provincias : []),
    ...(Array.isArray(alerta.sectores) ? alerta.sectores : []),
    ...(Array.isArray(alerta.subsectores) ? alerta.subsectores : []),
    ...(Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta : []),
  ].filter(Boolean).join(' '));
}

function tieneMunicipioDeclarado(alerta = {}, user = {}) {
  const prefs = user.preferences || {};
  const municipios = [
    ...lista(prefs.municipios),
    ...lista(prefs.municipio),
    ...lista(prefs.localidades),
    ...lista(prefs.localidad),
    ...lista(prefs.terminos_municipales),
    ...lista(prefs.termino_municipal),
    ...lista(user.municipios),
    ...lista(user.municipio),
    ...lista(user.localidades),
    ...lista(user.localidad),
  ].filter((item) => item.length >= 3);

  if (municipios.length === 0) return false;
  const texto = textoAlerta(alerta);
  return municipios.some((municipio) => texto.includes(municipio));
}

function tiposActivosUsuario(user = {}) {
  return Object.entries(user.preferences?.tipos_alerta || {})
    .filter(([, active]) => active === true)
    .map(([tipo]) => norm(tipo));
}

function arrayNorm(value) {
  return Array.isArray(value) ? value.map(norm).filter(Boolean) : [];
}

function intersecta(a = [], b = []) {
  return a.some((item) => b.includes(item));
}

function sumar(scoreState, delta, code, detail = '') {
  scoreState.score += Number(delta || 0);
  scoreState.reasons.push({
    code,
    delta: Number(delta || 0),
    detail,
  });
}

function bloquear(scoreState, code, detail = '', penalty = 80) {
  scoreState.blocks.push({ code, detail });
  sumar(scoreState, -Math.abs(penalty), code, detail);
}

function resumenMatcher(base = {}) {
  return {
    ok: Boolean(base.ok),
    motivo: base.motivo || null,
    detalle: base.detalle || null,
  };
}

function senalesContenido(alerta = {}, features = []) {
  const text = textoAlerta(alerta);
  return {
    tiene_plazo: features.includes('concepto:plazo') || /\b(\d{1,2}\s+dias\s+habiles|hasta el|plazo de)\b/.test(text),
    tiene_solicitud: features.includes('accion:solicitar'),
    tiene_alegaciones: features.includes('accion:alegar'),
    es_pac: features.includes('concepto:pac'),
    es_agua: features.includes('concepto:agua_riego'),
    es_sanidad_animal: features.includes('concepto:sanidad_animal') || features.includes('concepto:bienestar_animal'),
    es_medio_ambiente: features.includes('concepto:medio_ambiente'),
    es_individual: features.includes('tramite:individual'),
    es_licitacion: features.includes('tramite:licitacion'),
    es_nombramiento: features.includes('tramite:nombramiento'),
    generico: /\b(revisar si aplica|revisar si afecta|determinar su aplicabilidad|publicacion oficial relevante|consulta el documento|sin extracto oficial suficiente)\b/.test(text),
  };
}

function veredicto(score, blocks = [], minExpertScore = 68) {
  if (blocks.length > 0) return 'bloquear';
  if (score >= minExpertScore) return 'incluir';
  if (score >= Math.max(55, minExpertScore - 10)) return 'revisar';
  return 'bloquear';
}

function evaluarRelevanciaExperta(alerta = {}, user = {}, options = {}) {
  const {
    qualityGate = true,
    minQualityScore = 65,
    minExpertScore = 68,
    allowIndividualWithoutMunicipio = false,
  } = options;

  const base = diagnosticarAlertaUsuario(alerta, user);
  const calidad = evaluarCalidadAlerta(alerta);
  const flags = Array.isArray(calidad.flags) ? calidad.flags : [];
  const features = extraerFeaturesAlerta(alerta);
  const signals = senalesContenido(alerta, features);
  const state = {
    score: 50,
    reasons: [],
    blocks: [],
  };

  if (!base.ok) {
    bloquear(state, base.motivo || 'matcher_no_coincide', 'No encaja con fuente, territorio, sector, subsector o tipo.', 90);
  } else {
    sumar(state, 12, 'matcher_coincide', 'Pasa los filtros declarados del usuario.');
  }

  if (qualityGate) {
    if (calidad.critical) bloquear(state, 'calidad_insuficiente', 'La alerta tiene flags criticos de calidad.', 90);
    if (Number(calidad.score || 0) < minQualityScore) {
      bloquear(state, 'calidad_insuficiente', `Score de calidad ${calidad.score}.`, 70);
    }
    if (flags.includes('ia_no_lista') || flags.includes('ia_atascada')) {
      bloquear(state, 'calidad_insuficiente', 'La IA no dejo la alerta lista de forma fiable.', 70);
    }
  }

  const qualityDelta = clamp((Number(calidad.score || 0) - 70) * 0.35, -22, 14);
  sumar(state, qualityDelta, 'calidad_score', `Calidad operativa ${calidad.score}.`);

  const tiposUser = tiposActivosUsuario(user);
  const tiposAlerta = arrayNorm(alerta.tipos_alerta);
  const sectoresUser = arrayNorm(user.preferences?.sectores);
  const sectoresAlerta = arrayNorm(alerta.sectores);
  const subsectoresUser = arrayNorm(user.preferences?.subsectores);
  const subsectoresAlerta = arrayNorm(alerta.subsectores);

  if (tiposUser.length && tiposAlerta.length && intersecta(tiposUser, tiposAlerta)) {
    sumar(state, 7, 'tipo_declarado_match', 'El tipo de alerta coincide con una preferencia activa.');
  }
  if (sectoresUser.length && sectoresAlerta.length && intersecta(sectoresUser, sectoresAlerta)) {
    sumar(state, 5, 'sector_declarado_match', 'El sector coincide con preferencias declaradas.');
  }
  if (subsectoresUser.length && subsectoresAlerta.length && intersecta(subsectoresUser, subsectoresAlerta)) {
    sumar(state, 6, 'subsector_declarado_match', 'El subsector coincide con preferencias declaradas.');
  }

  if (signals.es_pac) sumar(state, 10, 'pac_sigpac_fega', 'Tema PAC/FEGA/SIGPAC de alto valor recurrente.');
  if (signals.tiene_solicitud && signals.tiene_plazo) sumar(state, 12, 'accion_con_plazo', 'Tiene accion y plazo claros.');
  else if (signals.tiene_solicitud || signals.tiene_plazo) sumar(state, 7, 'accion_o_plazo', 'Tiene accion o plazo detectable.');
  if (signals.es_sanidad_animal) sumar(state, 9, 'sanidad_bienestar_animal', 'Sanidad o bienestar animal suele tener impacto operativo.');
  if (signals.es_medio_ambiente && signals.tiene_alegaciones) sumar(state, 6, 'ambiental_con_tramite', 'Tramite ambiental con alegaciones/informacion publica.');
  if (signals.es_agua && !signals.es_individual) sumar(state, 5, 'agua_general', 'Agua/riego con posible impacto amplio.');

  if (signals.es_individual) {
    const interesProvincialFuerte = allowIndividualWithoutMunicipio &&
      !signals.es_licitacion &&
      !signals.es_nombramiento &&
      !signals.generico &&
      (
        signals.es_agua ||
        signals.es_medio_ambiente ||
        signals.tiene_alegaciones ||
        signals.tiene_solicitud ||
        signals.tiene_plazo
      ) &&
      (
        (tiposUser.length && tiposAlerta.length && intersecta(tiposUser, tiposAlerta)) ||
        (subsectoresUser.length && subsectoresAlerta.length && intersecta(subsectoresUser, subsectoresAlerta))
      );

    if (tieneMunicipioDeclarado(alerta, user)) {
      sumar(state, 8, 'expediente_local_explicito', 'Expediente individual en municipio declarado por el usuario.');
    } else if (interesProvincialFuerte) {
      sumar(state, -6, 'expediente_individual_match_provincial', 'Expediente individual sin municipio declarado, pero con coincidencia fuerte por provincia, tipo y subsector.');
    } else {
      bloquear(state, 'expediente_individual_sin_municipio', 'Expediente individual sin municipio declarado por el usuario.', 55);
    }
  }

  if (signals.es_licitacion) sumar(state, -14, 'licitacion_bajo_valor', 'Licitacion/contrato suele ser ruido para explotaciones.');
  if (signals.es_nombramiento) sumar(state, -25, 'nombramiento_bajo_valor', 'Nombramientos/cargos rara vez son accionables.');
  if (signals.generico) sumar(state, -18, 'resumen_generico', 'Resumen demasiado generico para digest profesional.');

  const finalScore = clamp(Math.round(state.score));
  const finalVerdict = veredicto(finalScore, state.blocks, minExpertScore);

  return {
    version: 'mia_expert_relevance_v1',
    score: finalScore,
    veredicto: finalVerdict,
    incluir: finalVerdict === 'incluir',
    riesgo: state.blocks.length ? 'alto' : finalScore >= 78 ? 'bajo' : 'medio',
    blocks: state.blocks,
    reasons: state.reasons,
    features,
    signals,
    matcher: resumenMatcher(base),
    calidad: {
      score: calidad.score,
      grade: calidad.grade,
      flags,
      critical: Boolean(calidad.critical),
      ready_for_digest: Boolean(calidad.ready_for_digest),
    },
  };
}

module.exports = {
  evaluarRelevanciaExperta,
  tieneMunicipioDeclarado,
};
