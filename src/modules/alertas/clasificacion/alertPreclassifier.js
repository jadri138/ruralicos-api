// src/modules/alertas/clasificacion/alertPreclassifier.js
//
// PRECLASIFICADOR BARATO (sin IA) — primera capa de ordenacion del pipeline.
//
// Objetivo: dada una alerta recien insertada (titulo + contenido del boletin),
// decidir BARATO si merece la pena gastar tokens de IA con ella, o si es ruido
// claro que puede descartarse por reglas. NO llama a OpenAI, NO toca BD: es una
// funcion pura y deterministica, facil de testear y auditar.
//
// Encaja en el flujo objetivo:
//   raw_documents -> alertas -> [PRECLASIFICACION BARATA] -> IA solo si merece
//                    la pena -> quality gate -> digest
//
// Se conecta a /alertas/clasificar mediante ALERT_PRECLASSIFIER_MODE,
// persistiendo
// el resultado en las columnas pre_score/pre_status/pre_reasons/candidate_level
// (ver migracion supabase/migrations/*_add_alert_preclassification.sql).
//
// Capa intencionadamente AUTOCONTENIDA: no importa alertas.service.js (que
// arrastra supabase/whatsapp y exige env vars al cargar). Solo comparte reglas
// puras de alcance; el modulo sigue sin efectos secundarios y es testeable en
// aislamiento. Cuando se integre en el pipeline
// detras de ALERT_PRECLASSIFIER_ENABLED, convivira con la deteccion de
// exclusion dura existente sin solaparse de forma conflictiva.

const {
  detectarDescarteEstructuradoFueraAlcance,
} = require('../../../shared/alertScopeRules');

