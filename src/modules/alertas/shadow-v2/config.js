const AI1_MODEL = 'gpt-5-nano';
const AI2_MODEL = 'gpt-5.6-luna';

const VERSIONS = Object.freeze({
  engine: 'shadow-v2-1',
  ai1Contract: 'shadow-v2-ai1-1',
  ai1Prompt: 'shadow-v2-ai1-prompt-1',
  ai2Contract: 'shadow-v2-ai2-1',
  ai2Prompt: 'shadow-v2-ai2-prompt-1',
  render: 'shadow-v2-render-1',
});

const DEFAULT_LIMITS = Object.freeze({
  maxAlerts: 100,
  maxUsers: 25,
  maxCandidatesPerUser: 30,
  maxTotalCalls: 125,
  maxOfficialCharsPerAlert: 30000,
  maxPersonalPromptChars: 60000,
  maxSelected: 5,
});

const LIMIT_BOUNDS = Object.freeze({
  maxAlerts: [1, 500],
  maxUsers: [1, 250],
  maxCandidatesPerUser: [1, 100],
  maxTotalCalls: [1, 750],
  maxOfficialCharsPerAlert: [1000, 180000],
  maxPersonalPromptChars: [2000, 180000],
  maxSelected: [1, 5],
});

const RURAL_ORGANIZATIONS = Object.freeze([
  'ministerio de agricultura',
  'ministerio para la transicion ecologica',
  'consejeria de agricultura',
  'consejeria de ganaderia',
  'consejeria de medio ambiente',
  'direccion general de agricultura',
  'direccion general de ganaderia',
  'direccion general de desarrollo rural',
  'direccion general del agua',
  'direccion general de montes',
  'fondo espanol de garantia agraria',
  'fega',
  'confederacion hidrografica',
  'sanidad animal',
  'sanidad vegetal',
]);

const POSITIVE_TERMS_BY_TOPIC = Object.freeze({
  ayudas: ['ayuda', 'ayudas', 'subvencion', 'subvenciones', 'convocatoria', 'indemnizacion'],
  pac: ['pac', 'feader', 'fega', 'pago basico', 'eco regimen'],
  explotaciones: ['explotacion agraria', 'explotaciones agrarias', 'titular de explotacion'],
  agricultura: ['agricultura', 'agricola', 'agricultor', 'cultivo', 'cultivos', 'frutal', 'frutales'],
  ganaderia: ['ganaderia', 'ganadero', 'ganado', 'bovino', 'ovino', 'caprino', 'porcino', 'avicola'],
  agua: ['regadio', 'riego', 'agua', 'pozo', 'pozos', 'concesion de aguas', 'comunidad de regantes'],
  sanidad: ['sanidad animal', 'sanidad vegetal', 'sacrificio obligatorio', 'plaga', 'epizootia'],
  clima: ['incendio forestal', 'sequia', 'seguro agrario', 'seguros agrarios'],
  territorio: ['monte', 'montes', 'pasto', 'pastos', 'parcela', 'parcelas', 'concentracion parcelaria'],
  obligaciones: ['fiscalidad agraria', 'registro agrario', 'autorizacion', 'obligacion', 'plazo', 'alegacion', 'purin', 'purines'],
  rural: ['medio rural', 'desarrollo rural', 'sector agrario', 'actividad agraria'],
});

const UNAMBIGUOUS_NEGATIVE_TERMS = Object.freeze([
  'extravío de titulo',
  'extravío del titulo',
  'extravío de título',
  'extravío del título',
  'nombramiento',
  'cese',
  'presupuesto municipal',
  'presupuestos municipales',
  'cuenta general',
  'cuentas generales',
  'delegacion de alcaldia',
  'delegaciones de alcaldia',
  'memoria historica',
  'bolsa de empleo',
  'bolsas de empleo',
]);

const AI1_STATUS = Object.freeze(['active', 'upcoming', 'closed', 'informational', 'unknown']);
const CONTENT_TYPES = Object.freeze([
  'aid',
  'obligation',
  'opportunity',
  'procedure',
  'warning',
  'information',
]);

const REGION_PROVINCES = Object.freeze({
  andalucia: ['almeria', 'cadiz', 'cordoba', 'granada', 'huelva', 'jaen', 'malaga', 'sevilla'],
  aragon: ['huesca', 'teruel', 'zaragoza'],
  asturias: ['asturias'],
  'principado de asturias': ['asturias'],
  cantabria: ['cantabria'],
  'castilla y leon': ['avila', 'burgos', 'leon', 'palencia', 'salamanca', 'segovia', 'soria', 'valladolid', 'zamora'],
  'castilla-la mancha': ['albacete', 'ciudad real', 'cuenca', 'guadalajara', 'toledo'],
  cataluna: ['barcelona', 'girona', 'gerona', 'lleida', 'lerida', 'tarragona'],
  extremadura: ['badajoz', 'caceres'],
  galicia: ['a coruna', 'la coruna', 'lugo', 'ourense', 'orense', 'pontevedra'],
  'islas baleares': ['illes balears', 'baleares'],
  'illes balears': ['illes balears', 'baleares'],
  baleares: ['illes balears', 'baleares'],
  canarias: ['las palmas', 'santa cruz de tenerife'],
  'la rioja': ['la rioja'],
  madrid: ['madrid'],
  'comunidad de madrid': ['madrid'],
  murcia: ['murcia'],
  'region de murcia': ['murcia'],
  navarra: ['navarra'],
  'comunidad foral de navarra': ['navarra'],
  'pais vasco': ['alava', 'araba', 'bizkaia', 'vizcaya', 'gipuzkoa', 'guipuzcoa'],
  euskadi: ['alava', 'araba', 'bizkaia', 'vizcaya', 'gipuzkoa', 'guipuzcoa'],
  'comunitat valenciana': ['alicante', 'alacant', 'castellon', 'castello', 'valencia'],
  'comunidad valenciana': ['alicante', 'alacant', 'castellon', 'castello', 'valencia'],
  ceuta: ['ceuta'],
  melilla: ['melilla'],
});

function boundedInteger(value, fallback, [min, max]) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeLimits(overrides = {}) {
  return Object.fromEntries(
    Object.entries(DEFAULT_LIMITS).map(([key, fallback]) => [
      key,
      boundedInteger(overrides[key], fallback, LIMIT_BOUNDS[key]),
    ])
  );
}

module.exports = {
  AI1_MODEL,
  AI2_MODEL,
  VERSIONS,
  DEFAULT_LIMITS,
  LIMIT_BOUNDS,
  RURAL_ORGANIZATIONS,
  POSITIVE_TERMS_BY_TOPIC,
  UNAMBIGUOUS_NEGATIVE_TERMS,
  AI1_STATUS,
  CONTENT_TYPES,
  REGION_PROVINCES,
  normalizeLimits,
};
