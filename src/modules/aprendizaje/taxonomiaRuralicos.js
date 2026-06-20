const { normalizarPreferenciasUsuario } = require('../../shared/preferenceCanonical');

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

function regexAliasGlobal(alias) {
  const pattern = aliasPattern(alias);
  if (!pattern) return null;
  return new RegExp(`(^|[^a-z0-9])(${pattern})([^a-z0-9]|$)`, 'gi');
}

const NEGACION_CERCA_RE = /\b(no quiero|no me interesa(?:n)?|no necesito|evitar|excluir|quitar|quita|fuera|menos|sin|ni)\b/i;
const INTENCION_POSITIVA_RE = /\b(me interesa(?:n)?|quiero|necesito|recibir|avisos?|alertas?|sobre|busco|tengo|cultivo|cultivos|explotacion|actividad)\b/i;
const CONECTORES_CAMBIO_INTENCION_RE = /\b(sin embargo|aun asi|eso si|pero|aunque|salvo|excepto)\b/gi;
const SEPARADOR_FRASE_RE = /[.!?;]/g;
const INTENCION_AFIRMATIVA_CLAUSULA_RE = /\b(si me interesa(?:n)?|si quiero|(?<!no\s)(?<!no me\s)(me interesa(?:n)?|quiero|necesito|busco|recibir|avisos?|alertas?|salvo|excepto))\b/i;

function tipoTaxonomia(id = '') {
  return String(id).split(':')[0] || 'tag';
}

function valorTaxonomia(id = '') {
  return String(id).split(':').slice(1).join(':') || id;
}

function uniquePush(target, value) {
  const normalized = normalizarTextoTaxonomia(value);
  if (normalized && !target.includes(normalized)) target.push(normalized);
}

function tipoAlertaDesdeItem(item = {}) {
  if (item.tipoAlerta) return item.tipoAlerta;
  if (item.id === 'concepto:ayuda_directa') return 'ayudas_subvenciones';
  if (item.id === 'concepto:plazo') return 'plazos';
  if (item.id === 'concepto:normativa') return 'normativa_general';
  if (item.id === 'concepto:formacion') return 'formacion';
  if (item.id === 'concepto:agua_riego') return 'agua_infraestructuras';
  if (item.id === 'concepto:fiscalidad') return 'fiscalidad';
  if (item.id === 'concepto:medio_ambiente') return 'medio_ambiente';
  if (item.id === 'tramite:licitacion') return 'licitaciones';
  return null;
}

function prioridadItem(item = {}) {
  const type = tipoTaxonomia(item.id);
  if (Number.isFinite(Number(item.priority))) return Number(item.priority);
  if (type === 'sector') return 40;
  if (type === 'subsector') return 80;
  if (type === 'concepto') return 70;
  if (type === 'accion') return 55;
  if (type === 'entidad') return 45;
  if (type === 'tramite') return 35;
  return 30;
}

