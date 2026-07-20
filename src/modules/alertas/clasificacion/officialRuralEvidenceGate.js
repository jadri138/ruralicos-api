const {
  construirDescarteAuditable,
  limpiarCamposDescarte,
  obtenerClasificacionAlerta,
  obtenerPreclasificacionAlerta,
} = require('./discardDecision');

const OFFICIAL_RURAL_GATE_VERSION = 'official_rural_gate_v1';
const FUENTES_CONTROLADAS = new Set(['DOGC', 'DOE']);

// Estos campos son deliberadamente explicitos. La barrera nunca concatena el
// objeto alerta completo para que sectores, resumenes o etiquetas generadas no
// puedan convertirse accidentalmente en prueba de relevancia rural.
const CAMPOS_OFICIALES_TEXTO = Object.freeze(['titulo', 'contenido']);
const CAMPOS_METADATOS_OFICIALES = Object.freeze([
  'fuente',
  'region',
  'url',
  'organismo',
  'seccion',
  'subseccion',
  'tipo_documento',
  'id_oficial',
  'boletin',
]);
const CAMPOS_METADATOS_CON_TEXTO = Object.freeze([
  'organismo',
  'seccion',
  'subseccion',
  'tipo_documento',
  'boletin',
]);
const CAMPOS_GENERADOS_IGNORADOS = Object.freeze([
  'resumen',
  'resumen_borrador',
  'resumen_final',
  'sectores',
  'subsectores',
  'tipos_alerta',
  'taxonomy_tags',
  'etiquetas',
  'tags',
]);

const REASON_MESSAGES = Object.freeze({
  aviso_legal_privacidad_no_rural: 'Aviso legal o de proteccion de datos sin contenido rural.',
  actividad_cultural_no_rural: 'Premio o actividad cultural sin alcance rural agrario.',
  centro_educativo_privado_no_rural: 'Apertura de un centro educativo privado sin alcance rural agrario.',
  instalacion_gas_individual_no_rural: 'Autorizacion individual de una instalacion de gas sin impacto agrario expreso.',
  urbanismo_no_agrario: 'Urbanismo industrial o terciario sin impacto agrario expreso.',
  autorizacion_ambiental_individual_no_agraria: 'Autorizacion ambiental individual de una empresa sin impacto agrario colectivo expreso.',
  procedimiento_empresarial_individual_no_agrario: 'Procedimiento empresarial individual excluido del digest rural general.',
  contenido_oficial_insuficiente: 'El titulo y el contenido oficiales no aportan evidencia suficiente para decidir la relevancia rural.',
  sin_evidencia_rural_oficial: 'No hay evidencia rural expresa en el titulo, el contenido o los metadatos oficiales disponibles.',
});

const RURAL_SIGNAL_RULES = Object.freeze([
  ['agricultura', /\b(?:agricultur\w*|agricol\w*|agrari[oa]s?|agricultor\w*|pages\w*)\b/],
  ['ganaderia', /\b(?:ganader\w*|ramader\w*|pecuari[oa]s?|explotacion(?:es)? ganaderas?|explotacions? ramaderes?)\b/],
  ['pac_sigpac', /\b(?:pac|sigpac|fega|politica agraria comun|politica agricola comuna)\b/],
  ['explotacion_agraria', /\b(?:explotacion(?:es)? agrarias?|explotacions? agraries?|fincas? agricolas?)\b/],
  ['regadio', /\b(?:regadio|regadius?|regantes?|regants?|comunidad(?:es)? de regantes|comunitats? de regants)\b/],
  ['sanidad_agraria', /\b(?:sanidad (?:animal|vegetal)|sanitat (?:animal|vegetal)|fitosanit\w*|zoosanit\w*)\b/],
  ['desarrollo_rural', /\b(?:desarrollo rural|desenvolupament rural|medio rural|medi rural|programa leader)\b/],
  ['forestal', /\b(?:forestal(?:es)?|silvicultura|montes? publicos?|boscos? publics?)\b/],
  ['agroalimentario', /\b(?:agroalimentari\w*|industria alimentaria rural)\b/],
  ['cultivos', /\b(?:cultivos?|conreus?|olivar|vinedo|vinya|cereales?|frutales?|horticultura)\b/],
]);

