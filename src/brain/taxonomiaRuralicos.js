function normalizarTextoTaxonomia(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasPattern(alias) {
  return escapeRegex(normalizarTextoTaxonomia(alias)).replace(/\s+/g, '\\s+');
}

function regexAliases(aliases = []) {
  const patterns = aliases.map(aliasPattern).filter(Boolean);
  if (patterns.length === 0) return /$a/;
  return new RegExp(`(^|[^a-z0-9])(?:${patterns.join('|')})([^a-z0-9]|$)`, 'i');
}

const TAXONOMIA_RURALICOS = [
  {
    id: 'concepto:plazo',
    label: 'Plazo',
    featureTag: 'concepto:plazo',
    featureRegex: /\b(plazo|hasta el|antes del|finaliza|termina|dias habiles|ultimos dias)\b/,
    aliases: ['plazo', 'hasta el', 'dias habiles', 'ultimos dias'],
    feedbackCanonico: 'plazo',
  },
  {
    id: 'accion:solicitar',
    label: 'Solicitud',
    featureTag: 'accion:solicitar',
    featureRegex: /\b(solicitud|solicitar|presentacion|presentar|inscripcion|inscribir)\b/,
    aliases: ['solicitud', 'solicitar', 'presentacion', 'inscripcion'],
  },
  {
    id: 'accion:subsanar',
    label: 'Subsanacion',
    featureTag: 'accion:subsanar',
    featureRegex: /\b(subsanacion|subsanar|requerimiento|documentacion pendiente)\b/,
    aliases: ['subsanacion', 'subsanar', 'requerimiento'],
  },
  {
    id: 'accion:alegar',
    label: 'Alegaciones',
    featureTag: 'accion:alegar',
    featureRegex: /\b(alegaciones|alegar|informacion publica|audiencia)\b/,
    aliases: ['alegaciones', 'alegar', 'informacion publica', 'audiencia'],
  },
  {
    id: 'concepto:ayuda_directa',
    label: 'Ayudas y subvenciones',
    featureTag: 'concepto:ayuda_directa',
    featureRegex: /\b(ayuda|subvencion|prima|pago|indemnizacion|convocatoria)\b/,
    aliases: ['ayuda', 'ayudas', 'subvencion', 'subvenciones', 'subsidio', 'subsidios', 'prima', 'pago', 'convocatoria'],
    feedbackCanonico: 'ayuda',
    tipoAlerta: 'ayudas_subvenciones',
  },
  {
    id: 'concepto:pac',
    label: 'PAC',
    featureTag: 'concepto:pac',
    featureRegex: /\b(pac|fega|feaga|feader|solicitud unica|sigpac|ecoregimen)\b/,
    aliases: ['pac', 'politica agraria comun', 'fega', 'feaga', 'feader', 'solicitud unica', 'sigpac', 'ecoregimenes', 'ecoregimen'],
    feedbackCanonico: 'pac',
    sector: 'agricultura',
  },
  {
    id: 'concepto:fiscalidad',
    label: 'Fiscalidad agraria',
    featureTag: 'concepto:fiscalidad',
    featureRegex: /\b(irpf|iva|modulos|fiscalidad|impuesto|estimacion objetiva)\b/,
    aliases: ['fiscal', 'fiscalidad', 'irpf', 'iva', 'modulos', 'impuesto', 'impuestos', 'estimacion objetiva'],
    feedbackCanonico: 'fiscal',
  },
  {
    id: 'concepto:agua_riego',
    label: 'Agua y regadio',
    featureTag: 'concepto:agua_riego',
    featureRegex: /\b(riego|regadio|regante|comunidad de regantes|acequia|dotacion|concesion de aguas)\b/,
    aliases: ['agua', 'riego', 'regadio', 'regadios', 'pozo', 'pozos', 'comunidad de regantes', 'acequia', 'concesion de aguas'],
    feedbackCanonico: 'agua',
    sector: 'agricultura',
  },
  {
    id: 'concepto:sequia',
    label: 'Sequia',
    featureTag: 'concepto:sequia',
    featureRegex: /\b(sequia|escasez de agua|restricciones de agua|emergencia por sequia)\b/,
    aliases: ['sequia', 'escasez de agua', 'restricciones de agua', 'emergencia por sequia'],
    feedbackCanonico: 'sequia',
  },
  {
    id: 'concepto:sanidad_animal',
    label: 'Sanidad animal',
    featureTag: 'concepto:sanidad_animal',
    featureRegex: /\b(sanidad animal|vacunacion|movimiento de animales|explotacion ganadera|tuberculosis|lengua azul|influenza aviar|peste porcina|fiebre aftosa)\b/,
    aliases: ['sanidad animal', 'vacunacion', 'movimiento animal', 'movimiento de animales', 'tuberculosis', 'lengua azul', 'influenza aviar', 'peste porcina', 'fiebre aftosa'],
    feedbackCanonico: 'sanidad animal',
    sector: 'ganaderia',
  },
  {
    id: 'concepto:bienestar_animal',
    label: 'Bienestar animal',
    featureTag: 'concepto:bienestar_animal',
    featureRegex: /\b(bienestar animal|transporte de animales|nucleo zoologico)\b/,
    aliases: ['bienestar animal', 'transporte de animales', 'nucleo zoologico'],
    feedbackCanonico: 'bienestar animal',
    sector: 'ganaderia',
  },
  {
    id: 'concepto:fitosanitarios',
    label: 'Fitosanitarios y plagas',
    featureTag: 'concepto:fitosanitarios',
    featureRegex: /\b(fitosanitario|plaga|tratamiento|xylella|langosta|mosca de la fruta|mildiu|fertilizante)\b/,
    aliases: ['fitosanitario', 'fitosanitarios', 'plaga', 'plagas', 'tratamiento', 'xylella', 'langosta', 'mosca de la fruta', 'mildiu', 'fertilizante', 'fertilizantes'],
    feedbackCanonico: 'fitosanitarios',
    sector: 'agricultura',
  },
  {
    id: 'concepto:cuaderno_digital',
    label: 'Cuaderno digital',
    featureTag: 'concepto:cuaderno_digital',
    featureRegex: /\b(cuaderno digital|cuaderno de explotacion|siar|reto|registro de tratamientos)\b/,
    aliases: ['cuaderno digital', 'cuaderno de explotacion', 'siar', 'reto', 'registro de tratamientos'],
    feedbackCanonico: 'cuaderno digital',
  },
  {
    id: 'concepto:medio_ambiente',
    label: 'Medio ambiente',
    featureTag: 'concepto:medio_ambiente',
    featureRegex: /\b(zepa|lic|natura 2000|impacto ambiental|evaluacion ambiental|biodiversidad|residuo|purin|nitratos)\b/,
    aliases: ['medio ambiente', 'medioambiental', 'ambiental', 'zepa', 'lic', 'natura 2000', 'impacto ambiental', 'evaluacion ambiental', 'biodiversidad', 'residuo', 'purin', 'purines', 'nitratos'],
    feedbackCanonico: 'medio ambiente',
  },
  {
    id: 'concepto:energia',
    label: 'Energia',
    featureTag: 'concepto:energia',
    featureRegex: /\b(fotovoltaica|energia|electrificacion|autoconsumo|biogas|biometano)\b/,
    aliases: ['energia', 'fotovoltaica', 'electrificacion', 'autoconsumo', 'biogas', 'biometano'],
  },
  {
    id: 'concepto:maquinaria_agricola',
    label: 'Maquinaria agricola',
    featureTag: 'concepto:maquinaria_agricola',
    aliases: ['maquinaria agricola', 'maquinaria', 'maquina', 'maquinas', 'tractor', 'tractores', 'apero', 'aperos', 'modernizacion', 'inversiones en explotaciones'],
    feedbackCanonico: 'maquinaria agricola',
    sector: 'agricultura',
  },
  {
    id: 'concepto:incorporacion_joven',
    label: 'Jovenes agricultores',
    featureTag: 'concepto:incorporacion_joven',
    aliases: ['joven agricultor', 'jovenes agricultores', 'incorporacion', 'primera instalacion'],
    feedbackCanonico: 'jovenes agricultores',
    sector: 'agricultura',
  },
  {
    id: 'entidad:cooperativa',
    label: 'Cooperativas y SAT',
    featureTag: 'entidad:cooperativa',
    featureRegex: /\b(cooperativa|sat|sociedad agraria de transformacion)\b/,
    aliases: ['cooperativa', 'cooperativas', 'sat', 'sociedad agraria de transformacion'],
    feedbackCanonico: 'cooperativas',
  },
  {
    id: 'entidad:comunidad_regantes',
    label: 'Comunidades de regantes',
    featureTag: 'entidad:comunidad_regantes',
    featureRegex: /\b(comunidad de regantes|junta central de usuarios|confederacion hidrografica)\b/,
    aliases: ['comunidad de regantes', 'comunidades de regantes', 'junta central de usuarios', 'confederacion hidrografica'],
    feedbackCanonico: 'comunidad de regantes',
  },
  {
    id: 'entidad:ayuntamiento',
    label: 'Ayuntamientos',
    featureTag: 'entidad:ayuntamiento',
    featureRegex: /\b(ayuntamiento|municipio|termino municipal)\b/,
    aliases: ['ayuntamiento', 'ayuntamientos', 'municipio', 'termino municipal'],
  },
  {
    id: 'tramite:individual',
    label: 'Tramite individual',
    featureTag: 'tramite:individual',
    featureRegex: /\b(expediente|solicitud de concesion|concesion de aguas?|aprovechamiento de aguas?|solicitud de autorizacion|autorizacion de vertido|autorizacion ambiental|autorizacion administrativa previa|termino municipal|adjudicacion directa|notificacion individual)\b/,
    aliases: ['expediente', 'solicitud de concesion', 'concesion de aguas', 'aprovechamiento de aguas', 'notificacion individual'],
  },
  {
    id: 'tramite:nombramiento',
    label: 'Nombramiento',
    featureTag: 'tramite:nombramiento',
    featureRegex: /\b(nombramiento|cese|designacion|vocal|cargo)\b/,
    aliases: ['nombramiento', 'cese', 'designacion', 'vocal', 'cargo'],
  },
  {
    id: 'tramite:licitacion',
    label: 'Licitacion',
    featureTag: 'tramite:licitacion',
    featureRegex: /\b(licitacion|contrato|contratos|adjudicacion de contrato|formalizacion de contrato|formalizacion de contratos|anuncio de formalizacion)\b/,
    aliases: ['licitacion', 'licitaciones', 'contrato', 'contratos', 'adjudicacion de contrato', 'formalizacion de contrato'],
    feedbackCanonico: 'licitacion',
  },
  { id: 'sector:agricultura', label: 'Agricultura', featureTag: 'sector:agricultura', aliases: ['agricultura', 'agricola', 'cultivo', 'cultivos'], feedbackCanonico: 'agricultura', sector: 'agricultura' },
  { id: 'sector:ganaderia', label: 'Ganaderia', featureTag: 'sector:ganaderia', aliases: ['ganaderia', 'ganadero', 'ganadera', 'explotacion ganadera'], feedbackCanonico: 'ganaderia', sector: 'ganaderia' },
  { id: 'subsector:olivar', label: 'Olivar', featureTag: 'subsector:olivar', aliases: ['olivar', 'olivo', 'olivos', 'aceituna', 'aceitunas'], feedbackCanonico: 'olivar', sector: 'agricultura' },
  { id: 'subsector:vinedo', label: 'Vinedo', featureTag: 'subsector:vinedo', aliases: ['vinedo', 'vinedos', 'vino', 'uva', 'uvas', 'vid', 'vina', 'vinas', 'viticultura'], feedbackCanonico: 'vinedo', sector: 'agricultura' },
  { id: 'subsector:almendro', label: 'Almendro', featureTag: 'subsector:almendro', aliases: ['almendro', 'almendros', 'almendra', 'almendras'], feedbackCanonico: 'almendro', sector: 'agricultura' },
  { id: 'subsector:citricos', label: 'Citricos', featureTag: 'subsector:citricos', aliases: ['citricos', 'citrico', 'naranja', 'naranjas', 'limon', 'limones'], feedbackCanonico: 'citricos', sector: 'agricultura' },
  { id: 'subsector:cereal', label: 'Cereal', featureTag: 'subsector:cereal', aliases: ['cereal', 'cereales'], feedbackCanonico: 'cereal', sector: 'agricultura' },
  { id: 'subsector:trigo', label: 'Trigo', featureTag: 'subsector:trigo', aliases: ['trigo'], feedbackCanonico: 'trigo', sector: 'agricultura' },
  { id: 'subsector:cebada', label: 'Cebada', featureTag: 'subsector:cebada', aliases: ['cebada'], feedbackCanonico: 'cebada', sector: 'agricultura' },
  { id: 'subsector:maiz', label: 'Maiz', featureTag: 'subsector:maiz', aliases: ['maiz'], feedbackCanonico: 'maiz', sector: 'agricultura' },
  { id: 'subsector:arroz', label: 'Arroz', featureTag: 'subsector:arroz', aliases: ['arroz'], feedbackCanonico: 'arroz', sector: 'agricultura' },
  { id: 'subsector:hortalizas', label: 'Hortalizas', featureTag: 'subsector:hortalizas', aliases: ['hortaliza', 'hortalizas', 'huerta', 'horticolas'], feedbackCanonico: 'hortalizas', sector: 'agricultura' },
  { id: 'subsector:frutal', label: 'Frutales', featureTag: 'subsector:frutal', aliases: ['frutal', 'frutales', 'fruta'], feedbackCanonico: 'frutal', sector: 'agricultura' },
  { id: 'subsector:patata', label: 'Patata', featureTag: 'subsector:patata', aliases: ['patata', 'patatas'], feedbackCanonico: 'patata', sector: 'agricultura' },
  { id: 'subsector:leguminosa', label: 'Leguminosas', featureTag: 'subsector:leguminosa', aliases: ['leguminosa', 'leguminosas'], feedbackCanonico: 'leguminosa', sector: 'agricultura' },
  { id: 'subsector:forestal', label: 'Forestal', featureTag: 'subsector:forestal', aliases: ['forestal', 'monte', 'montes', 'bosque', 'bosques'], feedbackCanonico: 'forestal', sector: 'agricultura' },
  { id: 'subsector:trufa', label: 'Trufa', featureTag: 'subsector:trufa', aliases: ['trufa', 'trufas'], feedbackCanonico: 'trufa', sector: 'agricultura' },
  { id: 'subsector:ovino', label: 'Ovino', featureTag: 'subsector:ovino', aliases: ['ovino', 'oveja', 'ovejas', 'cordero', 'corderos', 'ganado ovino'], feedbackCanonico: 'ovino', sector: 'ganaderia' },
  { id: 'subsector:caprino', label: 'Caprino', featureTag: 'subsector:caprino', aliases: ['caprino', 'cabra', 'cabras', 'cabrito'], feedbackCanonico: 'caprino', sector: 'ganaderia' },
  { id: 'subsector:vacuno', label: 'Vacuno', featureTag: 'subsector:vacuno', aliases: ['vacuno', 'vaca', 'vacas', 'bovino', 'bovinos'], feedbackCanonico: 'vacuno', sector: 'ganaderia' },
  { id: 'subsector:porcino', label: 'Porcino', featureTag: 'subsector:porcino', aliases: ['porcino', 'cerdo', 'cerdos', 'cochino', 'cochinos'], feedbackCanonico: 'porcino', sector: 'ganaderia' },
  { id: 'subsector:avicultura', label: 'Avicultura', featureTag: 'subsector:avicultura', aliases: ['avicultura', 'avicola', 'pollo', 'pollos', 'gallina', 'gallinas'], feedbackCanonico: 'avicultura', sector: 'ganaderia' },
  { id: 'subsector:apicultura', label: 'Apicultura', featureTag: 'subsector:apicultura', aliases: ['apicultura', 'abeja', 'abejas', 'miel'], feedbackCanonico: 'apicultura', sector: 'ganaderia' },
  { id: 'subsector:cunicultura', label: 'Cunicultura', featureTag: 'subsector:cunicultura', aliases: ['cunicultura', 'conejo', 'conejos'], feedbackCanonico: 'cunicultura', sector: 'ganaderia' },
  { id: 'concepto:pastos', label: 'Pastos', featureTag: 'concepto:pastos', aliases: ['pasto', 'pastos', 'forraje', 'forrajes', 'pradera', 'praderas'], feedbackCanonico: 'pastos', sector: 'ganaderia' },
  { id: 'concepto:purines_estiercoles', label: 'Purines y estiercoles', featureTag: 'concepto:purines_estiercoles', aliases: ['purin', 'purines', 'estiercol', 'estiercoles', 'deyeccion', 'deyecciones'], feedbackCanonico: 'purines', sector: 'ganaderia' },
  { id: 'concepto:seguros_agrarios', label: 'Seguros agrarios', featureTag: 'concepto:seguros_agrarios', aliases: ['seguro agrario', 'seguros agrarios', 'agroseguro'], feedbackCanonico: 'seguros agrarios' },
  { id: 'concepto:ecologico', label: 'Produccion ecologica', featureTag: 'concepto:ecologico', aliases: ['ecologico', 'ecologica', 'produccion ecologica', 'agricultura ecologica'], feedbackCanonico: 'ecologico' },
  { id: 'concepto:formacion', label: 'Cursos y formacion', featureTag: 'concepto:formacion', aliases: ['curso', 'cursos', 'formacion', 'jornada', 'jornadas'], feedbackCanonico: 'formacion' },
  { id: 'concepto:normativa', label: 'Normativa', featureTag: 'concepto:normativa', aliases: ['normativa', 'norma', 'normas', 'ley', 'leyes', 'obligacion', 'prohibicion'], feedbackCanonico: 'normativa' },
  { id: 'concepto:infraestructura', label: 'Infraestructuras', featureTag: 'concepto:infraestructura', aliases: ['infraestructura', 'infraestructuras', 'obra', 'obras'], feedbackCanonico: 'infraestructura' },
];

const REGLAS_FEATURES_TAXONOMIA = TAXONOMIA_RURALICOS
  .filter((item) => item.featureTag)
  .map((item) => [item.featureTag, item.featureRegex || regexAliases(item.aliases)]);

const TEMAS_FEEDBACK_RURALICOS = Object.values(TAXONOMIA_RURALICOS.reduce((acc, item) => {
  if (!item.feedbackCanonico) return acc;
  const canonico = item.feedbackCanonico;
  const actual = acc[canonico] || { canonico, aliases: [] };
  actual.aliases.push(canonico, ...(item.aliases || []));
  acc[canonico] = actual;
  return acc;
}, {})).map((item) => ({
  canonico: item.canonico,
  aliases: [...new Set(item.aliases.map(normalizarTextoTaxonomia).filter(Boolean))],
}));

function extraerFeatureTagsDeTexto(texto) {
  const normalizado = normalizarTextoTaxonomia(texto);
  const features = new Set();

  for (const [tag, regex] of REGLAS_FEATURES_TAXONOMIA) {
    if (regex.test(normalizado)) features.add(tag);
  }

  return [...features];
}

function temaCanonicoTaxonomia(tema) {
  const normalizado = normalizarTextoTaxonomia(tema);
  const found = TEMAS_FEEDBACK_RURALICOS.find((item) => item.aliases.includes(normalizado));
  return found ? found.canonico : normalizado;
}

function aliasesTemaFeedback(canonico) {
  const normalizado = temaCanonicoTaxonomia(canonico);
  const found = TEMAS_FEEDBACK_RURALICOS.find((item) => item.canonico === normalizado);
  return found ? found.aliases : [normalizado].filter(Boolean);
}

function buscarSugerenciasTaxonomia(query, limit = 8) {
  const q = normalizarTextoTaxonomia(query);
  if (!q) return [];

  return TAXONOMIA_RURALICOS
    .map((item) => {
      const aliases = [item.label, ...(item.aliases || [])].map(normalizarTextoTaxonomia);
      const exact = aliases.some((alias) => alias === q);
      const starts = aliases.some((alias) => alias.startsWith(q));
      const includes = aliases.some((alias) => alias.includes(q));
      const score = exact ? 3 : starts ? 2 : includes ? 1 : 0;
      return { item, score };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
    .slice(0, Math.max(1, Number(limit) || 8))
    .map(({ item }) => ({
      id: item.id,
      label: item.label,
      sector: item.sector || null,
      feedback_canonico: item.feedbackCanonico || null,
    }));
}

module.exports = {
  TAXONOMIA_RURALICOS,
  REGLAS_FEATURES_TAXONOMIA,
  TEMAS_FEEDBACK_RURALICOS,
  aliasesTemaFeedback,
  buscarSugerenciasTaxonomia,
  extraerFeatureTagsDeTexto,
  normalizarTextoTaxonomia,
  regexAliases,
  temaCanonicoTaxonomia,
};