const TAXONOMIA_RURALICOS = [
  {
    id: 'concepto:plazo',
    label: 'Plazo',
    featureTag: 'concepto:plazo',
    featureRegex: /\b(plazos?|hasta el|antes del|finaliza|finalizan|termina|terminan|vence|vencimiento|fecha limite|fecha de fin|dias habiles|dias naturales|ultimos dias|cierre de plazo|periodo de solicitud)\b/,
    aliases: ['plazo', 'plazos', 'hasta el', 'antes del', 'fecha limite', 'fecha de fin', 'vencimiento', 'dias habiles', 'dias naturales', 'ultimos dias', 'cierre de plazo', 'periodo de solicitud'],
    feedbackCanonico: 'plazo',
  },
  {
    id: 'accion:solicitar',
    label: 'Solicitud',
    featureTag: 'accion:solicitar',
    featureRegex: /\b(solicitud|solicitudes|solicitar|presentacion|presentar|inscripcion|inscribir|inscribirse|tramitar|cumplimentar|formulario)\b/,
    aliases: ['solicitud', 'solicitudes', 'solicitar', 'presentacion', 'presentar', 'inscripcion', 'inscribirse', 'tramitar', 'formulario'],
  },
  {
    id: 'accion:subsanar',
    label: 'Subsanacion',
    featureTag: 'accion:subsanar',
    featureRegex: /\b(subsanacion|subsanar|requerimiento|requerimientos|documentacion pendiente|aportar documentacion|completar la solicitud)\b/,
    aliases: ['subsanacion', 'subsanar', 'requerimiento', 'documentacion pendiente', 'aportar documentacion'],
  },
  {
    id: 'accion:alegar',
    label: 'Alegaciones',
    featureTag: 'accion:alegar',
    featureRegex: /\b(alegaciones|alegar|informacion publica|exposicion publica|audiencia|tramite de audiencia|periodo de consulta|consulta publica)\b/,
    aliases: ['alegaciones', 'alegar', 'informacion publica', 'exposicion publica', 'audiencia', 'consulta publica'],
  },
  {
    id: 'concepto:ayuda_directa',
    label: 'Ayudas y subvenciones',
    featureTag: 'concepto:ayuda_directa',
    featureRegex: /\b(ayudas?|subvencion(?:es|ada|adas|ado|ados|able|ables)?|primas?|pagos?|indemnizaciones?|convocatorias?|bases reguladoras|extracto de la convocatoria|linea de ayuda|lineas de ayuda|incentivos?|bonificaciones?|fondos? europeos?)\b/,
    excludeRegex: /\b(pago|pagos)\s+de\s+(tasas|impuestos|recibos|multas)\b/,
    aliases: ['ayuda', 'ayudas', 'subvencion', 'subvenciones', 'subvencionada', 'subvencionadas', 'subvencionado', 'subvencionados', 'subvencionable', 'subvencionables', 'subsidio', 'subsidios', 'prima', 'primas', 'pago', 'pagos', 'indemnizacion', 'indemnizaciones', 'convocatoria', 'convocatorias', 'bases reguladoras', 'linea de ayuda', 'lineas de ayuda', 'incentivo', 'incentivos', 'bonificacion', 'fondos europeos', 'extracto de la convocatoria'],
    feedbackCanonico: 'ayuda',
    tipoAlerta: 'ayudas_subvenciones',
  },
  {
    id: 'concepto:pac',
    label: 'PAC',
    featureTag: 'concepto:pac',
    featureRegex: /\b(pac|fega|feaga|feader|solicitud unica|sigpac|ecoregimen|ecoregimenes|condicionalidad|condicionalidad reforzada|pago basico|ayuda basica a la renta|derechos de pago|cuaderno de campo|dun|declaracion unica)\b/,
    aliases: ['pac', 'politica agraria comun', 'fega', 'feaga', 'feader', 'solicitud unica', 'sigpac', 'ecoregimenes', 'ecoregimen', 'condicionalidad', 'condicionalidad reforzada', 'pago basico', 'ayuda basica a la renta', 'derechos de pago', 'dun', 'declaracion unica'],
    feedbackCanonico: 'pac',
    sector: 'agricultura',
  },
  {
    id: 'concepto:fiscalidad',
    label: 'Fiscalidad agraria',
    featureTag: 'concepto:fiscalidad',
    featureRegex: /\b(irpf|iva|modulos|fiscalidad|fiscal|impuesto|impuestos|tributacion|estimacion objetiva|gasoleo agricola|devolucion del gasoleo|coeficientes de rendimiento)\b/,
    aliases: ['fiscal', 'fiscalidad', 'irpf', 'iva', 'modulos', 'impuesto', 'impuestos', 'tributacion', 'estimacion objetiva', 'gasoleo agricola', 'devolucion del gasoleo', 'coeficientes de rendimiento'],
    feedbackCanonico: 'fiscal',
  },
  {
    id: 'concepto:agua_riego',
    label: 'Agua y regadio',
    featureTag: 'concepto:agua_riego',
    featureRegex: /\b(riego|regadio|regante|regantes|comunidad de regantes|acequia|dotacion|concesion de aguas|modernizacion de regadios|canon de riego|hidrante|balsa de riego|riego por goteo|aspersion|caudal)\b/,
    aliases: ['agua', 'riego', 'regadio', 'regadios', 'regante', 'regantes', 'pozo', 'pozos', 'comunidad de regantes', 'acequia', 'dotacion', 'concesion de aguas', 'modernizacion de regadios', 'canon de riego', 'hidrante', 'balsa de riego', 'riego por goteo', 'aspersion', 'caudal'],
    feedbackCanonico: 'agua',
    sector: 'agricultura',
    subsector: 'agua',
  },
  {
    id: 'concepto:sequia',
    label: 'Sequia',
    featureTag: 'concepto:sequia',
    featureRegex: /\b(sequia|escasez de agua|restricciones de agua|emergencia por sequia|estres hidrico|deficit hidrico|reservas hidricas|recortes de riego)\b/,
    aliases: ['sequia', 'escasez de agua', 'restricciones de agua', 'emergencia por sequia', 'estres hidrico', 'deficit hidrico', 'reservas hidricas', 'recortes de riego'],
    feedbackCanonico: 'sequia',
  },
  {
    id: 'concepto:sanidad_animal',
    label: 'Sanidad animal',
    featureTag: 'concepto:sanidad_animal',
    featureRegex: /\b(sanidad animal|veterinari[ao]|vacunacion|saneamiento ganadero|campana de saneamiento|movimiento de animales|explotacion ganadera|crotal|crotales|identificacion animal|tuberculosis|brucelosis|lengua azul|influenza aviar|gripe aviar|peste porcina|peste porcina africana|fiebre aftosa|enfermedad hemorragica|dermatosis nodular)\b/,
    aliases: ['sanidad animal', 'veterinario', 'veterinaria', 'vacunacion', 'saneamiento ganadero', 'campana de saneamiento', 'movimiento animal', 'movimiento de animales', 'crotal', 'crotales', 'identificacion animal', 'tuberculosis', 'brucelosis', 'lengua azul', 'influenza aviar', 'gripe aviar', 'peste porcina', 'peste porcina africana', 'fiebre aftosa', 'enfermedad hemorragica', 'dermatosis nodular'],
    feedbackCanonico: 'sanidad animal',
    sector: 'ganaderia',
  },
  {
    id: 'concepto:bienestar_animal',
    label: 'Bienestar animal',
    featureTag: 'concepto:bienestar_animal',
    featureRegex: /\b(bienestar animal|transporte de animales|nucleo zoologico|condiciones de las explotaciones|densidad ganadera|sacrificio humanitario)\b/,
    aliases: ['bienestar animal', 'transporte de animales', 'nucleo zoologico', 'densidad ganadera', 'sacrificio humanitario'],
    feedbackCanonico: 'bienestar animal',
    sector: 'ganaderia',
  },
  {
    id: 'concepto:fitosanitarios',
    label: 'Fitosanitarios y plagas',
    featureTag: 'concepto:fitosanitarios',
    featureRegex: /\b(fitosanitario|plaga|plagas|tratamiento fitosanitario|producto fitosanitario|xylella|langosta|mosca de la fruta|mosca del olivo|topillo|topillos|mildiu|oidio|botritis|gestion integrada de plagas|fertilizante|abonado|nitrogeno)\b/,
    aliases: ['fitosanitario', 'fitosanitarios', 'plaga', 'plagas', 'tratamiento fitosanitario', 'producto fitosanitario', 'xylella', 'langosta', 'mosca de la fruta', 'mosca del olivo', 'topillo', 'mildiu', 'oidio', 'botritis', 'gestion integrada de plagas', 'fertilizante', 'fertilizantes', 'abonado', 'plaguicida'],
    feedbackCanonico: 'fitosanitarios',
    sector: 'agricultura',
  },
  {
    id: 'concepto:cuaderno_digital',
    label: 'Cuaderno digital',
    featureTag: 'concepto:cuaderno_digital',
    featureRegex: /\b(cuaderno digital|cuaderno de explotacion|cuaderno de campo|siex|siar|reto|registro de tratamientos|registro de explotaciones|libro de explotacion)\b/,
    aliases: ['cuaderno digital', 'cuaderno de explotacion', 'cuaderno de campo', 'siex', 'siar', 'reto', 'registro de tratamientos', 'registro de explotaciones', 'libro de explotacion'],
    feedbackCanonico: 'cuaderno digital',
  },
  {
    id: 'concepto:medio_ambiente',
    label: 'Medio ambiente',
    featureTag: 'concepto:medio_ambiente',
    featureRegex: /\b(zepa|lic|red natura 2000|natura 2000|impacto ambiental|evaluacion ambiental|evaluacion de impacto|biodiversidad|habitat|residuo|residuos|purin|purines|nitratos|zona vulnerable a nitratos|emisiones|huella de carbono|sostenibilidad|agroambiental)\b/,
    aliases: ['medio ambiente', 'medioambiental', 'ambiental', 'zepa', 'lic', 'natura 2000', 'red natura 2000', 'impacto ambiental', 'evaluacion ambiental', 'biodiversidad', 'habitat', 'residuo', 'residuos', 'purin', 'purines', 'nitratos', 'zona vulnerable a nitratos', 'emisiones', 'huella de carbono', 'sostenibilidad', 'agroambiental'],
    feedbackCanonico: 'medio ambiente',
    subsector: 'medio_ambiente',
  },
  {
    id: 'concepto:energia',
    label: 'Energia',
    featureTag: 'concepto:energia',
    featureRegex: /\b(fotovoltaica|placas solares|energia renovable|energias renovables|electrificacion|autoconsumo|comunidad energetica|biogas|biometano|biomasa|eolica|eficiencia energetica)\b/,
    aliases: ['energia', 'fotovoltaica', 'placas solares', 'energia renovable', 'energias renovables', 'electrificacion', 'autoconsumo', 'comunidad energetica', 'biogas', 'biometano', 'biomasa', 'eolica', 'eficiencia energetica'],
    subsector: 'energia',
  },
  {
    id: 'concepto:maquinaria_agricola',
    label: 'Maquinaria agricola',
    featureTag: 'concepto:maquinaria_agricola',
    featureRegex: /\b(maquinaria agricola|maquinaria|tractor|tractores|cosechadora|cosechadoras|remolque|apero|aperos|sembradora|empacadora|atomizador|modernizacion de explotaciones|inversiones en explotaciones|renovacion de maquinaria)\b/,
    aliases: ['maquinaria agricola', 'maquinaria', 'maquina', 'maquinas', 'tractor', 'tractores', 'cosechadora', 'cosechadoras', 'remolque', 'apero', 'aperos', 'sembradora', 'empacadora', 'atomizador', 'modernizacion', 'modernizacion de explotaciones', 'renovacion de maquinaria', 'inversiones en explotaciones'],
    feedbackCanonico: 'maquinaria agricola',
    sector: 'agricultura',
  },
  {
    id: 'concepto:incorporacion_joven',
    label: 'Jovenes agricultores',
    featureTag: 'concepto:incorporacion_joven',
    featureRegex: /\b(joven agricultor|jovenes agricultores|incorporacion de jovenes|primera instalacion|relevo generacional|nueva incorporacion)\b/,
    aliases: ['joven agricultor', 'jovenes agricultores', 'incorporacion', 'incorporacion de jovenes', 'primera instalacion', 'relevo generacional', 'nueva incorporacion'],
    feedbackCanonico: 'jovenes agricultores',
    sector: 'agricultura',
  },
  {
    id: 'entidad:cooperativa',
    label: 'Cooperativas y SAT',
    featureTag: 'entidad:cooperativa',
    featureRegex: /\b(cooperativa|cooperativas|cooperativismo|sat|sociedad agraria de transformacion|seccion de credito|opfh|organizacion de productores)\b/,
    aliases: ['cooperativa', 'cooperativas', 'cooperativismo', 'sat', 'sociedad agraria de transformacion', 'seccion de credito', 'opfh', 'organizacion de productores'],
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
    featureRegex: /\b(nombramiento|nombramientos|cese|ceses|designacion|toma de posesion|vocal|vocales|cargo)\b/,
    aliases: ['nombramiento', 'nombramientos', 'cese', 'designacion', 'toma de posesion', 'vocal', 'vocales', 'cargo'],
  },
  {
    id: 'tramite:licitacion',
    label: 'Licitacion',
    featureTag: 'tramite:licitacion',
    featureRegex: /\b(licitacion|contrato|contratos|adjudicacion de contrato|formalizacion de contrato|formalizacion de contratos|anuncio de formalizacion)\b/,
    excludeRegex: /\bcontrato\s+de\s+obras?\s+(del\s+)?ayuntamiento\b/,
    aliases: ['licitacion', 'licitaciones', 'contrato', 'contratos', 'adjudicacion de contrato', 'formalizacion de contrato'],
    feedbackCanonico: 'licitacion',
  },
  { id: 'sector:agricultura', label: 'Agricultura', featureTag: 'sector:agricultura', aliases: ['agricultura', 'agricola', 'agricolas', 'agrario', 'agraria', 'agrarios', 'agrarias', 'agricultor', 'agricultores', 'agricultora', 'agricultoras', 'agropecuario', 'agropecuaria', 'agroalimentario', 'agroalimentaria', 'cultivo', 'cultivos', 'labranza', 'labor agricola', 'tierras de cultivo', 'explotacion agraria', 'explotaciones agrarias', 'explotacion agricola', 'explotaciones agricolas'], feedbackCanonico: 'agricultura', sector: 'agricultura' },
  { id: 'sector:ganaderia', label: 'Ganaderia', featureTag: 'sector:ganaderia', aliases: ['ganaderia', 'ganadero', 'ganadera', 'ganaderos', 'ganaderas', 'ganaderias', 'explotacion ganadera', 'explotaciones ganaderas', 'cabana ganadera', 'ganado', 'reses', 'pecuario', 'pecuaria'], feedbackCanonico: 'ganaderia', sector: 'ganaderia' },
  { id: 'subsector:olivar', label: 'Olivar', featureTag: 'subsector:olivar', aliases: ['olivar', 'olivares', 'olivo', 'olivos', 'aceituna', 'aceitunas', 'aceite de oliva', 'almazara', 'almazaras', 'oleicola', 'olivicultura'], feedbackCanonico: 'olivar', sector: 'agricultura' },
  { id: 'subsector:vinedo', label: 'Vinedo', featureTag: 'subsector:vinedo', excludeRegex: /\bvino\s+de\s+(honor|bienvenida|recepcion)\b/, aliases: ['vinedo', 'vinedos', 'vino', 'vinos', 'uva', 'uvas', 'vid', 'vides', 'vina', 'vinas', 'viticultura', 'viticola', 'vitivinicola', 'bodega', 'bodegas', 'mosto', 'vendimia', 'denominacion de origen'], feedbackCanonico: 'vinedo', sector: 'agricultura' },
  { id: 'subsector:almendro', label: 'Almendro', featureTag: 'subsector:almendro', aliases: ['almendro', 'almendros', 'almendra', 'almendras', 'almendral'], feedbackCanonico: 'almendro', sector: 'agricultura' },
  { id: 'subsector:frutos_secos', label: 'Frutos secos', featureTag: 'subsector:frutos_secos', aliases: ['frutos secos', 'fruto seco', 'nuez', 'nueces', 'nogal', 'nogales', 'avellana', 'avellanas', 'avellano', 'pistacho', 'pistachos', 'pistachero'], feedbackCanonico: 'frutos secos', sector: 'agricultura' },
  { id: 'subsector:citricos', label: 'Citricos', featureTag: 'subsector:citricos', aliases: ['citricos', 'citrico', 'naranja', 'naranjas', 'naranjo', 'limon', 'limones', 'limonero', 'mandarina', 'mandarinas', 'clementina', 'clementinas', 'pomelo'], feedbackCanonico: 'citricos', sector: 'agricultura' },
  { id: 'subsector:cereal', label: 'Cereal', featureTag: 'subsector:cereal', aliases: ['cereal', 'cereales', 'grano', 'cosecha de cereal'], feedbackCanonico: 'cereal', sector: 'agricultura' },
  { id: 'subsector:trigo', label: 'Trigo', featureTag: 'subsector:trigo', aliases: ['trigo', 'trigo duro', 'trigo blando'], feedbackCanonico: 'trigo', sector: 'agricultura' },
  { id: 'subsector:cebada', label: 'Cebada', featureTag: 'subsector:cebada', aliases: ['cebada'], feedbackCanonico: 'cebada', sector: 'agricultura' },
  { id: 'subsector:maiz', label: 'Maiz', featureTag: 'subsector:maiz', aliases: ['maiz', 'maizal'], feedbackCanonico: 'maiz', sector: 'agricultura' },
  { id: 'subsector:arroz', label: 'Arroz', featureTag: 'subsector:arroz', aliases: ['arroz', 'arrozal', 'arrozales'], feedbackCanonico: 'arroz', sector: 'agricultura' },
  { id: 'subsector:hortalizas', label: 'Hortalizas', featureTag: 'subsector:hortalizas', aliases: ['hortaliza', 'hortalizas', 'huerta', 'huertas', 'horticola', 'horticolas', 'horticultura', 'tomate', 'tomates', 'pimiento', 'pimientos', 'lechuga', 'lechugas', 'cebolla', 'cebollas', 'ajo', 'ajos', 'brocoli', 'alcachofa', 'alcachofas'], feedbackCanonico: 'hortalizas', sector: 'agricultura' },
  { id: 'subsector:frutal', label: 'Frutales', featureTag: 'subsector:frutal', aliases: ['frutal', 'frutales', 'fruta', 'frutas', 'fruticultura', 'manzana', 'manzanas', 'manzano', 'pera', 'peras', 'peral', 'melocoton', 'melocotones', 'melocotonero', 'cereza', 'cerezas', 'cerezo', 'ciruela', 'ciruelas', 'albaricoque', 'albaricoques', 'fruta de hueso', 'fruta de pepita'], feedbackCanonico: 'frutal', sector: 'agricultura' },
  { id: 'subsector:patata', label: 'Patata', featureTag: 'subsector:patata', aliases: ['patata', 'patatas', 'patata de siembra'], feedbackCanonico: 'patata', sector: 'agricultura' },
  { id: 'subsector:leguminosa', label: 'Leguminosas', featureTag: 'subsector:leguminosa', aliases: ['leguminosa', 'leguminosas', 'legumbre', 'legumbres', 'garbanzo', 'garbanzos', 'lenteja', 'lentejas', 'guisante', 'guisantes', 'haba', 'habas', 'veza', 'alfalfa'], feedbackCanonico: 'leguminosa', sector: 'agricultura' },
  { id: 'subsector:cultivos_industriales', label: 'Cultivos industriales', featureTag: 'subsector:cultivos_industriales', aliases: ['cultivo industrial', 'cultivos industriales', 'girasol', 'girasoles', 'colza', 'remolacha', 'remolacha azucarera', 'algodon', 'tabaco', 'lino', 'oleaginosas'], feedbackCanonico: 'cultivos industriales', sector: 'agricultura' },
  { id: 'subsector:hortofruticola', label: 'Hortofruticola', featureTag: 'subsector:hortofruticola', aliases: ['hortofruticola', 'hortofruticultura', 'frutas y hortalizas', 'central hortofruticola'], feedbackCanonico: 'hortofruticola', sector: 'agricultura' },
  { id: 'subsector:forestal', label: 'Forestal', featureTag: 'subsector:forestal', aliases: ['forestal', 'forestales', 'monte', 'montes', 'bosque', 'bosques', 'madera', 'silvicultura', 'repoblacion forestal', 'masa forestal', 'aprovechamiento forestal'], feedbackCanonico: 'forestal', sector: 'agricultura' },
  { id: 'subsector:trufa', label: 'Trufa', featureTag: 'subsector:trufa', aliases: ['trufa', 'trufas', 'truficultura', 'trufa negra'], feedbackCanonico: 'trufa', sector: 'agricultura' },
  { id: 'subsector:floricultura', label: 'Floricultura y viveros', featureTag: 'subsector:floricultura', aliases: ['floricultura', 'flor', 'flores', 'planta ornamental', 'plantas ornamentales', 'vivero', 'viveros', 'jardineria', 'flor cortada'], feedbackCanonico: 'floricultura', sector: 'agricultura' },
  { id: 'subsector:semillas', label: 'Semillas', featureTag: 'subsector:semillas', aliases: ['semilla', 'semillas', 'semilla certificada', 'productor de semillas', 'material vegetal'], feedbackCanonico: 'semillas', sector: 'agricultura' },
  { id: 'subsector:ovino', label: 'Ovino', featureTag: 'subsector:ovino', aliases: ['ovino', 'oveja', 'ovejas', 'cordero', 'corderos', 'ganado ovino', 'lana', 'rebano'], feedbackCanonico: 'ovino', sector: 'ganaderia' },
  { id: 'subsector:caprino', label: 'Caprino', featureTag: 'subsector:caprino', aliases: ['caprino', 'cabra', 'cabras', 'cabrito', 'cabritos', 'ganado caprino', 'macho cabrio'], feedbackCanonico: 'caprino', sector: 'ganaderia' },
  { id: 'subsector:vacuno', label: 'Vacuno', featureTag: 'subsector:vacuno', aliases: ['vacuno', 'vaca', 'vacas', 'bovino', 'bovinos', 'ternero', 'terneros', 'ternera', 'toro', 'toros', 'novillo', 'vacuno de leche', 'vacuno de carne', 'ganado vacuno'], feedbackCanonico: 'vacuno', sector: 'ganaderia' },
  { id: 'subsector:porcino', label: 'Porcino', featureTag: 'subsector:porcino', aliases: ['porcino', 'cerdo', 'cerdos', 'cochino', 'cochinos', 'cerda', 'cebo', 'lechon', 'lechones', 'porcino iberico', 'cerdo iberico', 'ganado porcino'], feedbackCanonico: 'porcino', sector: 'ganaderia' },
  { id: 'subsector:avicultura', label: 'Avicultura', featureTag: 'subsector:avicultura', aliases: ['avicultura', 'avicola', 'ave', 'aves', 'pollo', 'pollos', 'gallina', 'gallinas', 'gallinas ponedoras', 'pavo', 'pavos', 'huevo', 'huevos', 'granja avicola', 'broiler'], feedbackCanonico: 'avicultura', sector: 'ganaderia' },
  { id: 'subsector:apicultura', label: 'Apicultura', featureTag: 'subsector:apicultura', aliases: ['apicultura', 'apicola', 'abeja', 'abejas', 'miel', 'colmena', 'colmenas', 'colmenar', 'apicultor', 'apicultores', 'polen', 'cera'], feedbackCanonico: 'apicultura', sector: 'ganaderia' },
  { id: 'subsector:cunicultura', label: 'Cunicultura', featureTag: 'subsector:cunicultura', aliases: ['cunicultura', 'conejo', 'conejos', 'cunicola', 'granja cunicola'], feedbackCanonico: 'cunicultura', sector: 'ganaderia' },
  { id: 'subsector:equino', label: 'Equino', featureTag: 'subsector:equino', aliases: ['equino', 'equinos', 'equinocultura', 'caballo', 'caballos', 'yegua', 'yeguas', 'potro', 'equido', 'equidos', 'ganado equino'], feedbackCanonico: 'equinocultura', sector: 'ganaderia' },
  { id: 'concepto:pastos', label: 'Pastos', featureTag: 'concepto:pastos', aliases: ['pasto', 'pastos', 'forraje', 'forrajes', 'pradera', 'praderas', 'pastizal', 'pastizales', 'dehesa', 'dehesas', 'pastoreo', 'siega'], feedbackCanonico: 'pastos', sector: 'ganaderia', subsector: 'forrajes' },
  { id: 'concepto:purines_estiercoles', label: 'Purines y estiercoles', featureTag: 'concepto:purines_estiercoles', aliases: ['purin', 'purines', 'estiercol', 'estiercoles', 'deyeccion', 'deyecciones', 'gestion de purines', 'fosa de purines', 'balsa de purines', 'aplicacion de purines'], feedbackCanonico: 'purines', sector: 'ganaderia' },
  { id: 'concepto:seguros_agrarios', label: 'Seguros agrarios', featureTag: 'concepto:seguros_agrarios', aliases: ['seguro agrario', 'seguros agrarios', 'agroseguro', 'seguro de cosecha', 'seguro de explotacion', 'enesa', 'subvencion del seguro'], feedbackCanonico: 'seguros agrarios' },
  { id: 'concepto:ecologico', label: 'Produccion ecologica', featureTag: 'concepto:ecologico', aliases: ['ecologico', 'ecologica', 'produccion ecologica', 'agricultura ecologica', 'ganaderia ecologica', 'certificacion ecologica', 'bio', 'agroecologia', 'caae'], feedbackCanonico: 'ecologico' },
  { id: 'concepto:dano_climatico', label: 'Danos climaticos', featureTag: 'concepto:dano_climatico', aliases: ['pedrisco', 'granizo', 'helada', 'heladas', 'inundacion', 'inundaciones', 'temporal', 'dana', 'gota fria', 'incendio', 'incendios', 'dano climatico', 'adversidad climatica', 'catastrofe'], feedbackCanonico: 'danos climaticos' },
  { id: 'concepto:formacion', label: 'Cursos y formacion', featureTag: 'concepto:formacion', excludeRegex: /\bcurso\s+(fluvial|de agua|del rio|hidrologico)\b/, aliases: ['curso', 'cursos', 'formacion', 'jornada', 'jornadas', 'taller', 'talleres', 'seminario', 'webinar', 'capacitacion', 'charla', 'curso de incorporacion'], feedbackCanonico: 'formacion' },
  { id: 'concepto:normativa', label: 'Normativa', featureTag: 'concepto:normativa', excludeRegex: /\b(ley|leyes|norma|normas|normativa)\s+general\b/, aliases: ['normativa', 'norma', 'normas', 'ley', 'leyes', 'decreto', 'real decreto', 'reglamento', 'disposicion', 'obligacion', 'prohibicion', 'requisito legal'], feedbackCanonico: 'normativa' },
  { id: 'concepto:infraestructura', label: 'Infraestructuras', featureTag: 'concepto:infraestructura', excludeRegex: /\bcontrato\s+de\s+obras?\s+(del\s+)?ayuntamiento\b/, aliases: ['infraestructura', 'infraestructuras', 'obra', 'obras', 'camino rural', 'caminos rurales', 'concentracion parcelaria', 'electrificacion rural', 'mejora de caminos'], feedbackCanonico: 'infraestructura' },
];