const IMPACTO_AGRARIO_COLECTIVO = Object.freeze([
  /\b(?:afecta|afectara|afectacion) a (?:las? )?explotacion(?:es)? agrarias?\b/,
  /\b(?:afeccio|afectacio) a explotacions? agraries?\b/,
  /\b(?:comunidad(?:es)? de regantes|comunitats? de regants)\b/,
  /\binfraestructuras? agrarias? (?:publicas?|colectivas?)\b/,
  /\bsector agrario\b/,
  /\b(?:personas )?(?:agricultoras?|ganaderas?) (?:beneficiarias?|afectadas?)\b/,
]);

const GENERAL_RURAL_SCOPE = Object.freeze([
  /\b(?:bases reguladoras|convocatoria|convocatories?|ayudas?|ajuts?|subvenciones?|subvencions?)\b/,
  /\b(?:decreto|decret|orden|ordre)\b.{0,80}\b(?:regula|establece|estableix)\b/,
]);

const PROCEDIMIENTO_INDIVIDUAL = Object.freeze([
  /\b(?:autorizacion|autoritzacio) (?:ambiental|administrativa|individual|de explotacion|d explotacio)\b/,
  /\b(?:evaluacion|avaluacio) ambiental\b/,
  /\b(?:informacion|informacio) publica\b.{0,100}\b(?:proyecto|projecte|expediente|expedient)\b/,
  /\blicencia (?:ambiental|de actividad)\b/,
]);

const IDENTIDAD_EMPRESARIAL = Object.freeze([
  /\b(?:s l u?|s a u?|sociedad limitada|sociedad anonima|societat limitada|societat anonima)\b/,
  /\b(?:empresa|mercantil|compania|companyia)\b/,
  /\b(?:planta|fabrica|factoria|instalacion|installacio)\b.{0,100}\b(?:titular|promotor|empresa)\b/,
]);

