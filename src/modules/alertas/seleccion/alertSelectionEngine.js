const {
  diagnosticarAlertaUsuario,
  esAlertaNacional,
  provinciasDerivadasAlerta,
  sectoresDerivadosAlerta,
  subsectoresDerivadosAlerta,
  tiposDerivadosAlerta,
} = require('./alertaMatcher');
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

function sectoresCompatiblesDeclarados(sectoresUser = [], sectoresAlerta = []) {
  if (intersecta(sectoresUser, sectoresAlerta)) return true;
  const agrarios = ['agricultura', 'ganaderia'];
  return (sectoresUser.includes('mixto') && intersecta(agrarios, sectoresAlerta)) ||
    (sectoresAlerta.includes('mixto') && intersecta(agrarios, sectoresUser));
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

function textoAlertaSinAccionGenerica(alerta = {}) {
  const resumenFinal = String(alerta.resumen_final || '')
    .split(/\r?\n/g)
    .filter((linea) => !/^\s*ACCION\s*:/i.test(linea))
    .join('\n');

  return textoFeaturesAlerta({
    ...alerta,
    resumen_final: resumenFinal,
  });
}

function clasificarIntencionOperativa({ texto = '', features = [], plazoNoVerificado = false, tienePlazoVerificable = false, esConvocatoriaAyuda = false } = {}) {
  const reasons = [];
  const tieneSolicitud = features.includes('accion:solicitar');
  const tieneSubsanacion = features.includes('accion:subsanar');
  const tieneAlegaciones = features.includes('accion:alegar');
  const tieneJustificacion = features.includes('accion:justificar');
  const tieneDeclaracion = features.includes('accion:declarar');
  const tieneRecurso = features.includes('accion:recurrir');
  const esLicitacion = features.includes('tramite:licitacion');
  const esNombramiento = features.includes('tramite:nombramiento');

  const esObligacionOperativa = /\b(debera[n]?|obligacion(?:es)?|requisito(?:s)? obligatorio(?:s)?|nueva obligacion|medidas obligatorias|declaracion obligatoria|comunicacion obligatoria|inscripcion obligatoria|prohibicion|restriccion(?:es)? de movimiento|plan sanitario|programa sanitario)\b/.test(texto);
  const esResolucionExPost = /\b(resolucion definitiva|resolucion de concesion|concesion de subvenciones|relacion de beneficiarios|beneficiarios definitivos|pago de la ayuda|se ordena el pago|abono de la ayuda|pago compensatorio|lista definitiva|se publica la relacion)\b/.test(texto) &&
    !/\b(se convocan|convocatoria|solicitud|presentar solicitud|subsanacion|recurso de alzada|recurso de reposicion|alegaciones|justificacion|cuenta justificativa)\b/.test(texto);
  const esSancionControl = /\b(procedimiento sancionador|sancion|sanciones|multa|reintegro|control sobre el terreno|inspeccion|incumplimiento|penalizacion|perdida del derecho al cobro)\b/.test(texto);
  const esInformativaPura = /\b(se informa|publicacion informativa|informe anual|estadistica|memoria anual|extracto estadistico|anuncio informativo)\b/.test(texto) &&
    !tieneSolicitud && !tieneSubsanacion && !tieneAlegaciones && !tieneJustificacion && !tieneRecurso && !esObligacionOperativa;

  let fase = 'informativa';
  let valor = 'medio';
  let accionabilidad = 'media';

  if (esLicitacion || esNombramiento) {
    fase = esLicitacion ? 'licitacion' : 'nombramiento';
    valor = 'bajo';
    accionabilidad = 'baja';
    reasons.push(esLicitacion ? 'licitacion' : 'nombramiento');
  } else if (esSancionControl) {
    fase = 'control_sancion';
    valor = 'bajo';
    accionabilidad = 'baja';
    reasons.push('control_sancion');
  } else if (esResolucionExPost) {
    fase = 'resolucion_pago';
    valor = 'bajo';
    accionabilidad = 'baja';
    reasons.push('resolucion_ex_post');
  } else if (tieneSubsanacion) {
    fase = 'subsanacion';
    valor = 'alto';
    accionabilidad = 'alta';
    reasons.push('subsanacion');
  } else if (tieneJustificacion) {
    fase = 'justificacion';
    valor = 'alto';
    accionabilidad = 'alta';
    reasons.push('justificacion');
  } else if (tieneRecurso) {
    fase = 'recurso';
    valor = 'medio';
    accionabilidad = 'media';
    reasons.push('recurso');
  } else if (tieneAlegaciones) {
    fase = 'alegaciones';
    valor = 'medio';
    accionabilidad = 'media';
    reasons.push('alegaciones');
  } else if (esConvocatoriaAyuda || tieneSolicitud) {
    fase = 'convocatoria_solicitud';
    valor = plazoNoVerificado ? 'medio' : 'alto';
    accionabilidad = tienePlazoVerificable || tieneSolicitud ? 'alta' : 'media';
    reasons.push(esConvocatoriaAyuda ? 'convocatoria' : 'solicitud');
  } else if (tieneDeclaracion || esObligacionOperativa) {
    fase = 'obligacion_tramite';
    valor = 'alto';
    accionabilidad = 'alta';
    reasons.push(tieneDeclaracion ? 'declaracion' : 'obligacion');
  } else if (esInformativaPura) {
    fase = 'informativa_pura';
    valor = 'bajo';
    accionabilidad = 'baja';
    reasons.push('informativa_pura');
  }

  if (tienePlazoVerificable && valor !== 'bajo') {
    accionabilidad = 'alta';
    reasons.push('plazo_verificable');
  }

  return {
    fase,
    valor,
    accionabilidad,
    bajo_valor: valor === 'bajo',
    es_obligacion_operativa: esObligacionOperativa,
    es_resolucion_ex_post: esResolucionExPost,
    es_sancion_control: esSancionControl,
    es_informativa_pura: esInformativaPura,
    reasons: [...new Set(reasons)],
  };
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
  const textoSinAccionGenerica = textoAlertaSinAccionGenerica(alerta);
  const plazoNoVerificado = /\b(sin plazo claro|sin plazo verificable|sin plazo demostrado|sin plazo demostrable|no permite confirmar plazo|no consta plazo|plazo no (consta|confirmado|verificado)|pendiente de confirmar plazo)\b/.test(textoSinAccionGenerica) ||
    /\bplazo\s*:\s*(no_detectado|no detectado|sin especificar|no especificado)\b/.test(textoSinAccionGenerica);
  const tienePlazoVerificable = !plazoNoVerificado && /\b(plazo (de|para) (presentacion|solicitud|solicitudes|alegaciones|subsanacion)|hasta el|antes del|finaliza( el)?|vence( el)?|\d{1,3} dias? (habiles|naturales)|alegaciones durante)\b/.test(textoSinAccionGenerica);
  const esConvocatoriaAyuda = /\b(se convocan|convocatoria|extracto de la resolucion|bases reguladoras|concesion directa|se aprueban? las bases)\b/.test(textoSinAccionGenerica);
  const tieneMarcadorIndividualFuerte = /\b(expediente individual|solicitud de concesion|concesion de aguas?|aprovechamiento de aguas?|procedimiento sancionador|notificacion individual|solicitud de licencia ambiental|licencia ambiental de actividad|actividad clasificada|autorizacion de vertido|extincion de derecho|parcela concreta|titular concreto|solicitada por)\b/.test(textoSinAccionGenerica);
  const tieneSociedadAgrariaIndividual = /\b(sociedad agraria de transformacion|registro general de sociedades agrarias de transformacion|sat\s*(?:n|num|numero|n\.)?)\b/.test(textoSinAccionGenerica) &&
    /\b(disolucion|disuelve|disuelta|liquidacion|liquida|cancelacion|baja|concurso voluntario|juzgado de lo mercantil|mercantil)\b/.test(textoSinAccionGenerica);
  const expedienteNoGeneral = /\bexpediente\b/.test(textoSinAccionGenerica) && !esConvocatoriaAyuda;
  const intencion = clasificarIntencionOperativa({
    texto: textoSinAccionGenerica,
    features,
    plazoNoVerificado,
    tienePlazoVerificable,
    esConvocatoriaAyuda,
  });

  return {
    features,
    flags,
    intencion,
    tiene_plazo: tienePlazoVerificable,
    plazo_no_verificado: plazoNoVerificado,
    tiene_solicitud: features.includes('accion:solicitar'),
    tiene_subsanacion: features.includes('accion:subsanar'),
    tiene_alegaciones: features.includes('accion:alegar'),
    tiene_justificacion: features.includes('accion:justificar'),
    tiene_declaracion: features.includes('accion:declarar'),
    tiene_recurso: features.includes('accion:recurrir'),
    es_ayuda: features.includes('concepto:ayuda_directa'),
    es_convocatoria_ayuda: esConvocatoriaAyuda,
    es_pac: features.includes('concepto:pac'),
    es_agua: features.includes('concepto:agua_riego'),
    es_sanidad_animal: features.includes('concepto:sanidad_animal') || features.includes('concepto:bienestar_animal'),
    es_medio_ambiente: features.includes('concepto:medio_ambiente'),
    // La taxonomia detecta la palabra "expediente" incluso dentro de la ACCION
    // generica que llevan muchas fichas. Ignoramos esa linea, pero conservamos
    // marcadores fuertes de expedientes particulares en el contenido real.
    es_individual: flags.includes('expediente_individual') || tieneMarcadorIndividualFuerte || tieneSociedadAgrariaIndividual || expedienteNoGeneral || intencion.es_sancion_control,
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
  const provinciasAlerta = provinciasDerivadasAlerta(alerta);
  const sectoresAlerta = sectoresDerivadosAlerta(alerta);
  const subsectoresAlerta = subsectoresDerivadosAlerta(alerta);
  const tiposAlerta = tiposDerivadosAlerta(alerta);
  const alertaNacional = esAlertaNacional(alerta, provinciasAlerta) ||
    provinciasAlerta.some((provincia) => MARCADORES_NACIONALES.has(provincia));
  const sectorDeclaradoCompatible = sectoresCompatiblesDeclarados(sectoresUser, sectoresAlerta);

  return {
    provincia: provinciasUser.length === 0 || alertaNacional || intersecta(provinciasUser, provinciasAlerta),
    provincia_expresa: provinciasUser.length > 0 && !alertaNacional && intersecta(provinciasUser, provinciasAlerta),
    provincia_nacional: alertaNacional,
    sector: sectoresUser.length === 0 || sectoresAlerta.length === 0 || sectorDeclaradoCompatible,
    sector_expreso: sectoresUser.length > 0 && sectoresAlerta.length > 0 && sectorDeclaradoCompatible,
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

function preferenciasIncompletas(user = {}) {
  const prefs = user.preferences || {};
  return lista(prefs.provincias).length === 0 &&
    lista(prefs.sectores, canonicalSector).length === 0 &&
    lista(prefs.subsectores, canonicalSubsector).length === 0 &&
    tiposActivosUsuario(user).length === 0;
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

function calcularRiesgoRuido({ alerta = {}, user = {}, calidad = {}, signals = {}, matches = {}, bloqueo = {}, policy = {} }) {
  const reasons = [];
  const tiposAlerta = tiposDerivadosAlerta(alerta);
  const sectoresAlerta = sectoresDerivadosAlerta(alerta);
  const subsectoresAlerta = subsectoresDerivadosAlerta(alerta);
  const factSheet = calidad?.metadata?.fact_sheet || {};

  if (signals.generico) reasons.push({ code: 'resumen_generico', level: 'alto', detail: 'Resumen generico o poco accionable.' });
  if (signals.es_licitacion) reasons.push({ code: 'posible_licitacion', level: 'alto', detail: 'Posible licitacion o contrato.' });
  if (signals.intencion?.bajo_valor) {
    reasons.push({
      code: `intencion_${signals.intencion.fase}`,
      level: 'alto',
      detail: `Intencion operativa de bajo valor: ${signals.intencion.fase}.`,
    });
  }
  if (signals.es_individual && !bloqueo.municipio) {
    reasons.push({
      code: bloqueo.interesProvincial ? 'expediente_individual_revision' : 'expediente_individual_sin_municipio',
      level: 'alto',
      detail: bloqueo.interesProvincial
        ? 'Expediente individual con coincidencia provincial: requiere revision manual.'
        : 'Expediente individual sin municipio declarado.',
    });
  }
  if (signals.es_ayuda && signals.plazo_no_verificado) {
    const convocatoriaGeneral = signals.es_convocatoria_ayuda && !signals.es_individual && !signals.generico;
    reasons.push({
      code: 'plazo_no_verificado',
      level: convocatoriaGeneral ? 'medio' : 'alto',
      detail: convocatoriaGeneral
        ? 'Convocatoria o bases de ayuda sin plazo verificable; puede enviarse sin afirmar fechas.'
        : 'Ayuda o subvencion sin plazo verificable.',
    });
  }
  if (Number(calidad.score || 0) < policy.minReviewQualityScore) {
    reasons.push({ code: 'calidad_baja', level: 'alto', detail: `Calidad ${calidad.score}.` });
  }
  if (tiposAlerta.length === 0) reasons.push({ code: 'tipo_alerta_vacio', level: 'alto', detail: 'No hay tipo de alerta normalizado.' });
  if (sectoresAlerta.length === 0 && subsectoresAlerta.length === 0) {
    reasons.push({ code: 'sector_subsector_no_expresos', level: 'alto', detail: 'No hay sector ni subsector expreso.' });
  }
  if (!matches.sector_expreso && !matches.subsector_expreso) {
    reasons.push({ code: 'sector_usuario_no_expreso', level: 'medio', detail: 'No hay match expreso de sector o subsector.' });
  }
  if (!matches.tipo_expreso) {
    reasons.push({ code: 'tipo_usuario_no_expreso', level: 'medio', detail: 'No hay match expreso de tipo de alerta.' });
  }
  if (preferenciasIncompletas(user)) {
    reasons.push({ code: 'perfil_incompleto', level: 'alto', detail: 'Usuario sin preferencias declaradas suficientes.' });
  }
  if (factSheet.status === 'review_only' || factSheet.status === 'blocked') {
    reasons.push({ code: `fact_sheet_${factSheet.status}`, level: 'alto', detail: `Fact sheet en estado ${factSheet.status}.` });
  }

  if (reasons.some((reason) => reason.level === 'alto')) return { nivel: 'alto', reasons };
  if (reasons.some((reason) => reason.level === 'medio')) return { nivel: 'medio', reasons };
  return { nivel: 'bajo', reasons };
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
  if (signals.tiene_justificacion) score = sumar(score, reasons, 9, 'justificacion', 'Fase de justificacion de ayuda o gasto.');
  if (signals.tiene_declaracion) score = sumar(score, reasons, 8, 'declaracion_registro', 'Declaracion, alta o modificacion registral.');
  if (signals.tiene_recurso) score = sumar(score, reasons, 5, 'recurso_reclamacion', 'Recurso o reclamacion con posible accion.');
  if (signals.tiene_alegaciones) score = sumar(score, reasons, 6, 'alegaciones', 'Tramite de alegaciones/informacion publica.');
  if (signals.intencion?.es_obligacion_operativa) score = sumar(score, reasons, 9, 'obligacion_operativa', 'Obligacion o restriccion operativa para explotaciones.');
  if (signals.intencion?.valor === 'alto') score = sumar(score, reasons, 6, `intencion_${signals.intencion.fase}`, 'Intencion operativa de alto valor.');
  else if (signals.intencion?.valor === 'bajo') score = sumar(score, reasons, -22, `intencion_${signals.intencion.fase}`, 'Intencion operativa de bajo valor.');
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

  if (signals.es_individual || signals.es_licitacion || signals.es_nombramiento || signals.generico || signals.intencion?.bajo_valor) {
    return false;
  }

  return Boolean(
    signals.es_ayuda ||
    signals.tiene_solicitud ||
    signals.tiene_plazo ||
    signals.tiene_subsanacion ||
    signals.tiene_justificacion ||
    signals.tiene_declaracion ||
    signals.tiene_recurso ||
    signals.tiene_alegaciones ||
    signals.es_pac ||
    signals.es_agua ||
    signals.es_sanidad_animal ||
    signals.es_medio_ambiente
  );
}

function clasificarDecision({ score, blocks, signals, calidad, policy, riesgoRuido, bloqueo }) {
  if (blocks.length > 0) return { action: 'exclude', motivo: blocks[0].code, riesgo: 'alto' };
  if (signals.es_individual && !bloqueo?.municipio) {
    if (policy.allowReview && score >= policy.minReviewScore) {
      return { action: 'review_only', motivo: 'expediente_individual_requiere_revision', riesgo: 'alto' };
    }
    return { action: 'exclude', motivo: 'expediente_individual_sin_municipio', riesgo: 'alto' };
  }
  if (riesgoRuido?.nivel === 'alto') {
    if (puedeSerRevisionSegura({ score, calidad, signals, policy }) || calidad?.metadata?.fact_sheet?.status === 'review_only') {
      return { action: 'review_only', motivo: 'revision_riesgo_alto', riesgo: 'alto' };
    }
    return { action: 'exclude', motivo: riesgoRuido.reasons[0]?.code || 'riesgo_ruido_alto', riesgo: 'alto' };
  }
  if (score >= policy.minIncludeScore) {
    const incluidaSinPlazo = signals.es_ayuda &&
      signals.es_convocatoria_ayuda &&
      signals.plazo_no_verificado;
    return {
      action: 'include',
      motivo: incluidaSinPlazo ? 'incluida_sin_plazo_verificado' : 'incluida',
      riesgo: signals.es_individual || riesgoRuido?.nivel === 'medio' ? 'medio' : 'bajo',
    };
  }
  if (puedeSerRevisionSegura({ score, calidad, signals, policy })) return { action: 'review_only', motivo: 'revision_segura', riesgo: 'medio' };
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
  const scoring = base.ok
    ? calcularScore({
      alerta,
      base,
      calidad,
      signals,
      matches,
      municipio: bloqueo.municipio,
      interesProvincial: bloqueo.interesProvincial,
    })
    : { score: 0, reasons: [], prioridad: null };
  const riesgoRuido = calcularRiesgoRuido({ alerta, user, calidad, signals, matches, bloqueo, policy });
  const verdict = clasificarDecision({ score: scoring.score, blocks: bloqueo.blocks, signals, calidad, policy, riesgoRuido, bloqueo });
  const incluir = verdict.action === 'include';
  const reviewRequired = verdict.action === 'review_only';
  // Relleno seguro: solo review_only de baja-media incertidumbre, nunca de riesgo alto.
  // Reutiliza exactamente el contrato de puedeSerRevisionSegura (allowReview, score,
  // calidad, sin critical/individual/licitacion/nombramiento/generico, con senal util).
  const reviewSafeFill = reviewRequired
    && riesgoRuido.nivel !== 'alto'
    && puedeSerRevisionSegura({ score: scoring.score, calidad, signals, policy });

  return {
    incluir,
    sendable: incluir,
    review_required: reviewRequired,
    review_safe_fill: reviewSafeFill,
    action: verdict.action,
    motivo: verdict.motivo,
    riesgo: verdict.riesgo,
    riesgo_de_ruido: riesgoRuido.nivel,
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
          es_ayuda: signals.es_ayuda,
          tiene_plazo: signals.tiene_plazo,
          es_individual: signals.es_individual,
          es_licitacion: signals.es_licitacion,
          es_nombramiento: signals.es_nombramiento,
          es_convocatoria_ayuda: signals.es_convocatoria_ayuda,
          intencion: signals.intencion,
          tiene_justificacion: signals.tiene_justificacion,
          tiene_declaracion: signals.tiene_declaracion,
          tiene_recurso: signals.tiene_recurso,
          generico: signals.generico,
          plazo_no_verificado: signals.plazo_no_verificado,
          municipio_declarado: bloqueo.municipio,
          interes_provincial_fuerte: bloqueo.interesProvincial,
        },
        riesgo_de_ruido: {
          nivel: riesgoRuido.nivel,
          reasons: riesgoRuido.reasons,
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
  const tipos = tiposDerivadosAlerta(alerta);
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

  // 1) Primero los include (con diversidad). Nunca se desplazan por un review_only.
  const seleccionadas = pickDiversificado(candidatas, policy);

  // 2) Despues, relleno con review_only SEGURO hasta targetItems (solo si allowReview).
  const rellenoRevision = [];
  if (policy.allowReview && seleccionadas.length < policy.targetItems) {
    const usados = new Set(seleccionadas.map((item) => Number(item.alerta.id)).filter(Number.isFinite));
    const reviewCandidatas = evaluadas
      .filter((item) => item.decision.review_safe_fill && !usados.has(Number(item.alerta.id)))
      .sort((a, b) => b.decision.score - a.decision.score || Number(a.alerta.id || 0) - Number(b.alerta.id || 0));
    for (const item of reviewCandidatas) {
      if (seleccionadas.length + rellenoRevision.length >= policy.targetItems) break;
      rellenoRevision.push(item);
      usados.add(Number(item.alerta.id));
    }
  }

  const finales = [...seleccionadas, ...rellenoRevision];
  const selectedIds = new Set(finales.map((item) => Number(item.alerta.id)).filter(Number.isFinite));
  const rellenoIds = new Set(rellenoRevision.map((item) => Number(item.alerta.id)).filter(Number.isFinite));

  const decisiones = evaluadas.map((item) => {
    const id = Number(item.alerta.id);
    if (rellenoIds.has(id)) {
      return { ...item.item, incluir: true, motivo: 'relleno_revision_segura' };
    }
    if (!selectedIds.has(id) && item.decision.incluir) {
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
    alertas: finales.map((item) => crearAnotacion(
      item.alerta,
      rellenoIds.has(Number(item.alerta.id))
        ? { ...item.decision, incluir: true, motivo: 'relleno_revision_segura' }
        : item.decision,
      policy.origen || 'selection_engine_v2'
    )),
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
    // Los review_only seguros pasan al pool como candidatos de relleno; el pick final
    // (seleccionarAlertasParaDigest) decide si entran y prioriza siempre los include.
    const esRellenoSeguro = policy.allowReview && !decision.incluir && decision.review_safe_fill;
    const decisionPool = esRellenoSeguro
      ? { ...decision, incluir: true, motivo: 'candidato_revision_segura' }
      : decision;
    const item = {
      id: alerta.id,
      titulo: alerta.titulo,
      fuente: alerta.fuente || 'BOE',
      ...decisionPool,
    };
    decisiones.push(item);
    if (decision.incluir || esRellenoSeguro) incluidas.push(crearAnotacion(alerta, decisionPool, policy.origen || 'selection_engine_v2'));
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

  return Boolean(
    signals.es_ayuda ||
    signals.tiene_solicitud ||
    signals.tiene_plazo ||
    signals.tiene_subsanacion ||
    signals.tiene_justificacion ||
    signals.tiene_declaracion ||
    signals.tiene_recurso ||
    signals.es_pac ||
    signals.es_agua ||
    signals.es_sanidad_animal ||
    signals.es_medio_ambiente
  );
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