function compilarItemTaxonomia(item) {
  const aliases = [...new Set([item.label, ...(item.aliases || [])].map(normalizarTextoTaxonomia).filter(Boolean))];
  return {
    ...item,
    type: tipoTaxonomia(item.id),
    value: valorTaxonomia(item.id),
    aliases_normalizados: aliases,
    aliasRegexes: aliases.map((alias) => ({ alias, regex: regexAliasGlobal(alias) })).filter((entry) => entry.regex),
    regexBusqueda: regexAliases(aliases),
    priority: prioridadItem(item),
    tipoAlerta: tipoAlertaDesdeItem(item),
  };
}

const TAXONOMIA_INDEXADA = TAXONOMIA_RURALICOS.map(compilarItemTaxonomia);

const TAXONOMIA_POR_ID = new Map(TAXONOMIA_INDEXADA.map((item) => [item.id, item]));

const REGLAS_FEATURES_TAXONOMIA = TAXONOMIA_INDEXADA
  .filter((item) => item.featureTag)
  .map((item) => [item.featureTag, item.featureRegex || item.regexBusqueda, item]);

const TEMAS_FEEDBACK_RURALICOS = Object.values(TAXONOMIA_INDEXADA.reduce((acc, item) => {
  if (!item.feedbackCanonico) return acc;
  const canonico = normalizarTextoTaxonomia(item.feedbackCanonico);
  const actual = acc[canonico] || { canonico, aliases: [] };
  actual.aliases.push(canonico, ...item.aliases_normalizados);
  acc[canonico] = actual;
  return acc;
}, {}))
  .map((item) => ({
    canonico: item.canonico,
    aliases: [...new Set(item.aliases.map(normalizarTextoTaxonomia).filter(Boolean))],
  }))
  .sort((a, b) => a.canonico.localeCompare(b.canonico));