function normalizarTexto(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[·]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function coincideAlguna(texto, patterns) {
  return patterns.some((pattern) => pattern.test(texto));
}

function detectarSenalesRurales(texto) {
  return RURAL_SIGNAL_RULES
    .filter(([, pattern]) => pattern.test(texto))
    .map(([code]) => code);
}

function construirEvidenciaOficial(alerta = {}) {
  const metadata = alerta.metadata_oficial && typeof alerta.metadata_oficial === 'object'
    ? alerta.metadata_oficial
    : {};
  const camposTextoDisponibles = CAMPOS_OFICIALES_TEXTO.filter((campo) =>
    normalizarTexto(alerta[campo])
  );
  const metadataTextoDisponible = CAMPOS_METADATOS_CON_TEXTO.filter((campo) =>
    normalizarTexto(alerta[campo] ?? metadata[campo])
  );
  const texto = [
    ...camposTextoDisponibles.map((campo) => normalizarTexto(alerta[campo])),
    ...metadataTextoDisponible.map((campo) => normalizarTexto(alerta[campo] ?? metadata[campo])),
  ].join(' ');
  const metadataDisponible = CAMPOS_METADATOS_OFICIALES.filter((campo) => {
    const value = alerta[campo] ?? metadata[campo];
    return value !== null && value !== undefined && String(value).trim();
  });

  return {
    fuente: normalizarTexto(alerta.fuente ?? metadata.fuente).toUpperCase(),
    texto,
    titulo: normalizarTexto(alerta.titulo),
    contenido: normalizarTexto(alerta.contenido),
    campos_metadata_disponible: metadataDisponible,
    campos_relevancia: [
      ...camposTextoDisponibles,
      ...metadataDisponible.filter((campo) => metadataTextoDisponible.includes(campo)),
    ],
  };
}

function resultado(action, reasonCode, evidencia, ruralSignals = [], nonRuralSignals = []) {
  return {
    version: OFFICIAL_RURAL_GATE_VERSION,
    action,
    reason_code: reasonCode,
    reason: REASON_MESSAGES[reasonCode] ?? null,
    confidence: action === 'discard' ? 1 : action === 'allow' ? 0.95 : 0.7,
    diagnostics: {
      source: evidencia.fuente,
      official_text_length: evidencia.texto.length,
      official_fields_used: evidencia.campos_relevancia,
      official_metadata_available: evidencia.campos_metadata_disponible,
      rural_signals: ruralSignals,
      non_rural_signals: nonRuralSignals,
      generated_fields_ignored: CAMPOS_GENERADOS_IGNORADOS,
    },
  };
}

function evaluarBarreraRuralOficial(alerta = {}) {
  const evidencia = construirEvidenciaOficial(alerta);
  if (!FUENTES_CONTROLADAS.has(evidencia.fuente)) {
    return resultado('allow', 'fuente_fuera_de_alcance', evidencia);
  }

  const texto = evidencia.texto;
  const ruralSignals = detectarSenalesRurales(texto);
  const impactoAgrarioColectivo = coincideAlguna(texto, IMPACTO_AGRARIO_COLECTIVO);
  const ambitoRuralGeneral = ruralSignals.length > 0 && coincideAlguna(texto, GENERAL_RURAL_SCOPE);
  const nonRuralSignals = [];

  const reglasFuertes = [
    {
      code: 'aviso_legal_privacidad_no_rural',
      match: /\b(?:aviso legal|avis legal|proteccion de datos|proteccio de dades|politica de privacidad|politica de privacitat|delegado de proteccion de datos|tractament de dades personals)\b/.test(texto),
    },
    {
      code: 'actividad_cultural_no_rural',
      match: /\b(?:premios?|premis?)\b/.test(texto)
        && /\b(?:musica|musical(?:es)?|composicion|composicio|cancion|interpretacion musical)\b/.test(texto),
    },
    {
      code: 'centro_educativo_privado_no_rural',
      match: /\b(?:apertura|obertura|autoriza\w*)\b/.test(texto)
        && /\b(?:centro|centre)\b/.test(texto)
        && /\b(?:educacion|educatiu|educativo|ensenanza|ensenyament|docente|docent)\b/.test(texto)
        && /\b(?:privado|privada|privat|titularidad privada|titularitat privada)\b/.test(texto),
    },
    {
      code: 'instalacion_gas_individual_no_rural',
      match: /\b(?:autorizacion|autoritzacio)\b/.test(texto)
        && /\b(?:instalaciones? de gas|installacions? de gas|red de distribucion de gas|xarxa de distribucio de gas|gasoducto)\b/.test(texto),
    },
    {
      code: 'urbanismo_no_agrario',
      match: /\b(?:urbanismo|urbanisme|planeamiento|planejament|plan parcial|modificacion puntual|modificacio puntual)\b/.test(texto)
        && /\b(?:industrial|terciario|terciari|poligono industrial|sector industrial)\b/.test(texto),
    },
  ];

  for (const regla of reglasFuertes) {
    if (regla.match) nonRuralSignals.push(regla.code);
  }

  const autorizacionAmbiental = /\b(?:autorizacion|autoritzacio) ambiental(?: integrada| unificada)?\b/.test(texto);
  const fertilizantes = /\b(?:fertilizantes?|fertilitzants?|abonos? quimicos?)\b/.test(texto);
  const identidadEmpresarial = coincideAlguna(texto, IDENTIDAD_EMPRESARIAL);
  if (autorizacionAmbiental && fertilizantes && identidadEmpresarial) {
    nonRuralSignals.push('autorizacion_ambiental_individual_no_agraria');
  }

  const procedimientoIndividual = coincideAlguna(texto, PROCEDIMIENTO_INDIVIDUAL)
    && identidadEmpresarial;
  if (procedimientoIndividual && !ambitoRuralGeneral) {
    nonRuralSignals.push('procedimiento_empresarial_individual_no_agrario');
  }

  const uniqueNonRuralSignals = [...new Set(nonRuralSignals)];
  if (uniqueNonRuralSignals.length > 0 && !impactoAgrarioColectivo) {
    const specific = uniqueNonRuralSignals.find((code) =>
      code !== 'procedimiento_empresarial_individual_no_agrario'
    );
    const reasonCode = specific ?? uniqueNonRuralSignals[0];
    return resultado('discard', reasonCode, evidencia, ruralSignals, uniqueNonRuralSignals);
  }

  if (ruralSignals.length > 0) {
    return resultado('allow', 'evidencia_rural_oficial', evidencia, ruralSignals, uniqueNonRuralSignals);
  }

  const contenidoInsuficiente = evidencia.contenido.length < 80
    || evidencia.contenido === evidencia.titulo;
  return resultado(
    contenidoInsuficiente ? 'needs_evidence' : 'review',
    contenidoInsuficiente ? 'contenido_oficial_insuficiente' : 'sin_evidencia_rural_oficial',
    evidencia,
    ruralSignals,
    uniqueNonRuralSignals
  );
}

function anadirRazonPreclasificacion(alerta, gate) {
  const anteriores = Array.isArray(alerta.pre_reasons) ? alerta.pre_reasons : [];
  return [
    ...anteriores.filter((item) => item?.tag !== gate.reason_code),
    { tag: gate.reason_code, weight: 0, stage: 'official_rural_gate' },
  ];
}

function construirPersistenciaBarreraRural(alerta = {}, gate = evaluarBarreraRuralOficial(alerta)) {
  if (gate.action === 'allow') return null;

  if (gate.action === 'discard') {
    const discardPatch = construirDescarteAuditable({
      code: gate.reason_code,
      reason: gate.reason,
      stage: 'official_rural_gate',
      confidence: gate.confidence,
      preclassification: obtenerPreclasificacionAlerta(alerta),
      classification: obtenerClasificacionAlerta(alerta),
    });
    return {
      action: gate.action,
      patch: {
        ...discardPatch,
        resumen_final: null,
        decision_audit: {
          ...discardPatch.decision_audit,
          official_rural_gate: gate,
        },
      },
    };
  }

  const previousAudit = alerta.decision_audit && typeof alerta.decision_audit === 'object'
    ? alerta.decision_audit
    : {};
  const needsEvidence = gate.action === 'needs_evidence';
  return {
    action: gate.action,
    patch: {
      estado_ia: needsEvidence ? 'needs_evidence' : 'pendiente_revision_manual',
      resumen: needsEvidence
        ? `SIN EVIDENCIA OFICIAL: ${gate.reason}`
        : `REVISION RURAL REQUERIDA: ${gate.reason}`,
      resumen_final: null,
      pre_status: needsEvidence ? 'needs_evidence' : 'review',
      pre_reasons: anadirRazonPreclasificacion(alerta, gate),
      candidate_level: needsEvidence ? 'needs_evidence' : 'needs_ai',
      ...limpiarCamposDescarte(),
      decision_audit: {
        ...previousAudit,
        version: previousAudit.version ?? 'alert_decision_audit_v2',
        official_rural_gate: gate,
      },
    },
  };
}

module.exports = {
  CAMPOS_GENERADOS_IGNORADOS,
  CAMPOS_OFICIALES_TEXTO,
  FUENTES_CONTROLADAS,
  OFFICIAL_RURAL_GATE_VERSION,
  construirEvidenciaOficial,
  construirPersistenciaBarreraRural,
  evaluarBarreraRuralOficial,
  normalizarTexto,
};
