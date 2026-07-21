const PREFILTER_ACTION = Object.freeze({
  PASS: 'pass',
  REVIEW: 'review',
  DISCARD: 'discard',
});

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

// Describen el organismo o la forma administrativa. Son contexto, no una
// prueba de que el contenido sea ajeno al mundo rural.
const SENALES_ADMINISTRATIVAS = [
  'ayuntamiento', 'ajuntament', 'concello',
  'diputacion', 'diputacio', 'deputacion', 'cabildo', 'cabildo insular',
  'mancomunidad', 'concejo', 'municipio', 'consell insular', 'udal',
  'administracion publica', 'presidencia',
  'departamento', 'consejeria', 'conselleria', 'direccion general',
  'resolucion', 'edicto', 'edicte',
  'presupuesto', 'pressupost', 'orzamento',
  'universidad', 'universitat', 'universidade',
  'convenio', 'conveni',
];

// Estos patrones sí describen ruido suficientemente concreto. Se descartan
// incluso si contienen palabras rurales accidentales (por ejemplo, una bolsa
// de empleo para un puesto de técnico agrícola).
const DESCARTES_FUERTES = [
  'oposiciones', 'oposicions', 'convocatoria de oposicion',
  'convocatoria de oposiciones', 'oposicion al cuerpo',
  'proceso selectivo', 'procesos selectivos', 'pruebas selectivas',
  'proces selectiu', 'proceso selectiu',
  'bolsa de empleo', 'bolsas de empleo', 'borsa de treball',
  'borsa d ocupacio', 'bolsa de traballo',
  'empleo publico', 'oferta de empleo publico',
  'provision de puestos', 'provision de un puesto', 'provision de postos',
  'concurso de traslados',
  'nombramiento individual', 'nombramiento de funcionario',
  'nombramiento de personal', 'nombramiento como',
  'nomenament de personal', 'nomeamento de persoal', 'nomeamento individual',
  'padron tributario', 'padron fiscal', 'padron de contribuyentes',
  'subvencion exclusivamente deportiva', 'subvenciones exclusivamente deportivas',
  'notificacion personal', 'notificacio personal', 'notificacion persoal',
  'expediente sancionador individual', 'expedient sancionador individual',
];

// Solo son descarte cuando no hay ninguna materia rural explícita. Así, un
// convenio colectivo agrario o una beca de investigación agraria se revisan.
const DESCARTES_SIN_SENAL_RURAL = [
  'beca general', 'becas generales', 'becas de caracter general',
  'convenio colectivo',
  'subvencion deportiva', 'subvenciones deportivas',
  'ayudas a clubes deportivos', 'ayudas a entidades deportivas',
];

const SENALES_RURALES = [
  'agricultur', 'ganader', 'ramader', 'ganderi', 'abeltzaint', 'nekazar',
  'agrari', 'agroalimentari', 'rural',
  'forest', 'silvicultur', 'gestion forestal', 'ordenacion de montes',
  'incendio forestal', 'monte', 'mont', 'mendi', 'dehesa',
  'pac', 'fega', 'feader', 'feaga', 'solicitud unica',
  'ayuda', 'ajuda', 'axuda', 'subvenc', 'bases reguladoras', 'convocatoria',
  'regadio', 'regadiu', 'regad', 'riego', 'regante', 'regant',
  'comunidad de regantes', 'agua', 'aigua', 'auga',
  'fitosanit', 'zoosanit', 'sanidad animal', 'sanitat animal',
  'bienestar animal', 'veterinari', 'plaga', 'praga',
  'fertiliz', 'semilla', 'material vegetal', 'produccion ecologica',
  'agricultura ecologica', 'purin', 'estiercol', 'deyeccion', 'nitrato',
  'caza', 'caca', 'aprovechamiento', 'aproveitamento', 'aprovechament',
  'vias pecuarias', 'via pecuaria', 'trashumancia', 'pastos', 'pastizal',
  'vitivinicol', 'vinedo', 'vinya', 'olivar', 'frutal', 'fruiter',
  'cereal', 'forraje', 'farratge', 'pasto', 'explotacion agraria',
  'explotacion ganadera', 'apicultur',
  'denominacion de origen', 'denominacio d origen', 'denominacion de orixe',
  'indicacion geografica', 'calidad alimentaria', 'calidade alimentaria',
  'industria agroalimentaria', 'industria alimentaria',
  'pesca', 'acuicultura', 'marisqu',
  'leader', 'grupo de accion local',
];

// Son indicios útiles, pero demasiado amplios para declarar por sí solos que
// el documento es rural. Se envían a review.
const SENALES_RURALES_DEBILES = new Set([
  'ayuda', 'ajuda', 'axuda', 'subvenc', 'bases reguladoras', 'convocatoria',
  'agua', 'aigua', 'auga', 'aprovechamiento', 'aproveitamento', 'aprovechament',
]);

// Estas señales cortas generaban falsos positivos por substring: "vid" en
// "actividad", "PAC" en "espacio" o "udal" en "caudal".
const SENALES_DE_PALABRA_COMPLETA = new Set([
  'pac', 'vid', 'udal', 'agro', 'caca', 'caza', 'vino', 'pasto',
]);

function contieneSenal(textoNormalizado, senal) {
  const termino = normalizar(senal).trim();
  if (!termino) return false;

  if (SENALES_DE_PALABRA_COMPLETA.has(termino)) {
    const patron = new RegExp(`(?:^|[^a-z0-9])${termino}(?:$|[^a-z0-9])`);
    return patron.test(textoNormalizado);
  }
  return textoNormalizado.includes(termino);
}