function validarTaxonomiaRuralicos() {
  const errores = [];
  const ids = new Set();
  const featureTags = new Set();

  for (const item of TAXONOMIA_INDEXADA) {
    if (!item.id || !/^[a-z_]+:[a-z0-9_]+$/.test(item.id)) {
      errores.push(`id_invalido:${item.id || '(vacio)'}`);
    }
    if (ids.has(item.id)) errores.push(`id_duplicado:${item.id}`);
    ids.add(item.id);

    if (!item.label) errores.push(`label_vacio:${item.id}`);
    if (!Array.isArray(item.aliases) || item.aliases.length === 0) errores.push(`aliases_vacios:${item.id}`);

    if (item.featureTag) {
      if (featureTags.has(item.featureTag)) errores.push(`featureTag_duplicado:${item.featureTag}`);
      featureTags.add(item.featureTag);
    }
  }

  return {
    ok: errores.length === 0,
    errores,
    total: TAXONOMIA_INDEXADA.length,
    feedback_topics: TEMAS_FEEDBACK_RURALICOS.length,
  };
}

const VALIDACION_TAXONOMIA = validarTaxonomiaRuralicos();

if (!VALIDACION_TAXONOMIA.ok) {
  throw new Error(`Taxonomia Ruralicos invalida: ${VALIDACION_TAXONOMIA.errores.join(', ')}`);
}

