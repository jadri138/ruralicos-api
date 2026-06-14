const { diagnosticarAlertaUsuario } = require('./alertaMatcher');
const { evaluarCalidadAlerta } = require('../../mia/alertQuality');
const { extraerFeaturesAlerta, textoAlerta: textoFeaturesAlerta } = require('../../aprendizaje/alertFeatures');
const { clasificarPrioridadAlerta, pesoPrioridad } = require('../../aprendizaje/alertPriority');
const {
  canonicalSector,
  canonicalSubsector,
  canonicalTipoAlerta,
} = require('../../../shared/preferenceCanonical');

const DEFAULT_POLICY = {
  minIncludeScore: 64,
  minReviewScore: 56,
  minQualityScore: 58,
  minReviewQualityScore: 78,
  relaxedFillMinScore: 76,
  targetItems: 5,
  minItems: 3,
  maxItems: 7,
  maxPerFuente: 3,
  maxPerTipo: 2,
  maxIndividualItems: 2,
  qualityGate: true,
  allowReview: true,
  allowIndividualWithoutMunicipio: true,
};

const CRITICAL_BLOCK_FLAGS = new Set([
  'duplicada',
  'descartada',
  'sin_titulo',
  'sin_url',
  'url_invalida',
  'sin_resumen_util',
  'listo_sin_resumen_final',
  'ia_no_lista',
  'ia_atascada',
  'titulo_boletin_raw',
  'proceso_personal_publico',
  'pesca_maritimo_no_agrario',
  'administracion_general_no_agraria',
  'notificacion_individual',
  'personal_investigador_beca',
  'resumen_boilerplate_portal',
]);