// Normaliza a minusculas sin diacriticos (mismo criterio que alertas.service.js).
function normalizarTexto(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const PRECLASSIFIER_MODE = Object.freeze({
  OFF: 'off',
  OBSERVE: 'observe',
  HARD_EXCLUSIONS: 'hard_exclusions',
});

function normalizarModoPreclasificador(value = process.env.ALERT_PRECLASSIFIER_MODE) {
  const mode = String(value || PRECLASSIFIER_MODE.OFF).trim().toLowerCase();
  return Object.values(PRECLASSIFIER_MODE).includes(mode)
    ? mode
    : PRECLASSIFIER_MODE.OFF;
}

function contieneAlguno(texto, palabras) {
  return palabras.some((palabra) => texto.includes(normalizarTexto(palabra)));
}

function textoAlertaNormalizado(alerta = {}) {
  return normalizarTexto([
    alerta.titulo,
    alerta.resumen,
    alerta.resumen_borrador,
    alerta.resumen_final,
    alerta.contenido,
  ].filter(Boolean).join('\n'));
}

// ──────────────────────────────────────────────────────────────────────────
// NIVELES DE CANDIDATURA
// ──────────────────────────────────────────────────────────────────────────
const CANDIDATE_LEVEL = Object.freeze({
  STRONG: 'strong_candidate',   // senal agraria fuerte: pasar a IA con prioridad
  WEAK: 'weak_candidate',       // senal agraria debil / ruido individual: pasar a IA con baja prioridad
  DISCARD: 'discard_rule',      // ruido claro por regla: descartable sin IA
  NEEDS_AI: 'needs_ai',         // agrario pero ambiguo: la IA debe decidir
  NEEDS_EVIDENCE: 'needs_evidence', // sin texto util: falta materia prima para decidir
});

// pre_status derivado (intencion operativa, agnostica de como lo aplique el handler)
const PRE_STATUS = Object.freeze({
  KEEP: 'keep',       // candidato real, mantener hacia IA
  REVIEW: 'review',   // dudoso, dejar que IA arbitre
  DISCARD: 'discard', // descartable por regla
  EVIDENCE: 'needs_evidence', // sin contenido suficiente para preclasificar
});

// ──────────────────────────────────────────────────────────────────────────
// KEYWORDS — pesos pequenos y legibles. Auditables via pre_reasons.
// Tildes irrelevantes: el texto se normaliza (NFD sin diacriticos) antes.
// ──────────────────────────────────────────────────────────────────────────

// Suben score (senal agraria / oportunidad / obligacion relevante)
const POSITIVE_TERMS = [
  { tag: 'ayuda', weight: 3, terms: ['ayuda', 'ayudas'] },
  { tag: 'subvencion', weight: 3, terms: ['subvencion', 'subvenciones'] },
  { tag: 'convocatoria', weight: 3, terms: ['convocatoria', 'extracto de la resolucion', 'bases reguladoras'] },
  { tag: 'pac', weight: 4, terms: ['pac', 'politica agraria comun', 'pago unico', 'pago basico'] },
  { tag: 'fega', weight: 4, terms: ['fega', 'sigpac'] },
  { tag: 'regadio', weight: 3, terms: ['regadio', 'regante', 'comunidad de regantes', 'riego'] },
  { tag: 'sequia', weight: 3, terms: ['sequia'] },
  { tag: 'sanidad_animal', weight: 3, terms: ['sanidad animal', 'bienestar animal', 'epizootia', 'foco de'] },
  { tag: 'plaga', weight: 3, terms: ['plaga', 'plagas', 'sanidad vegetal', 'fitosanit'] },
  { tag: 'explotacion_agraria', weight: 3, terms: ['explotacion agraria', 'explotacion ganadera', 'explotaciones agrarias'] },
  { tag: 'jovenes_agricultores', weight: 4, terms: ['jovenes agricultores', 'joven agricultor'] },
  { tag: 'incorporacion', weight: 2, terms: ['incorporacion de jovenes', 'primera instalacion', 'incorporacion a la actividad'] },
  { tag: 'modernizacion', weight: 2, terms: ['modernizacion de explotaciones', 'modernizacion de regadios', 'modernizacion'] },
  { tag: 'agroambiental', weight: 2, terms: ['agroambiental', 'agroambientales', 'medidas agroambientales'] },
  { tag: 'ecologico', weight: 2, terms: ['agricultura ecologica', 'ganaderia ecologica', 'produccion ecologica'] },
  { tag: 'irpf_agrario', weight: 2, terms: ['irpf agrario', 'estimacion objetiva', 'rendimiento neto agrario'] },
  { tag: 'modulos_agrarios', weight: 2, terms: ['modulos agrarios', 'modulos del irpf', 'indices de rendimiento neto'] },
  // senal agraria generica de respaldo (sostiene la relevancia sin ser fuerte por si sola)
  { tag: 'agrario_generico', weight: 1, terms: ['agrario', 'agraria', 'agricola', 'agricultor', 'ganadero', 'ganaderia', 'cultivo', 'forestal', 'agroalimentari'] },
];

// Bajan score / descartan (ruido administrativo o asuntos individuales sin impacto general)
const NEGATIVE_TERMS = [
  { tag: 'oposicion', weight: 6, terms: ['oposicion', 'oposiciones', 'proceso selectivo'] },
  { tag: 'nombramiento', weight: 6, terms: ['nombramiento', 'se nombra', 'cese de', 'toma de posesion'] },
  { tag: 'tribunal_calificador', weight: 6, terms: ['tribunal calificador', 'comision de valoracion', 'comision de seleccion'] },
  { tag: 'empleo_publico', weight: 6, terms: ['empleo publico', 'oferta publica de empleo', 'bolsa de trabajo', 'bolsa de empleo', 'relacion de puestos de trabajo', 'provision de puestos', 'concurso de meritos'] },
  { tag: 'urbanismo_puro', weight: 4, terms: ['planeamiento urbanistico', 'plan general de ordenacion urbana', 'licencia urbanistica', 'modificacion puntual del pgou'] },
  { tag: 'notaria', weight: 5, terms: ['notario', 'notaria', 'oposiciones al cuerpo de notarios'] },
  { tag: 'registro_mercantil', weight: 5, terms: ['registro mercantil', 'registrador mercantil', 'registro de la propiedad'] },
  { tag: 'licitacion_no_rural', weight: 3, terms: ['licitacion', 'contrato de obras', 'contrato de servicios', 'formalizacion del contrato', 'adjudicacion del contrato'] },
  { tag: 'anuncio_individual', weight: 3, terms: ['anuncio de', 'edicto', 'notificacion de', 'a la persona interesada'] },
  { tag: 'expediente_sancionador_individual', weight: 4, terms: ['expediente sancionador', 'procedimiento sancionador', 'resolucion sancionadora', 'sancion de'] },
  { tag: 'concesion_individual', weight: 3, terms: ['solicitud de concesion', 'concesion de aguas', 'aprovechamiento de aguas', 'competencia de proyectos', 'comisaria de aguas'] },
];

// Senales de que el asunto es GENERAL (convocatoria, normativa, listado) y por
// tanto los marcadores "individuales" de arriba probablemente sean colaterales.
const GENERAL_SCOPE_TERMS = [
  'convocatoria', 'bases reguladoras', 'extracto de la resolucion', 'se aprueba la convocatoria',
  'subvenciones', 'ayudas para', 'reglamento', 'decreto', 'orden de', 'real decreto',
  'beneficiarios', 'normativa',
];

// ──────────────────────────────────────────────────────────────────────────
// UTILIDADES INTERNAS
// ──────────────────────────────────────────────────────────────────────────

function redondear(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

const CONTENT_PLACEHOLDER_PATTERNS = Object.freeze([
  /^cargando(?: el documento)?$/,
  /^procesando con ia$/,
  /^contenido (?:no disponible|pendiente)$/,
  /^sin (?:contenido|texto)(?: disponible)?$/,
  /^documento (?:no disponible|ilegible)$/,
  /^(?:error|fallo) (?:al cargar|del portal|de acceso)$/,
]);

function esContenidoPlaceholder(value) {
  const contenido = normalizarTexto(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Boolean(contenido)
    && CONTENT_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(contenido));
}

// Texto util de la alerta: titulo + contenido. Sin esto no se puede preclasificar.
function tieneTextoUtil(alerta = {}) {
  const titulo = normalizarTexto(alerta.titulo).replace(/\s+/g, ' ').trim();
  const contenido = normalizarTexto(alerta.contenido).replace(/\s+/g, ' ').trim();
  // Un titulo plausible no convierte un placeholder del portal en evidencia.
  if (esContenidoPlaceholder(contenido)) return false;
  const utilLargo = (titulo.length + contenido.length) >= 18;
  return utilLargo && (Boolean(titulo) || Boolean(contenido));
}

function aplicarTerminos(texto, grupos, signo, reasons) {
  let acumulado = 0;
  for (const grupo of grupos) {
    if (contieneAlguno(texto, grupo.terms)) {
      const points = signo * grupo.weight;
      acumulado += points;
      reasons.push({ tag: grupo.tag, weight: points });
    }
  }
  return acumulado;
}

// Anclas agrarias: si aparecen, el asunto roza al sector aunque el organismo o
// el marco sea administrativo (no excluir como "no agrario").
const ANCLA_AGRARIA = [
  'agrario', 'agraria', 'agricola', 'agricultor', 'ganadero', 'ganaderia',
  'explotacion agraria', 'explotacion ganadera', 'regadio', 'regante',
  'camino rural', 'via pecuaria', 'monte publico', 'pac', 'fega', 'sigpac',
];

// Exclusion dura por reglas (mismo criterio que alertas.service.js, replicado
// aqui para mantener el modulo puro y sin dependencias pesadas):
//  - empleo publico / provision de puestos / oposiciones
//  - pesca o maritimo sin relacion agraria
//  - administracion general (universidad, notarios, urbanismo) sin relacion agraria
function detectarExclusionDuraAlerta(texto) {
  const descarteEstructurado = detectarDescarteEstructuradoFueraAlcance(texto);
  if (descarteEstructurado) return descarteEstructurado.reasonCode;

  const empleoPublico = contieneAlguno(texto, [
    'concurso especifico de meritos', 'concurso de meritos y capacidades',
    'provision de un puesto', 'provision de puestos', 'puesto singular',
    'relacion de puestos de trabajo', 'personal funcionario', 'personal laboral',
    'funcionarios de carrera', 'empleo publico', 'oferta publica de empleo',
    'bolsa de trabajo', 'proceso selectivo', 'oposicion',
  ]);
  if (empleoPublico) return 'proceso_personal_publico';

  const pescaOMaritimo = contieneAlguno(texto, [
    'politica maritima', 'pesca maritima', 'sector pesquero', 'actividad pesquera',
    'flota pesquera', 'acuicultura', 'marisqueo', 'maritimo',
  ]);
  if (pescaOMaritimo && !contieneAlguno(texto, ANCLA_AGRARIA)) {
    return 'pesca_maritimo_no_agrario';
  }

  const adminGeneral = contieneAlguno(texto, [
    'beca universitaria', 'universidad', 'notario', 'registrador',
    'registro de la propiedad', 'convenio colectivo', 'urbanismo',
    'planeamiento urbanistico', 'licencia urbanistica',
  ]);
  if (adminGeneral && !contieneAlguno(texto, ANCLA_AGRARIA)) {
    return 'administracion_general_no_agraria';
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// API PRINCIPAL
// ──────────────────────────────────────────────────────────────────────────

/**
 * Preclasifica una alerta con reglas baratas (sin IA).
 *
 * @param {object} alerta  Fila parcial de `alertas` (id, titulo, contenido, ...).
 * @returns {{
 *   pre_score: number,
 *   pre_status: string,
 *   pre_reasons: Array<{tag: string, weight: number}>,
 *   candidate_level: string
 * }}
 */
function preclassifyAlerta(alerta = {}) {
  const reasons = [];

  // 1) Sin materia prima -> no se puede decidir barato. La IA tampoco deberia
  //    gastar tokens hasta que la alerta tenga texto util (necesita evidencia).
  if (!tieneTextoUtil(alerta)) {
    return {
      pre_score: 0,
      pre_status: PRE_STATUS.EVIDENCE,
      pre_reasons: [{ tag: 'sin_texto_util', weight: 0 }],
      candidate_level: CANDIDATE_LEVEL.NEEDS_EVIDENCE,
    };
  }

  const texto = textoAlertaNormalizado(alerta);

  // 2) Exclusion dura ya consensuada en el pipeline (empleo publico, pesca no
  //    agraria, administracion general). Si dispara, es descarte por regla.
  const exclusionDura = detectarExclusionDuraAlerta(texto);
  if (exclusionDura) {
    reasons.push({ tag: exclusionDura, weight: -10 });
  }

  // 3) Acumular senales positivas y negativas.
  const positivo = aplicarTerminos(texto, POSITIVE_TERMS, +1, reasons);
  const negativo = aplicarTerminos(texto, NEGATIVE_TERMS, -1, reasons);
  const preScore = redondear(positivo + negativo + (exclusionDura ? -10 : 0));

  const ambitoGeneral = contieneAlguno(texto, GENERAL_SCOPE_TERMS);

  // Senales agrarias fuertes (oportunidad/obligacion clara para el sector).
  const senalFuerte = reasons.some((r) =>
    ['pac', 'fega', 'jovenes_agricultores', 'ayuda', 'subvencion', 'regadio', 'sanidad_animal', 'plaga', 'sequia', 'explotacion_agraria'].includes(r.tag) && r.weight > 0
  );
  const hayAlgunaSenalPositiva = positivo > 0;
  const senalIndividual = reasons.some((r) =>
    ['expediente_sancionador_individual', 'concesion_individual', 'anuncio_individual'].includes(r.tag) && r.weight < 0
  );

  let candidate_level;
  let pre_status;

  if (exclusionDura) {
    // Empleo publico / pesca / admin general: ruido claro.
    candidate_level = CANDIDATE_LEVEL.DISCARD;
    pre_status = PRE_STATUS.DISCARD;
  } else if (preScore <= -3 && !hayAlgunaSenalPositiva) {
    // Ruido administrativo neto sin contrapeso agrario: descartar por regla.
    candidate_level = CANDIDATE_LEVEL.DISCARD;
    pre_status = PRE_STATUS.DISCARD;
  } else if (senalIndividual && !ambitoGeneral) {
    // Sancion/concesion individual sin ambito general -> candidato debil:
    // dejamos que la IA confirme, pero con baja prioridad (no se descarta solo).
    candidate_level = CANDIDATE_LEVEL.WEAK;
    pre_status = PRE_STATUS.REVIEW;
  } else if (senalFuerte && preScore >= 4) {
    // Senal agraria fuerte y score claramente positivo: candidato fuerte.
    candidate_level = CANDIDATE_LEVEL.STRONG;
    pre_status = PRE_STATUS.KEEP;
  } else if (hayAlgunaSenalPositiva) {
    // Hay senal agraria pero ambigua o normativa generica: que arbitre la IA.
    candidate_level = CANDIDATE_LEVEL.NEEDS_AI;
    pre_status = PRE_STATUS.REVIEW;
  } else {
    // Ni senal agraria ni ruido claro: sin pistas baratas, la IA decide.
    candidate_level = CANDIDATE_LEVEL.NEEDS_AI;
    pre_status = PRE_STATUS.REVIEW;
  }

  return {
    pre_score: preScore,
    pre_status,
    pre_reasons: reasons,
    candidate_level,
  };
}

module.exports = {
  preclassifyAlerta,
  CANDIDATE_LEVEL,
  PRE_STATUS,
  PRECLASSIFIER_MODE,
  normalizarModoPreclasificador,
  // Exportadas para tests/calibracion; no son parte del contrato estable.
  POSITIVE_TERMS,
  NEGATIVE_TERMS,
  CONTENT_PLACEHOLDER_PATTERNS,
  esContenidoPlaceholder,
  tieneTextoUtil,
};