function extraerFeatureTagsDeTexto(texto) {
  const normalizado = normalizarTextoTaxonomia(texto);
  const features = new Set();

  for (const [tag, regex, item] of REGLAS_FEATURES_TAXONOMIA) {
    if (tieneCoincidenciaSinExclusion(normalizado, item, regex)) features.add(tag);
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

function obtenerLimitesClausula(texto, index) {
  const cursor = Math.max(0, Math.min(texto.length, Number(index || 0)));
  let start = 0;
  let end = texto.length;

  SEPARADOR_FRASE_RE.lastIndex = 0;
  let separator;
  while ((separator = SEPARADOR_FRASE_RE.exec(texto)) !== null) {
    if (separator.index < cursor) {
      start = Math.max(start, separator.index + separator[0].length);
    } else {
      end = Math.min(end, separator.index);
      break;
    }
  }

  CONECTORES_CAMBIO_INTENCION_RE.lastIndex = 0;
  let connector;
  while ((connector = CONECTORES_CAMBIO_INTENCION_RE.exec(texto)) !== null) {
    if (connector.index < cursor) {
      start = Math.max(start, connector.index + connector[0].length);
    } else {
      end = Math.min(end, connector.index);
      break;
    }
  }

  return {
    start,
    end,
    texto: texto.slice(start, end).trim(),
  };
}

function clonarRegexGlobal(regex) {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  return new RegExp(regex.source, flags);
}

function ultimoIndiceRegex(texto, regex) {
  const globalRegex = clonarRegexGlobal(regex);
  let lastIndex = -1;
  let match;

  while ((match = globalRegex.exec(texto)) !== null) {
    lastIndex = match.index;
    if (match.index === globalRegex.lastIndex) globalRegex.lastIndex += 1;
  }

  return lastIndex;
}

function tieneCoincidenciaSinExclusion(texto, item, regex) {
  const globalRegex = clonarRegexGlobal(regex);
  let match;

  while ((match = globalRegex.exec(texto)) !== null) {
    const start = match.index;
    const end = start + String(match[0] || '').length;
    const contextStart = Math.max(0, start - 45);
    const contexto = texto.slice(contextStart, Math.min(texto.length, end + 90));
    if (!coincideExclusionContextual(item, contexto, start - contextStart, end - contextStart)) return true;
    if (match.index === globalRegex.lastIndex) globalRegex.lastIndex += 1;
  }

  return false;
}

function detectarNegacionCercana(texto, startIndex) {
  const cursor = Math.max(0, Math.min(texto.length, Number(startIndex || 0)));
  const clausula = obtenerLimitesClausula(texto, cursor);
  const offset = Math.max(0, cursor - clausula.start);
  const previo = clausula.texto.slice(0, offset).trim();
  if (!previo) return false;
  const ultimaNegacion = ultimoIndiceRegex(previo, NEGACION_CERCA_RE);
  if (ultimaNegacion < 0) return false;
  const ultimaAfirmacion = ultimoIndiceRegex(previo, INTENCION_AFIRMATIVA_CLAUSULA_RE);
  return ultimaAfirmacion <= ultimaNegacion;
}

function coincideExclusionContextual(item, contexto, matchStart = null, matchEnd = null) {
  if (!item || !item.excludeRegex) return false;
  const reglas = Array.isArray(item.excludeRegex) ? item.excludeRegex : [item.excludeRegex].filter(Boolean);
  return reglas.some((regex) => {
    const globalRegex = clonarRegexGlobal(regex);
    let match;

    while ((match = globalRegex.exec(contexto)) !== null) {
      if (!Number.isFinite(matchStart) || !Number.isFinite(matchEnd)) return true;
      const exclusionStart = match.index;
      const exclusionEnd = exclusionStart + String(match[0] || '').length;
      if (exclusionStart < matchEnd && exclusionEnd > matchStart) return true;
      if (match.index === globalRegex.lastIndex) globalRegex.lastIndex += 1;
    }

    return false;
  });
}

function encontrarMatchesItem(textoNormalizado, item) {
  const matches = [];

  for (const { alias, regex } of item.aliasRegexes) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(textoNormalizado)) !== null) {
      const aliasCapturado = match[2] || alias;
      const start = match.index + (match[1] ? match[1].length : 0);
      const end = start + aliasCapturado.length;
      const contextStart = Math.max(0, start - 45);
      const contexto = textoNormalizado.slice(contextStart, Math.min(textoNormalizado.length, end + 90));
      if (coincideExclusionContextual(item, contexto, start - contextStart, end - contextStart)) {
        if (match.index === regex.lastIndex) regex.lastIndex += 1;
        continue;
      }

      matches.push({
        id: item.id,
        label: item.label,
        type: item.type,
        value: item.value,
        alias,
        start,
        end,
        negado: detectarNegacionCercana(textoNormalizado, start),
        sector: item.sector || null,
        subsector: item.subsector || null,
        feedback_canonico: item.feedbackCanonico || null,
        tipo_alerta: item.tipoAlerta || null,
        priority: item.priority,
      });

      if (match.index === regex.lastIndex) regex.lastIndex += 1;
    }
  }

  return matches;
}