function clamp(value, min, max) {
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

function lista(value, canonicalizer = norm) {
  if (Array.isArray(value)) return value.map(canonicalizer).filter(Boolean);
  if (!value) return [];
  return String(value).split(/[,;\n]/g).map(canonicalizer).filter(Boolean);
}

const MARCADORES_NACIONALES = new Set(['nacional', 'espana', 'españa', 'estatal', 'todas', 'todo el territorio nacional']);

function intersecta(a = [], b = []) {
  return a.some((item) => b.includes(item));
}

function tiposActivosUsuario(user = {}) {
  return Object.entries(user.preferences?.tipos_alerta || {})
    .filter(([, active]) => active === true)
    .map(([tipo]) => canonicalTipoAlerta(tipo))
    .filter(Boolean);
}

function textoAlerta(alerta = {}) {
  return textoFeaturesAlerta(alerta);
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

function detectarExclusionPreferencias(alerta, exclusionPreferencias) {
  if (typeof exclusionPreferencias !== 'function') return null;
  return exclusionPreferencias(alerta) || null;
}

function construirSignals(alerta = {}, calidad = {}) {
  const features = extraerFeaturesAlerta(alerta);
  const flags = Array.isArray(calidad.flags) ? calidad.flags : [];
  const texto = textoAlerta(alerta);

  return {
    features,
    flags,
    tiene_plazo: features.includes('concepto:plazo') || /\b(plazo|hasta el|dias habiles|alegaciones)\b/.test(texto),
    tiene_solicitud: features.includes('accion:solicitar'),
    tiene_subsanacion: features.includes('accion:subsanar'),
    tiene_alegaciones: features.includes('accion:alegar'),
    es_ayuda: features.includes('concepto:ayuda_directa'),
    es_pac: features.includes('concepto:pac'),
    es_agua: features.includes('concepto:agua_riego'),
    es_sanidad_animal: features.includes('concepto:sanidad_animal') || features.includes('concepto:bienestar_animal'),
    es_medio_ambiente: features.includes('concepto:medio_ambiente'),
    es_individual: features.includes('tramite:individual') || flags.includes('expediente_individual'),
    es_licitacion: features.includes('tramite:licitacion'),
    es_nombramiento: features.includes('tramite:nombramiento'),
    generico: /\b(revisar si aplica|revisar si afecta|determinar su aplicabilidad|publicacion oficial relevante|consulta el documento|sin extracto oficial suficiente)\b/.test(texto),
  };
}

function coincidenciasDeclaradas(alerta = {}, user = {}) {
  const prefs = user.preferences || {};
  const provinciasUser = lista(prefs.provincias);
  const sectoresUser = lista(prefs.sectores, canonicalSector);
  const subsectoresUser = lista(prefs.subsectores, canonicalSubsector);
  const tiposUser = tiposActivosUsuario(user);
  const provinciasAlerta = lista(alerta.provincias);
  const sectoresAlerta = lista(alerta.sectores, canonicalSector);
  const subsectoresAlerta = lista(alerta.subsectores, canonicalSubsector);
  const tiposAlerta = lista(alerta.tipos_alerta, canonicalTipoAlerta);
  const alertaNacional = provinciasAlerta.some((provincia) => MARCADORES_NACIONALES.has(provincia));

  return {
    provincia: provinciasUser.length === 0 || alertaNacional || intersecta(provinciasUser, provinciasAlerta),
    provincia_expresa: provinciasUser.length > 0 && !alertaNacional && intersecta(provinciasUser, provinciasAlerta),
    provincia_nacional: alertaNacional,
    sector: sectoresUser.length === 0 || sectoresAlerta.length === 0 || intersecta(sectoresUser, sectoresAlerta),
    sector_expreso: sectoresUser.length > 0 && sectoresAlerta.length > 0 && intersecta(sectoresUser, sectoresAlerta),
    subsector: subsectoresUser.length === 0 || subsectoresAlerta.length === 0 || intersecta(subsectoresUser, subsectoresAlerta),
    subsector_expreso: subsectoresUser.length > 0 && subsectoresAlerta.length > 0 && intersecta(subsectoresUser, subsectoresAlerta),
    tipo: tiposUser.length === 0 || tiposAlerta.length === 0 || intersecta(tiposUser, tiposAlerta),
    tipo_expreso: tiposUser.length > 0 && tiposAlerta.length > 0 && intersecta(tiposUser, tiposAlerta),
  };
}

function tieneInteresProvincialFuerte({ signals, matches }) {
  if (!signals.es_individual) return false;
  if (signals.es_licitacion || signals.es_nombramiento || signals.generico) return false;

  const accionable = signals.es_agua ||
    signals.es_medio_ambiente ||
    signals.tiene_alegaciones ||
    signals.tiene_solicitud ||
    signals.tiene_subsanacion ||
    signals.tiene_plazo;

  if (!accionable) return false;
  return Boolean(matches.tipo_expreso || matches.subsector_expreso);
}

function sumar(score, reasons, delta, code, detail) {
  const value = Number(delta || 0);
  reasons.push({ code, delta: value, detail });
  return score + value;
}

function aplicarBloqueosDuros({ base, calidad, signals, exclusion, matches, user, alerta, policy }) {
  const blocks = [];
  const flags = Array.isArray(calidad.flags) ? calidad.flags : [];

  if (!base.ok) {
    blocks.push({ code: base.motivo || 'matcher_no_coincide', detail: 'No pasa fuente, territorio, sector, subsector o tipo declarado.' });
  }

  if (exclusion) {
    blocks.push({ code: exclusion.motivo || 'preferencias_extra_excluye', detail: exclusion.termino || 'Exclusion explicita del usuario.' });
  }

  if (policy.qualityGate) {
    if (calidad.critical || flags.some((flag) => CRITICAL_BLOCK_FLAGS.has(flag))) {
      blocks.push({ code: 'calidad_critica', detail: flags.filter((flag) => CRITICAL_BLOCK_FLAGS.has(flag)).join(', ') || 'Calidad critica.' });
    }

    if (Number(calidad.score || 0) < policy.minQualityScore) {
      blocks.push({ code: 'calidad_insuficiente', detail: `Score de calidad ${calidad.score}.` });
    }
  }

  if (signals.es_licitacion) {
    blocks.push({ code: 'licitacion_bajo_valor', detail: 'Licitacion, contrato o formalizacion no accionable para explotaciones.' });
  }

  if (signals.es_nombramiento) {
    blocks.push({ code: 'nombramiento_bajo_valor', detail: 'Nombramientos y cargos no son alertas operativas.' });
  }

  const municipio = tieneMunicipioDeclarado(alerta, user);
  const interesProvincial = policy.allowIndividualWithoutMunicipio && tieneInteresProvincialFuerte({ signals, matches });

  if (signals.es_individual && !municipio && !interesProvincial) {
    blocks.push({ code: 'expediente_individual_sin_municipio', detail: 'Expediente individual sin municipio declarado ni coincidencia provincial fuerte.' });
  }

  return {
    blocks,
    municipio,
    interesProvincial,
  };
}

function calcularScore({ alerta, base, calidad, signals, matches, municipio, interesProvincial }) {
  const reasons = [];
  let score = 0;
  const prioridad = clasificarPrioridadAlerta(alerta);

  if (base.ok) score = sumar(score, reasons, 28, 'matcher_coincide', 'Pasa preferencias duras del usuario.');

  score = sumar(
    score,
    reasons,
    clamp((Number(calidad.score || 0) - 55) * 0.42, -20, 18),
    'calidad_score',
    `Calidad operativa ${calidad.score}.`
  );

  if (matches.provincia_expresa) score = sumar(score, reasons, 15, 'provincia_declarada', 'Coincide provincia declarada.');
  else if (matches.provincia) score = sumar(score, reasons, 8, 'territorio_admisible', 'Territorio admisible por preferencias.');

  if (matches.sector_expreso) score = sumar(score, reasons, 10, 'sector_declarado', 'Coincide sector declarado.');
  if (matches.subsector_expreso) score = sumar(score, reasons, 12, 'subsector_declarado', 'Coincide subsector declarado.');
  if (matches.tipo_expreso) score = sumar(score, reasons, 12, 'tipo_declarado', 'Coincide tipo de alerta activo.');

  if (signals.es_ayuda) score = sumar(score, reasons, 12, 'ayuda_subvencion', 'Ayuda, subvencion, pago o convocatoria.');
  if (signals.es_pac) score = sumar(score, reasons, 10, 'pac_fega_sigpac', 'Tema PAC/FEGA/SIGPAC.');
  if (signals.tiene_solicitud && signals.tiene_plazo) score = sumar(score, reasons, 12, 'accion_con_plazo', 'Tiene accion y plazo claros.');
  else if (signals.tiene_solicitud || signals.tiene_plazo) score = sumar(score, reasons, 7, 'accion_o_plazo', 'Tiene accion o plazo detectable.');
  if (signals.tiene_subsanacion) score = sumar(score, reasons, 8, 'subsanacion', 'Requerimiento o subsanacion accionable.');
  if (signals.tiene_alegaciones) score = sumar(score, reasons, 6, 'alegaciones', 'Tramite de alegaciones/informacion publica.');
  if (signals.es_sanidad_animal) score = sumar(score, reasons, 10, 'sanidad_bienestar_animal', 'Sanidad o bienestar animal operativo.');
  if (signals.es_agua && !signals.es_individual) score = sumar(score, reasons, 6, 'agua_general', 'Agua/riego de posible impacto amplio.');
  if (signals.es_medio_ambiente && signals.tiene_alegaciones) score = sumar(score, reasons, 6, 'ambiental_con_tramite', 'Medio ambiente con tramite accionable.');

  const prioridadPeso = (pesoPrioridad(prioridad.prioridad) + prioridad.score) / 10;
  score = sumar(score, reasons, clamp(prioridadPeso, -8, 12), `prioridad_${prioridad.prioridad}`, prioridad.motivos.join(', ') || 'Prioridad operativa.');

  if (Number.isFinite(Number(alerta.similitud))) {
    score = sumar(score, reasons, clamp(Number(alerta.similitud) * 12, 0, 12), 'similitud_vectorial', `Similitud ${Number(alerta.similitud).toFixed(3)}.`);
  }

  if (Number.isFinite(Number(alerta.mia_profile_score))) {
    score = sumar(score, reasons, clamp(Number(alerta.mia_profile_score) * 2, -14, 14), 'perfil_operativo_mia', `Score perfil ${alerta.mia_profile_score}.`);
  }

  if (signals.es_individual) {
    if (municipio) score = sumar(score, reasons, 10, 'expediente_municipio_declarado', 'Expediente individual en municipio declarado.');
    else if (interesProvincial) score = sumar(score, reasons, -10, 'expediente_provincial_fuerte', 'Expediente individual con coincidencia provincial fuerte.');
  }

  if (signals.generico) score = sumar(score, reasons, -15, 'resumen_generico', 'Resumen demasiado generico.');

  return {
    score: Math.round(clamp(score, 0, 100)),
    reasons,
    prioridad,
  };
}

function puedeSerRevisionSegura({ score, calidad, signals, policy }) {
  if (!policy.allowReview) return false;
  if (score < policy.minReviewScore) return false;
  if (policy.qualityGate && Number(calidad?.score || 0) < policy.minReviewQualityScore) return false;
  if (calidad?.critical) return false;

  if (signals.es_individual || signals.es_licitacion || signals.es_nombramiento || signals.generico) {
    return false;
  }

  return Boolean(
    signals.tiene_solicitud ||
    signals.tiene_plazo ||
    signals.tiene_subsanacion ||
    signals.tiene_alegaciones ||
    signals.es_pac ||
    signals.es_agua ||
    signals.es_sanidad_animal ||
    signals.es_medio_ambiente
  );
}

function clasificarDecision({ score, blocks, signals, calidad, policy }) {
  if (blocks.length > 0) return { action: 'exclude', motivo: blocks[0].code, riesgo: 'alto' };
  if (score >= policy.minIncludeScore) return { action: 'include', motivo: 'incluida', riesgo: signals.es_individual ? 'medio' : 'bajo' };
  if (puedeSerRevisionSegura({ score, calidad, signals, policy })) return { action: 'review', motivo: 'revision_segura', riesgo: 'medio' };
  return { action: 'exclude', motivo: 'score_insuficiente', riesgo: 'medio' };
}

function normalizarPolicy(options = {}) {
  const policy = { ...DEFAULT_POLICY, ...options };
  policy.minIncludeScore = clamp(policy.minIncludeScore, 1, 100);
  policy.minReviewScore = clamp(policy.minReviewScore, 1, policy.minIncludeScore);
  policy.minQualityScore = clamp(policy.minQualityScore, 0, 100);
  policy.minReviewQualityScore = clamp(
    policy.minReviewQualityScore ?? options.minReviewQualityScore,
    policy.minQualityScore,
    100
  );
  policy.relaxedFillMinScore = clamp(policy.relaxedFillMinScore, policy.minIncludeScore, 100);
  policy.maxItems = Math.max(1, Math.min(10, Number(policy.maxItems || DEFAULT_POLICY.maxItems)));
  policy.minItems = Math.max(1, Math.min(policy.maxItems, Number(policy.minItems || DEFAULT_POLICY.minItems)));
  policy.targetItems = Math.max(policy.minItems, Math.min(policy.maxItems, Number(policy.targetItems || DEFAULT_POLICY.targetItems)));
  policy.maxPerFuente = Math.max(1, Number(policy.maxPerFuente || DEFAULT_POLICY.maxPerFuente));
  policy.maxPerTipo = Math.max(1, Number(policy.maxPerTipo || DEFAULT_POLICY.maxPerTipo));
  policy.maxIndividualItems = Math.max(0, Number(policy.maxIndividualItems ?? DEFAULT_POLICY.maxIndividualItems));
  return policy;
}

function evaluarAlertaParaDigest(alerta, user, options = {}) {
  const policy = normalizarPolicy(options);
  const base = diagnosticarAlertaUsuario(alerta, user);
  const calidad = evaluarCalidadAlerta(alerta);
  const signals = construirSignals(alerta, calidad);
  const matches = coincidenciasDeclaradas(alerta, user);
  const exclusion = detectarExclusionPreferencias(alerta, policy.exclusionPreferencias);
  const bloqueo = aplicarBloqueosDuros({ base, calidad, signals, exclusion, matches, user, alerta, policy });
  const scoring = calcularScore({
    alerta,
    base,
    calidad,
    signals,
    matches,
    municipio: bloqueo.municipio,
    interesProvincial: bloqueo.interesProvincial,
  });
  const verdict = clasificarDecision({ score: scoring.score, blocks: bloqueo.blocks, signals, calidad, policy });
  const incluir = verdict.action === 'include' || verdict.action === 'review';

  return {
    incluir,
    action: verdict.action,
    motivo: verdict.motivo,
    riesgo: verdict.riesgo,
    score: scoring.score,
    detalle: exclusion || base.detalle || null,
    diagnostico: {
      matcher: base.motivo || null,
      calidad: {
        score: calidad.score,
        grade: calidad.grade,
        flags: signals.flags,
        critical: Boolean(calidad.critical),
        ready_for_digest: Boolean(calidad.ready_for_digest),
      },
      policy: {
        blocks: bloqueo.blocks,
        matches,
        signals: {
          es_individual: signals.es_individual,
          es_licitacion: signals.es_licitacion,
          es_nombramiento: signals.es_nombramiento,
          generico: signals.generico,
          municipio_declarado: bloqueo.municipio,
          interes_provincial_fuerte: bloqueo.interesProvincial,
        },
      },
      ranking: {
        score: scoring.score,
        reasons: scoring.reasons,
        prioridad: scoring.prioridad,
        features: signals.features,
      },
    },
  };
}

function tipoPrincipal(alerta = {}) {
  const tipos = lista(alerta.tipos_alerta, canonicalTipoAlerta);
  return tipos[0] || 'sin_tipo';
}

function fuentePrincipal(alerta = {}) {
  return norm(alerta.fuente || 'sin_fuente') || 'sin_fuente';
}

function crearAnotacion(alerta, decision, origen = 'selection_engine_v2') {
  return {
    ...alerta,
    decision_digest: decision,
    motivo_seleccion_mia: decision?.incluir
      ? `${origen}:incluida:score_${decision.score}:riesgo_${decision.riesgo}`
      : `${origen}:excluida:${decision?.motivo || 'desconocido'}:score_${decision?.score ?? 0}`,
  };
}

function pickDiversificado(candidatas, policy) {
  const selected = [];
  const used = new Set();
  const countFuente = new Map();
  const countTipo = new Map();
  let individualCount = 0;

  const tryAdd = (item, mode = 'strict') => {
    const id = Number(item.alerta.id);
    if (!Number.isFinite(id) || used.has(id)) return false;

    const fuente = fuentePrincipal(item.alerta);
    const tipo = tipoPrincipal(item.alerta);
    const individual = Boolean(item.decision.diagnostico?.policy?.signals?.es_individual);
    const strict = mode === 'strict';
    const relaxed = mode === 'relaxed';

    if (individual && individualCount >= policy.maxIndividualItems) return false;
    if (relaxed && item.decision.score < policy.relaxedFillMinScore) return false;

    if (strict) {
      if ((countFuente.get(fuente) || 0) >= policy.maxPerFuente) return false;
      if ((countTipo.get(tipo) || 0) >= policy.maxPerTipo) return false;
    }

    selected.push(item);
    used.add(id);
    countFuente.set(fuente, (countFuente.get(fuente) || 0) + 1);
    countTipo.set(tipo, (countTipo.get(tipo) || 0) + 1);
    if (individual) individualCount++;
    return true;
  };

  for (const item of candidatas) {
    if (selected.length >= policy.targetItems) break;
    tryAdd(item, 'strict');
  }

  if (selected.length < policy.minItems) {
    for (const item of candidatas) {
      if (selected.length >= policy.minItems) break;
      tryAdd(item, 'minimum');
    }
  }

  if (selected.length < policy.targetItems) {
    for (const item of candidatas) {
      if (selected.length >= policy.targetItems) break;
      tryAdd(item, 'relaxed');
    }
  }

  if (selected.length < policy.maxItems) {
    for (const item of candidatas) {
      if (selected.length >= policy.maxItems) break;
      if (item.decision.score < policy.minIncludeScore) continue;
      tryAdd(item, 'strict');
    }
  }

  return selected;
}

function resumenDecisiones(decisiones = []) {
  return decisiones.reduce((acc, item) => {
    const key = item.incluir ? 'incluidas' : item.motivo;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function seleccionarAlertasParaDigest(alertas = [], user, options = {}) {
  const policy = normalizarPolicy(options);
  const evaluadas = (alertas || []).map((alerta) => {
    const decision = evaluarAlertaParaDigest(alerta, user, policy);
    return {
      alerta,
      decision,
      item: {
        id: alerta.id,
        titulo: alerta.titulo,
        fuente: alerta.fuente || 'BOE',
        ...decision,
      },
    };
  });

  const candidatas = evaluadas
    .filter((item) => item.decision.incluir)
    .sort((a, b) => b.decision.score - a.decision.score || Number(a.alerta.id || 0) - Number(b.alerta.id || 0));

  const seleccionadas = pickDiversificado(candidatas, policy);
  const selectedIds = new Set(seleccionadas.map((item) => Number(item.alerta.id)).filter(Number.isFinite));
  const decisiones = evaluadas.map((item) => {
    if (!selectedIds.has(Number(item.alerta.id)) && item.decision.incluir) {
      return {
        ...item.item,
        incluir: false,
        action: 'exclude',
        motivo: 'fuera_por_diversidad',
      };
    }
    return item.item;
  });

  return {
    alertas: seleccionadas.map((item) => crearAnotacion(item.alerta, item.decision, policy.origen || 'selection_engine_v2')),
    decisiones,
    excluidas: decisiones.filter((item) => !item.incluir),
    resumen: resumenDecisiones(decisiones),
  };
}

function filtrarAlertasParaDigest(alertas = [], user, options = {}) {
  const policy = normalizarPolicy(options);
  const decisiones = [];
  const incluidas = [];
  const excluidas = [];

  for (const alerta of alertas || []) {
    const decision = evaluarAlertaParaDigest(alerta, user, policy);
    const item = {
      id: alerta.id,
      titulo: alerta.titulo,
      fuente: alerta.fuente || 'BOE',
      ...decision,
    };
    decisiones.push(item);
    if (decision.incluir) incluidas.push(crearAnotacion(alerta, decision, policy.origen || 'selection_engine_v2'));
    else excluidas.push(item);
  }

  return {
    alertas: incluidas,
    decisiones,
    excluidas,
    resumen: resumenDecisiones(decisiones),
  };
}

function decidirAlertaParaDigest(alerta, user, options = {}) {
  return evaluarAlertaParaDigest(alerta, user, options);
}

function anotarDecisionAlerta(alerta, decision) {
  return crearAnotacion(alerta, decision);
}

function puedeIncluirRevisionSegura(decision = {}, calidad = {}, options = {}) {
  const policy = normalizarPolicy(options);
  const features = Array.isArray(decision.features) ? decision.features : [];
  if (!policy.allowReview) return false;
  if (decision.veredicto && decision.veredicto !== 'revisar') return false;
  if (Array.isArray(decision.blocks) && decision.blocks.length > 0) return false;
  if (calidad?.critical) return false;
  if (Number(decision.score || policy.minReviewScore) < policy.minReviewScore) return false;
  if (policy.qualityGate && Number(calidad?.score || 0) < policy.minReviewQualityScore) return false;

  const signals = decision.signals || {};
  if (
    signals.es_individual ||
    signals.es_licitacion ||
    signals.es_nombramiento ||
    signals.generico ||
    features.includes('tramite:individual') ||
    features.includes('tramite:licitacion') ||
    features.includes('tramite:nombramiento')
  ) {
    return false;
  }

  return Boolean(signals.tiene_solicitud || signals.tiene_plazo || signals.es_pac || signals.es_agua || signals.es_sanidad_animal || signals.es_medio_ambiente);
}

module.exports = {
  DEFAULT_POLICY,
  decidirAlertaParaDigest,
  evaluarAlertaParaDigest,
  filtrarAlertasParaDigest,
  seleccionarAlertasParaDigest,
  anotarDecisionAlerta,
  puedeIncluirRevisionSegura,
  normalizarPolicy,
};