function encontrarSenales(textoNormalizado, palabras) {
  const encontradas = [];
  const vistas = new Set();

  for (const palabra of palabras) {
    const normalizada = normalizar(palabra).trim();
    if (!normalizada || vistas.has(normalizada)) continue;
    vistas.add(normalizada);
    if (contieneSenal(textoNormalizado, normalizada)) encontradas.push(normalizada);
  }

  return encontradas;
}

function quitarNegacionesRurales(textoNormalizado) {
  return textoNormalizado
    .replace(/\bno\s+(?:agrari\w*|agricol\w*|ganader\w*|rural\w*)\b/g, ' ')
    .replace(
      /\bsin\s+(?:relacion|contenido|actividad|afeccion|impacto)\s+(?:agrari\w*|agricol\w*|ganader\w*|rural\w*)\b/g,
      ' '
    );
}

function crearDecision(action, positiveSignals, negativeSignals, reasonCode) {
  return { action, positiveSignals, negativeSignals, reasonCode };
}

function crearPrefiltroRural({ excluir = [], incluir = [] } = {}) {
  const senalesPositivas = [...SENALES_RURALES, ...incluir];
  const senalesNegativas = [
    ...SENALES_ADMINISTRATIVAS,
    ...DESCARTES_FUERTES,
    ...DESCARTES_SIN_SENAL_RURAL,
    ...excluir,
  ];

  return function decidirPrefiltroRural(texto) {
    const textoNormalizado = normalizar(texto);
    const textoParaSenalesRurales = quitarNegacionesRurales(textoNormalizado);
    const positiveSignals = encontrarSenales(textoParaSenalesRurales, senalesPositivas);
    const negativeSignals = encontrarSenales(textoNormalizado, senalesNegativas);
    const descartesFuertes = encontrarSenales(textoNormalizado, DESCARTES_FUERTES);
    const descartesSinRural = encontrarSenales(textoNormalizado, DESCARTES_SIN_SENAL_RURAL);
    const senalesRuralesExplicitas = positiveSignals.filter(
      (senal) => !SENALES_RURALES_DEBILES.has(senal)
    );

    if (descartesFuertes.length > 0) {
      return crearDecision(
        PREFILTER_ACTION.DISCARD,
        positiveSignals,
        negativeSignals,
        'strong_non_rural_signal'
      );
    }

    if (senalesRuralesExplicitas.length === 0 && descartesSinRural.length > 0) {
      return crearDecision(
        PREFILTER_ACTION.DISCARD,
        positiveSignals,
        negativeSignals,
        'strong_non_rural_signal'
      );
    }

    if (senalesRuralesExplicitas.length > 0 && negativeSignals.length > 0) {
      return crearDecision(
        PREFILTER_ACTION.REVIEW,
        positiveSignals,
        negativeSignals,
        'conflicting_signals'
      );
    }

    if (senalesRuralesExplicitas.length > 0) {
      return crearDecision(
        PREFILTER_ACTION.PASS,
        positiveSignals,
        negativeSignals,
        'explicit_rural_signal'
      );
    }

    if (positiveSignals.length > 0) {
      return crearDecision(
        PREFILTER_ACTION.REVIEW,
        positiveSignals,
        negativeSignals,
        'weak_rural_signals'
      );
    }

    if (negativeSignals.length > 0) {
      return crearDecision(
        PREFILTER_ACTION.REVIEW,
        positiveSignals,
        negativeSignals,
        'administrative_signals_only'
      );
    }

    return crearDecision(
      PREFILTER_ACTION.REVIEW,
      positiveSignals,
      negativeSignals,
      'insufficient_signals'
    );
  };
}

function normalizarDecisionPrefiltro(resultado) {
  if (
    resultado
    && typeof resultado === 'object'
    && Object.values(PREFILTER_ACTION).includes(resultado.action)
  ) {
    return crearDecision(
      resultado.action,
      Array.isArray(resultado.positiveSignals) ? resultado.positiveSignals : [],
      Array.isArray(resultado.negativeSignals) ? resultado.negativeSignals : [],
      resultado.reasonCode || 'unspecified'
    );
  }

  // Compatibilidad temporal con filtros booleanos usados por pruebas y scrapers
  // externos. Las rutas de Ruralicos ya producen decisiones estructuradas.
  if (resultado === false) {
    return crearDecision(PREFILTER_ACTION.DISCARD, [], [], 'legacy_boolean_discard');
  }
  if (resultado === true) {
    return crearDecision(PREFILTER_ACTION.PASS, [], [], 'legacy_boolean_pass');
  }
  return crearDecision(PREFILTER_ACTION.REVIEW, [], [], 'invalid_prefilter_result');
}

function evaluarPrefiltroRural(prefiltro, texto) {
  const resultado = typeof prefiltro === 'function' ? prefiltro(texto) : null;
  return normalizarDecisionPrefiltro(resultado);
}

const esRuralRelevante = crearPrefiltroRural();

module.exports = {
  PREFILTER_ACTION,
  normalizar,
  crearPrefiltroRural,
  evaluarPrefiltroRural,
  normalizarDecisionPrefiltro,
  esRuralRelevante,
  SENALES_ADMINISTRATIVAS,
  SENALES_RURALES,
  DESCARTES_FUERTES,
  DESCARTES_SIN_SENAL_RURAL,
  // Alias para consumidores antiguos. El contenido ya no implica que toda
  // señal negativa sea una exclusión definitiva.
  EXCLUIR_FUERTE: SENALES_ADMINISTRATIVAS,
  INCLUIR_RURAL: SENALES_RURALES,
};