function deduplicarMatches(matches = []) {
  const best = new Map();

  for (const match of matches) {
    const key = `${match.id}:${match.negado ? 'negado' : 'positivo'}`;
    const previous = best.get(key);
    if (!previous || match.alias.length > previous.alias.length || match.priority > previous.priority) {
      best.set(key, match);
    }
  }

  return [...best.values()].sort((a, b) => b.priority - a.priority || a.start - b.start);
}

function estructurarMatchesTaxonomia(matches = []) {
  const preferencias = {
    sectores: [],
    subsectores: [],
    tipos_alerta: {},
  };
  const intereses = [];
  const conceptos = [];
  const entidades = [];
  const acciones = [];
  const tramites = [];
  const exclusiones = {
    tags: [],
    temas: [],
  };
  const positivosPorId = new Map();
  const negativosPorId = new Map();

  for (const match of matches) {
    const resumen = {
      id: match.id,
      label: match.label,
      type: match.type,
      value: match.value,
      tema: match.feedback_canonico || match.value,
    };

    if (match.negado) {
      negativosPorId.set(match.id, resumen);
      uniquePush(exclusiones.tags, match.id);
      uniquePush(exclusiones.temas, match.feedback_canonico || match.value);
      continue;
    }

    positivosPorId.set(match.id, resumen);
    uniquePush(intereses, match.feedback_canonico || match.value);
    if (match.sector) uniquePush(preferencias.sectores, match.sector);
    if (match.subsector) uniquePush(preferencias.subsectores, match.subsector);
    if (match.type === 'sector') uniquePush(preferencias.sectores, match.value);
    if (match.type === 'subsector') uniquePush(preferencias.subsectores, match.value);
    if (match.type === 'concepto') uniquePush(conceptos, match.value);
    if (match.type === 'entidad') uniquePush(entidades, match.value);
    if (match.type === 'accion') uniquePush(acciones, match.value);
    if (match.type === 'tramite') uniquePush(tramites, match.value);
    if (match.tipo_alerta) preferencias.tipos_alerta[match.tipo_alerta] = true;
  }

  const conflictos = [...positivosPorId.keys()]
    .filter((id) => negativosPorId.has(id))
    .map((id) => ({
      ...positivosPorId.get(id),
      motivo: 'aparece_como_interes_y_exclusion',
    }));

  return {
    preferencias,
    intereses,
    conceptos,
    entidades,
    acciones,
    tramites,
    exclusiones,
    conflictos,
  };
}

function extraerTaxonomiaDeTexto(texto, options = {}) {
  const textoNormalizado = normalizarTextoTaxonomia(texto);
  const minScore = Number(options.minScore || 0);
  if (!textoNormalizado) {
    return {
      texto_normalizado: '',
      matches: [],
      ...estructurarMatchesTaxonomia([]),
    };
  }

  const matches = deduplicarMatches(
    TAXONOMIA_INDEXADA.flatMap((item) => encontrarMatchesItem(textoNormalizado, item))
  ).filter((match) => match.priority >= minScore);

  return {
    texto_normalizado: textoNormalizado,
    matches,
    ...estructurarMatchesTaxonomia(matches),
  };
}

function construirPreferenciasDesdeTexto(texto, options = {}) {
  const resultado = extraerTaxonomiaDeTexto(texto, options);
  const confianzaBase = resultado.matches.length === 0
    ? 0
    : Math.min(0.95, 0.45 + Math.min(0.4, resultado.matches.length * 0.08));
  const tieneIntencion = INTENCION_POSITIVA_RE.test(resultado.texto_normalizado);

  return {
    ok: resultado.matches.length > 0,
    confidence: Number((tieneIntencion ? confianzaBase : Math.max(0.25, confianzaBase - 0.12)).toFixed(2)),
    ...resultado,
    preferencias: normalizarPreferenciasUsuario(resultado.preferencias),
  };
}

function buscarSugerenciasTaxonomia(query, options = 8) {
  const limit = typeof options === 'object' ? options.limit : options;
  const type = typeof options === 'object' ? options.type : null;
  const includeAliases = typeof options === 'object' ? options.includeAliases === true : false;
  const q = normalizarTextoTaxonomia(query);
  if (!q) return [];

  return TAXONOMIA_INDEXADA
    .filter((item) => !type || item.type === type)
    .map((item) => {
      const exactAlias = item.aliases_normalizados.find((alias) => alias === q);
      const startsAlias = item.aliases_normalizados.find((alias) => alias.startsWith(q));
      const includesAlias = item.aliases_normalizados.find((alias) => alias.includes(q));
      const score = exactAlias ? 100 : startsAlias ? 70 : includesAlias ? 35 : 0;
      const alias = exactAlias || startsAlias || includesAlias || null;
      return { item, alias, score: score + item.priority / 10 };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
    .slice(0, Math.max(1, Number(limit) || 8))
    .map(({ item, alias, score }) => ({
      id: item.id,
      label: item.label,
      type: item.type,
      sector: item.sector || null,
      feedback_canonico: item.feedbackCanonico || null,
      tipo_alerta: item.tipoAlerta || null,
      score: Number(score.toFixed(2)),
      ...(includeAliases ? { alias } : {}),
    }));
}

module.exports = {
  TAXONOMIA_RURALICOS,
  TAXONOMIA_INDEXADA,
  TAXONOMIA_POR_ID,
  REGLAS_FEATURES_TAXONOMIA,
  TEMAS_FEEDBACK_RURALICOS,
  VALIDACION_TAXONOMIA,
  aliasesTemaFeedback,
  buscarSugerenciasTaxonomia,
  construirPreferenciasDesdeTexto,
  deduplicarMatches,
  extraerFeatureTagsDeTexto,
  extraerTaxonomiaDeTexto,
  normalizarTextoTaxonomia,
  regexAliases,
  temaCanonicoTaxonomia,
  validarTaxonomiaRuralicos,
};
