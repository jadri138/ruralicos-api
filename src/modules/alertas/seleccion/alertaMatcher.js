const { fuentePermitida, normalizarFuenteBoletin } = require('../../../config/planes');
const { extraerFeatureTagsDeTexto } = require('../../aprendizaje/taxonomiaRuralicos');
const {
  canonicalSector,
  canonicalSubsector,
  canonicalTipoAlerta,
} = require('../../../shared/preferenceCanonical');
const {
  SUBSECTORES_AGRICULTURA,
  SUBSECTORES_GANADERIA,
  analizarCoherenciaTematica,
  clasificarAmbitoSectorialAlerta,
  diagnosticarCoherenciaTaxonomicaAlerta,
  esAlertaSanidadAnimal,
  esAlertaSanidadVegetal,
  inferirSectoresDesdeSubsectores,
  repararClasificacionTematicaSegura,
  sectoresDerivadosAlerta,
  subsectoresDerivadosAlerta,
  taxonomyTagsAlerta,
  textoDocumentalAlerta,
} = require('../../../shared/sectorTaxonomy');

function norm(str) {
  return (str || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

const intersecta = (a, b) => a.some((x) => b.includes(x));
const TIPOS_ALERTA_POR_FEATURE = {
  plazos: ['concepto:plazo'],
  formacion: ['concepto:formacion'],
  licitaciones: ['tramite:licitacion'],
  sanidad_animal: ['concepto:sanidad_animal', 'concepto:bioseguridad', 'concepto:bienestar_animal'],
  sanidad_vegetal: ['concepto:fitosanitarios'],
  incendios_emergencias: ['concepto:dano_climatico'],
  obligaciones: ['accion:declarar'],
  restricciones: ['concepto:normativa'],
  forestal: ['subsector:forestal'],
  registros_certificaciones: ['subsector:registro_explotaciones'],
  plazos_alegaciones: ['accion:alegar'],
};

function listaCanonica(value, canonicalizer) {
  return Array.isArray(value)
    ? value.map(canonicalizer).filter(Boolean)
    : [];
}

function dedupe(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function obtenerSectorImplicitoUsuario(user = {}) {
  const prefs = user.preferences || {};
  const sectoresExplicitos = listaCanonica(prefs.sectores, canonicalSector);
  const subsectores = listaCanonica(prefs.subsectores, canonicalSubsector);
  const sectoresInferidos = sectoresExplicitos.length === 0
    ? inferirSectoresDesdeSubsectores(subsectores)
    : [];

  return {
    sectores_explicitos: sectoresExplicitos,
    subsectores,
    sectores_inferidos: sectoresInferidos,
    origen: sectoresExplicitos.length > 0
      ? 'explicito'
      : (sectoresInferidos.length > 0 ? 'subsectores' : 'abierto'),
  };
}

function tiposActivosUsuario(user = {}) {
  return Object.entries(user.preferences?.tipos_alerta || {})
    .filter(([, active]) => active === true)
    .map(([key]) => canonicalTipoAlerta(key))
    .filter(Boolean);
}

function tieneInteresAprendidoConfiable(user = {}, expected = []) {
  const candidatos = [
    ...(Array.isArray(user.intereses_aprendidos) ? user.intereses_aprendidos : []),
    ...(Array.isArray(user.mia_profile?.interests) ? user.mia_profile.interests : []),
    ...(Array.isArray(user.interest_profile?.topics) ? user.interest_profile.topics : []),
  ];
  const esperados = new Set(expected.map(norm));
  return candidatos.some((item) => {
    if (typeof item === 'string') return esperados.has(norm(item));
    const topic = norm(item?.topic || item?.tag || item?.value);
    const confidence = Number(item?.confidence ?? item?.score ?? 0);
    return esperados.has(topic) && confidence >= 0.7;
  });
}

function textoActividadUsuario(user = {}) {
  return norm([
    user.preferencias_extra,
    user.contexto_narrativo,
    user.preferences?.perfil,
    user.preferences?.actividad,
    user.actividad,
    user.descripcion,
  ].filter(Boolean).join(' '));
}

function userHasLivestockActivity(user = {}) {
  const sector = obtenerSectorImplicitoUsuario(user);
  if (sector.sectores_explicitos.some((value) => ['ganaderia', 'mixto'].includes(value))) return true;
  if (sector.sectores_inferidos.includes('ganaderia')) return true;
  if (sector.subsectores.some((value) => SUBSECTORES_GANADERIA.has(value))) return true;
  if (tiposActivosUsuario(user).includes('sanidad_animal')) return true;
  if (/\b(?:ganader|explotacion\s+ganadera|porcin|vacun|bovin|ovin|caprin|avicul|cunic|equin|apicult|abejas?|veterinari|sanidad\s+animal)\b/.test(textoActividadUsuario(user))) return true;
  return tieneInteresAprendidoConfiable(user, ['ganaderia', 'sanidad_animal', 'bioseguridad']);
}

function userHasAgricultureActivity(user = {}) {
  const sector = obtenerSectorImplicitoUsuario(user);
  if (sector.sectores_explicitos.some((value) => ['agricultura', 'mixto'].includes(value))) return true;
  if (sector.sectores_inferidos.includes('agricultura')) return true;
  if (sector.subsectores.some((value) => SUBSECTORES_AGRICULTURA.has(value))) return true;
  if (/\b(?:agricultur|agricol|explotacion\s+agraria|cultiv|cereal|trigo|olivar|vined|frutal|hortaliz|almendr|patata|fitosanit|sanidad\s+vegetal)\b/.test(textoActividadUsuario(user))) return true;
  return tieneInteresAprendidoConfiable(user, ['agricultura', 'sanidad_vegetal', 'fitosanitarios']);
}

function userHasIrrigationActivity(user = {}) {
  const tipos = tiposActivosUsuario(user);
  const sectores = obtenerSectorImplicitoUsuario(user).sectores_explicitos;
  if (sectores.some((value) => ['agricultura', 'mixto', 'agua'].includes(value))) return true;
  if (listaCanonica(user.preferences?.subsectores, canonicalSubsector).includes('agua')) return true;
  if (tipos.includes('agua_infraestructuras')) return true;
  if (/\b(?:regante|regadio|riego|comunidad\s+de\s+regantes|agua\s+para\s+riego)\b/.test(textoActividadUsuario(user))) return true;
  return tieneInteresAprendidoConfiable(user, ['agua', 'riego', 'regadio']);
}

function diagnosticarBarreraTematicaUsuario(alerta = {}, user = {}, options = {}) {
  if (esAlertaSanidadAnimal(alerta) && !userHasLivestockActivity(user)) {
    return {
      ok: false,
      motivo: 'animal_health_requires_livestock_profile',
      detalle: { topic: 'sanidad_animal', user_livestock_activity: false },
    };
  }

  if (esAlertaSanidadVegetal(alerta) && !userHasAgricultureActivity(user)) {
    return {
      ok: false,
      motivo: 'plant_health_requires_agriculture_profile',
      detalle: { topic: 'sanidad_vegetal', user_agriculture_activity: false },
    };
  }

  const tipos = Array.isArray(options.tiposAlerta) ? options.tiposAlerta : tiposDerivadosAlerta(alerta);
  const texto = textoDocumentalAlerta(alerta);
  const esRiego = tipos.includes('agua_infraestructuras') && /\b(?:riego|regadio|regantes?)\b/.test(texto);
  if (esRiego && !userHasIrrigationActivity(user)) {
    return {
      ok: false,
      motivo: 'irrigation_requires_compatible_profile',
      detalle: { topic: 'riego', user_irrigation_activity: false },
    };
  }

  return null;
}

function diagnosticarBarreraSectorialUsuario(alerta = {}, user = {}, options = {}) {
  const sectorUsuario = obtenerSectorImplicitoUsuario(user);
  if (sectorUsuario.sectores_explicitos.length > 0) return null;
  if (sectorUsuario.sectores_inferidos.length !== 1) return null;

  const sectoresAlerta = Array.isArray(options.sectoresAlerta)
    ? listaCanonica(options.sectoresAlerta, canonicalSector)
    : sectoresDerivadosAlerta(alerta);
  const ambitoAlerta = clasificarAmbitoSectorialAlerta(sectoresAlerta);
  const sectorInferido = sectorUsuario.sectores_inferidos[0];
  const incompatibilidadFuerte =
    (sectorInferido === 'agricultura' && ambitoAlerta === 'ganaderia') ||
    (sectorInferido === 'ganaderia' && ambitoAlerta === 'agricultura');

  if (!incompatibilidadFuerte) return null;

  return {
    ok: false,
    motivo: 'sector_inferido_no_coincide',
    detalle: {
      usuario_sectores_explicitos: sectorUsuario.sectores_explicitos,
      usuario_subsectores: sectorUsuario.subsectores,
      usuario_sectores_inferidos: sectorUsuario.sectores_inferidos,
      origen_sector_usuario: sectorUsuario.origen,
      alerta_sectores: sectoresAlerta,
      alerta_ambito_sectorial: ambitoAlerta,
    },
  };
}

function valoresTaxonomiaPorPrefijo(alerta = {}, prefijo = '', canonicalizer = norm) {
  const prefix = norm(prefijo);
  return taxonomyTagsAlerta(alerta)
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => canonicalizer(tag.slice(prefix.length)))
    .filter(Boolean);
}

function tiposDerivadosAlerta(alerta = {}) {
  const declarados = tiposVerificadosAlerta(alerta);
  return declarados.length > 0
    ? declarados
    : dedupe(tiposDerivadosPorFeatures(alerta));
}

function tiposVerificadosAlerta(alerta = {}) {
  return dedupe([
    ...listaCanonica(alerta.tipos_alerta, canonicalTipoAlerta),
    ...valoresTaxonomiaPorPrefijo(alerta, 'tipo:', canonicalTipoAlerta),
  ]);
}

function diagnosticarTaxonomiaMinimaAlerta({
  sectores = [],
  subsectores = [],
  tipos = [],
  specialized = false,
} = {}) {
  const detalle = {
    sectores,
    subsectores,
    tipos_alerta: tipos,
  };

  if (sectores.length === 0 && subsectores.length === 0 && tipos.length === 0) {
    return {
      ok: false,
      action: 'review',
      reason: 'alert_without_verified_sector',
      motivo: 'alerta_sin_taxonomia',
      detalle,
    };
  }

  if (sectores.length === 0) {
    return {
      ok: false,
      action: 'review',
      reason: 'alert_without_verified_sector',
      motivo: 'alerta_sin_sector_clasificado',
      detalle,
    };
  }

  if (specialized && tipos.length === 0) {
    return {
      ok: false,
      action: 'review',
      reason: 'specialized_alert_without_type',
      motivo: 'alerta_especializada_sin_tipo',
      detalle,
    };
  }

  return null;
}

function diagnosticarTaxonomiaDerivadaAlerta(alerta = {}) {
  const tematica = analizarCoherenciaTematica(alerta, alerta);
  return diagnosticarTaxonomiaMinimaAlerta({
    sectores: sectoresDerivadosAlerta(alerta),
    subsectores: subsectoresDerivadosAlerta(alerta),
    tipos: tiposDerivadosAlerta(alerta),
    specialized: tematica.specialized,
  });
}

function resolverTaxonomiaSeguraAlerta(alerta = {}) {
  const original = {
    sectores: sectoresDerivadosAlerta(alerta),
    subsectores: subsectoresDerivadosAlerta(alerta),
    tipos_alerta: tiposDerivadosAlerta(alerta),
  };
  const reparacion = repararClasificacionTematicaSegura(alerta, original);
  return {
    sectores: reparacion.clasificacion.sectores,
    subsectores: reparacion.clasificacion.subsectores,
    tipos: reparacion.clasificacion.tipos_alerta,
    tipos_verificados: tiposVerificadosAlerta(alerta),
    topic_validation: reparacion.diagnostico,
  };
}

function tiposDerivadosPorFeatures(alerta = {}) {
  const featureTags = featureTagsAlerta(alerta);
  const tipos = [];

  for (const [tipo, tags] of Object.entries(TIPOS_ALERTA_POR_FEATURE)) {
    const expected = Array.isArray(tags) ? tags : [tags];
    if (expected.some((tag) => featureTags.includes(tag))) tipos.push(tipo);
  }

  return tipos;
}

function featureTagsAlerta(alerta = {}) {
  const texto = [
    alerta.titulo,
    alerta.resumen,
    alerta.resumen_final,
    alerta.contenido,
    ...(Array.isArray(alerta.sectores) ? alerta.sectores : []),
    ...(Array.isArray(alerta.subsectores) ? alerta.subsectores : []),
    ...(Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta : []),
    ...taxonomyTagsAlerta(alerta),
  ].filter(Boolean).join(' ');

  return extraerFeatureTagsDeTexto(texto);
}

function tiposCompatibles(tiposUserActivos = [], tiposAlerta = [], alerta = {}) {
  if (tiposUserActivos.length === 0 || tiposAlerta.length === 0) return true;
  if (tiposAlerta.some((tipo) => tiposUserActivos.includes(tipo))) return true;

  const featureTags = featureTagsAlerta(alerta);
  return tiposUserActivos.some((tipo) => {
    const featureTagsEsperados = TIPOS_ALERTA_POR_FEATURE[tipo];
    if (!featureTagsEsperados) return false;
    const expected = Array.isArray(featureTagsEsperados) ? featureTagsEsperados : [featureTagsEsperados];
    return expected.some((featureTag) => featureTags.includes(featureTag));
  });
}

function textoRelevanteAlerta(alerta = {}) {
  return norm([
    alerta.titulo,
    alerta.resumen,
    alerta.resumen_final,
    alerta.contenido,
    ...(Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta : []),
    ...(Array.isArray(alerta.sectores) ? alerta.sectores : []),
    ...(Array.isArray(alerta.subsectores) ? alerta.subsectores : []),
    ...taxonomyTagsAlerta(alerta),
  ].filter(Boolean).join(' '));
}

function esConvocatoriaAyudaGeneral(alerta = {}) {
  const texto = textoRelevanteAlerta(alerta);
  const tipos = tiposDerivadosAlerta(alerta);
  const featureTags = featureTagsAlerta(alerta);

  const esAyuda = tipos.includes('ayudas_subvenciones') ||
    featureTags.includes('concepto:ayuda_directa') ||
    /\b(ayudas?|subvencion(?:es)?|convocatoria|bases reguladoras|pac|fega|feader|feaga)\b/.test(texto);

  const esConvocatoriaAmplia = /\b(se convocan|convocatoria|extracto de la resolucion|bases reguladoras|se aprueban? las bases|intervencion|plan estrategico de la pac|politica agraria comun)\b/.test(texto);
  const destinatarioAgrarioAmplio = /\b(agricultor(?:es|as)?|ganader(?:o|a|os|as)|explotaciones? agrarias?|explotaciones? ganaderas?|titulares de explotaciones|beneficiari(?:o|a|os|as)|servicios de asesoramiento|asesoramiento especifico|pac|feader|feaga)\b/.test(texto);
  const marcadorIndividual = /\b(notificacion individual|procedimiento sancionador|expediente individual|solicitud de concesion|concesion de aguas?|aprovechamiento de aguas?|solicitada por|titular concreto|parcela concreta|pago indebido|reintegro)\b/.test(texto) ||
    (/\bexpediente\b/.test(texto) && !esConvocatoriaAmplia);

  return esAyuda && (esConvocatoriaAmplia || destinatarioAgrarioAmplio) && !marcadorIndividual;
}

function usuarioAceptaAyudasGenerales(tiposUserActivos = []) {
  return tiposUserActivos.length === 0 || tiposUserActivos.includes('ayudas_subvenciones');
}

const PROVINCIAS_POR_FUENTE = {
  BOE: ['nacional'],
  FEGA: ['nacional'],
  BOA: ['huesca', 'zaragoza', 'teruel'],
  BOPZ: ['zaragoza'],
  BOPH: ['huesca'],
  BOPT: ['teruel'],
  DOGC: ['barcelona', 'girona', 'lleida', 'tarragona'],
  DOGV: ['alicante', 'castellon', 'castellon', 'valencia'],
  DOG: ['a coruna', 'lugo', 'ourense', 'pontevedra'],
  DOCM: ['albacete', 'ciudad real', 'cuenca', 'guadalajara', 'toledo'],
  DOE: ['badajoz', 'caceres'],
  BOJA: ['almeria', 'cadiz', 'cordoba', 'granada', 'huelva', 'jaen', 'malaga', 'sevilla'],
  BOCYL: ['avila', 'burgos', 'leon', 'palencia', 'salamanca', 'segovia', 'soria', 'valladolid', 'zamora'],
  BOCM: ['madrid'],
  BON: ['navarra'],
  BOPA: ['asturias'],
  BOPV: ['alava', 'araba', 'bizkaia', 'vizcaya', 'gipuzkoa', 'guipuzcoa'],
  BOTHA: ['alava', 'araba'],
  BOG: ['gipuzkoa', 'guipuzcoa'],
  BOR: ['la rioja'],
  BORM: ['murcia'],
  BOIB: ['illes balears', 'islas baleares', 'baleares'],
  BOCAN: ['las palmas', 'santa cruz de tenerife'],
  BOCANT: ['cantabria'],
  BOME: ['melilla'],
  BOCCE: ['ceuta'],
};
const MARCADORES_NACIONALES = new Set(['nacional', 'espana', 'españa', 'estatal', 'todas', 'todo el territorio nacional']);

const COMUNIDADES_AUTONOMAS_PROVINCIAS = new Map([
  [['andalucia'], ['almeria', 'cadiz', 'cordoba', 'granada', 'huelva', 'jaen', 'malaga', 'sevilla']],
  [['aragon'], ['huesca', 'zaragoza', 'teruel']],
  [['asturias', 'principado de asturias'], ['asturias']],
  [['illes balears', 'islas baleares', 'baleares'], ['illes balears', 'islas baleares', 'baleares']],
  [['canarias', 'islas canarias'], ['las palmas', 'santa cruz de tenerife']],
  [['cantabria'], ['cantabria']],
  [['castilla-la mancha', 'castilla la mancha'], ['albacete', 'ciudad real', 'cuenca', 'guadalajara', 'toledo']],
  [['castilla y leon'], ['avila', 'burgos', 'leon', 'palencia', 'salamanca', 'segovia', 'soria', 'valladolid', 'zamora']],
  [['catalunya', 'cataluna'], ['barcelona', 'girona', 'gerona', 'lleida', 'lerida', 'tarragona']],
  [['comunitat valenciana', 'comunidad valenciana'], ['alicante', 'alacant', 'castellon', 'castello', 'valencia']],
  [['extremadura'], ['badajoz', 'caceres']],
  [['galicia'], ['a coruna', 'coruna', 'lugo', 'ourense', 'orense', 'pontevedra']],
  [['comunidad de madrid'], ['madrid']],
  [['region de murcia'], ['murcia']],
  [['comunidad foral de navarra'], ['navarra']],
  [['pais vasco', 'euskadi', 'euskal herria'], ['alava', 'araba', 'bizkaia', 'vizcaya', 'gipuzkoa', 'guipuzcoa']],
  [['la rioja'], ['la rioja']],
  [['ceuta'], ['ceuta']],
  [['melilla'], ['melilla']],
].flatMap(([aliases, provincias]) => aliases.map((alias) => [alias, provincias])));

const PROVINCIAS_TEXTO = [
  ['alava', ['alava', 'araba']],
  ['araba', ['alava', 'araba']],
  ['albacete'],
  ['alicante', ['alicante', 'alacant']],
  ['alacant', ['alicante', 'alacant']],
  ['almeria'],
  ['asturias'],
  ['avila'],
  ['badajoz'],
  ['barcelona'],
  ['burgos'],
  ['caceres'],
  ['cadiz'],
  ['cantabria'],
  ['castellon', ['castellon', 'castello']],
  ['castello', ['castellon', 'castello']],
  ['ciudad real'],
  ['cordoba'],
  ['a coruna', ['a coruna', 'coruna']],
  ['coruna', ['a coruna', 'coruna']],
  ['cuenca'],
  ['girona', ['girona', 'gerona']],
  ['gerona', ['girona', 'gerona']],
  ['granada'],
  ['guadalajara'],
  ['gipuzkoa', ['gipuzkoa', 'guipuzcoa']],
  ['guipuzcoa', ['gipuzkoa', 'guipuzcoa']],
  ['huelva'],
  ['huesca'],
  ['illes balears', ['illes balears', 'islas baleares', 'baleares']],
  ['islas baleares', ['illes balears', 'islas baleares', 'baleares']],
  ['baleares', ['illes balears', 'islas baleares', 'baleares']],
  ['jaen'],
  ['la rioja'],
  ['las palmas'],
  ['leon'],
  ['lleida', ['lleida', 'lerida']],
  ['lerida', ['lleida', 'lerida']],
  ['lugo'],
  ['madrid'],
  ['malaga'],
  ['murcia'],
  ['navarra'],
  ['ourense', ['ourense', 'orense']],
  ['orense', ['ourense', 'orense']],
  ['palencia'],
  ['pontevedra'],
  ['salamanca'],
  ['santa cruz de tenerife'],
  ['segovia'],
  ['sevilla'],
  ['soria'],
  ['tarragona'],
  ['teruel'],
  ['toledo'],
  ['valencia'],
  ['valladolid'],
  ['bizkaia', ['bizkaia', 'vizcaya']],
  ['vizcaya', ['bizkaia', 'vizcaya']],
  ['zamora'],
  ['zaragoza'],
  ['ceuta'],
  ['melilla'],
].map(([term, aliases]) => ({ term, aliases: aliases || [term] }));

const MUNICIPIOS_PROVINCIA_HINTS = [
  { terms: ['useras', 'useres', 'les useres'], provincias: ['castellon', 'castello'] },
  { terms: ['corullon'], provincias: ['leon'] },
  { terms: ['castillejo de mesleon'], provincias: ['segovia'] },
  { terms: ['valle de ollo'], provincias: ['navarra'] },
  { terms: ['villarquemado'], provincias: ['teruel'] },
];

function fuenteNormalizada(alerta = {}) {
  return normalizarFuenteBoletin(alerta.fuente || '');
}

function escaparRegExp(texto) {
  return String(texto || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function contieneTermino(texto, termino) {
  if (!texto || !termino) return false;
  return new RegExp(`(^|[^a-z0-9])${escaparRegExp(termino)}([^a-z0-9]|$)`, 'i').test(texto);
}

function anadirProvincias(destino, provincias) {
  for (const provincia of provincias || []) {
    const limpia = norm(provincia);
    if (limpia && !destino.includes(limpia)) destino.push(limpia);
  }
}

function provinciasExplicitasValidas(values = []) {
  const resultado = [];
  for (const value of values || []) {
    const normalizado = norm(value);
    const provincia = PROVINCIAS_TEXTO.find((item) =>
      item.term === normalizado || item.aliases.includes(normalizado)
    );
    if (provincia) anadirProvincias(resultado, provincia.aliases);
  }
  return resultado;
}

function comunidadesExplicitas(values = []) {
  const detectadas = [];
  const provincias = [];
  for (const value of values || []) {
    const comunidad = norm(value);
    const expansion = COMUNIDADES_AUTONOMAS_PROVINCIAS.get(comunidad);
    if (!expansion) continue;
    detectadas.push(comunidad);
    anadirProvincias(provincias, expansion);
  }
  return { detectadas, provincias };
}

function extraerProvinciasDeTextoAlerta(alerta = {}) {
  const detectadas = [];
  const titulo = norm(alerta.titulo || '');
  const resumenes = norm([alerta.resumen_final, alerta.resumen].filter(Boolean).join(' '));
  const contenido = norm(String(alerta.contenido || '').slice(0, 2500));
  const textoCorto = [titulo, resumenes].filter(Boolean).join(' ');

  for (const item of PROVINCIAS_TEXTO) {
    const term = item.term;
    const parentetico = new RegExp(`\\(${escaparRegExp(term)}\\)`, 'i');
    const patronTitulo = new RegExp(`\\b(en|de|del|para|municipio de|termino municipal de|provincia de)\\s+(?:la\\s+|el\\s+)?${escaparRegExp(term)}\\b`, 'i');
    const patronFuerte = new RegExp(`\\b(provincia de|provincia:|termino municipal de|municipio de)\\s+(?:la\\s+|el\\s+)?${escaparRegExp(term)}\\b`, 'i');

    if (
      parentetico.test(textoCorto) ||
      patronTitulo.test(titulo) ||
      patronFuerte.test(resumenes) ||
      parentetico.test(contenido) ||
      patronFuerte.test(contenido)
    ) {
      anadirProvincias(detectadas, item.aliases);
    }
  }

  for (const hint of MUNICIPIOS_PROVINCIA_HINTS) {
    if (hint.terms.some((term) => contieneTermino(textoCorto, term))) {
      anadirProvincias(detectadas, hint.provincias);
    }
  }

  return detectadas;
}

function resolverTerritorioAlerta(alerta = {}) {
  const provinciasOriginales = Array.isArray(alerta.provincias)
    ? alerta.provincias.filter((value) => value !== null && value !== undefined)
    : [];
  const provinciasDeclaradas = provinciasOriginales.map(norm).filter(Boolean);
  const fuente = fuenteNormalizada(alerta);
  const provinciasFuente = (PROVINCIAS_POR_FUENTE[fuente] || []).map(norm);
  const provinciasTexto = extraerProvinciasDeTextoAlerta(alerta);
  const provinciasExplicitas = provinciasExplicitasValidas(provinciasOriginales);
  const comunidades = comunidadesExplicitas(provinciasOriginales);
  const regionOriginal = alerta.region || '';
  const region = norm(regionOriginal);
  const comunidadRegion = comunidadesExplicitas(region ? [regionOriginal] : []);
  const provinciaRegion = provinciasExplicitasValidas(region ? [regionOriginal] : []);

  let provinciasNormalizadas = [];
  let ambitoDetectado = 'desconocido';
  let origenTerritorio = 'ninguno';
  let comunidadesDetectadas = comunidades.detectadas;

  // Prioridad territorial única: nacional explícito > texto concreto > provincia
  // explícita > comunidad autónoma > fuente > región de respaldo.
  if (provinciasDeclaradas.some((provincia) => MARCADORES_NACIONALES.has(provincia))) {
    provinciasNormalizadas = provinciasDeclaradas;
    ambitoDetectado = 'nacional';
    origenTerritorio = 'provincias';
  } else if (provinciasTexto.length > 0) {
    provinciasNormalizadas = provinciasTexto;
    ambitoDetectado = 'provincial';
    origenTerritorio = 'texto';
  } else if (provinciasExplicitas.length > 0) {
    provinciasNormalizadas = provinciasExplicitas;
    ambitoDetectado = 'provincial';
    origenTerritorio = 'provincias';
  } else if (comunidades.provincias.length > 0) {
    provinciasNormalizadas = comunidades.provincias;
    ambitoDetectado = 'autonomico';
    origenTerritorio = 'comunidad_autonoma';
  } else if (provinciasFuente.length > 0) {
    provinciasNormalizadas = provinciasFuente;
    ambitoDetectado = provinciasFuente.some((provincia) => MARCADORES_NACIONALES.has(provincia))
      ? 'nacional'
      : (/^BOP/.test(fuente) || ['BOTHA', 'BOG'].includes(fuente) ? 'provincial' : 'autonomico');
    origenTerritorio = 'fuente';
  } else if (comunidadRegion.provincias.length > 0) {
    provinciasNormalizadas = comunidadRegion.provincias;
    comunidadesDetectadas = comunidadRegion.detectadas;
    ambitoDetectado = 'autonomico';
    origenTerritorio = 'region';
  } else if (provinciaRegion.length > 0) {
    provinciasNormalizadas = provinciaRegion;
    ambitoDetectado = 'provincial';
    origenTerritorio = 'region';
  } else if (region) {
    provinciasNormalizadas = [region];
    ambitoDetectado = 'regional_no_normalizado';
    origenTerritorio = 'region';
  }

  return {
    provincias_originales: provinciasOriginales,
    provincias_normalizadas: dedupe(provinciasNormalizadas),
    provincias_detectadas_texto: provinciasTexto,
    provincia_concreta_detectada_texto: provinciasTexto[0] || null,
    comunidades_detectadas: comunidadesDetectadas,
    fuente,
    ambito_detectado: ambitoDetectado,
    origen_territorio: origenTerritorio,
  };
}

function provinciasDerivadasAlerta(alerta = {}) {
  return resolverTerritorioAlerta(alerta).provincias_normalizadas;
}

function esAlertaNacional(alerta = {}, provinciasNorm = []) {
  if (provinciasNorm.some((p) => MARCADORES_NACIONALES.has(p))) return true;

  // BOE no significa automaticamente nacional: si el clasificador ha detectado
  // una provincia concreta, se respeta como filtro duro.
  if (provinciasNorm.length === 0 && ['BOE', 'FEGA'].includes(fuenteNormalizada(alerta))) return true;
  return false;
}

function diagnosticarAlertaUsuario(alerta, user, options = {}) {
  const { aplicarFuente = true } = options;
  const prefs = user.preferences || {};

  if (aplicarFuente) {
    const fuenteAlerta = normalizarFuenteBoletin(alerta.fuente || 'BOE');
    if (!fuentePermitida(user.subscription, fuenteAlerta)) {
      return { ok: false, motivo: 'fuente_no_permitida', detalle: { fuente: fuenteAlerta, plan: user.subscription } };
    }
  }

  const provinciasUserNorm = Array.isArray(prefs.provincias)
    ? prefs.provincias.map(norm)
    : [];
  const sectoresUserNorm = listaCanonica(prefs.sectores, canonicalSector);
  const subsectoresUserNorm = listaCanonica(prefs.subsectores, canonicalSubsector);
  const tiposUserActivos = tiposActivosUsuario(user);

  const territorioAlerta = resolverTerritorioAlerta(alerta);
  const provinciasANorm = territorioAlerta.provincias_normalizadas;
  const alertaNacional = esAlertaNacional(alerta, provinciasANorm);
  const taxonomiaSegura = resolverTaxonomiaSeguraAlerta(alerta);
  const sectoresANorm = taxonomiaSegura.sectores;
  const subsectoresANorm = taxonomiaSegura.subsectores;
  const tiposANorm = taxonomiaSegura.tipos;
  const diagnosticoTaxonomia = diagnosticarTaxonomiaMinimaAlerta({
    sectores: sectoresANorm,
    subsectores: subsectoresANorm,
    tipos: taxonomiaSegura.topic_validation.specialized
      ? taxonomiaSegura.tipos_verificados
      : tiposANorm,
    specialized: taxonomiaSegura.topic_validation.specialized,
  });
  if (diagnosticoTaxonomia) return diagnosticoTaxonomia;

  const diagnosticoCoherencia = diagnosticarCoherenciaTaxonomicaAlerta(alerta, {
    sectores: sectoresANorm,
    subsectores: subsectoresANorm,
    tipos: tiposANorm,
    topicValidation: taxonomiaSegura.topic_validation,
  });
  if (diagnosticoCoherencia) return diagnosticoCoherencia;

  const ayudaGeneralConInteresUsuario = esConvocatoriaAyudaGeneral(alerta) &&
    usuarioAceptaAyudasGenerales(tiposUserActivos);

  const okProvincia =
    provinciasUserNorm.length === 0 ||
    alertaNacional ||
    intersecta(provinciasUserNorm, provinciasANorm);
  if (!okProvincia) {
    return {
      ok: false,
      motivo: 'provincia_no_coincide',
      detalle: {
        usuario: provinciasUserNorm,
        alerta: provinciasANorm,
        alerta_nacional: alertaNacional,
        fuente: alerta.fuente || 'BOE',
        provincias_originales_alerta: territorioAlerta.provincias_originales,
        provincias_normalizadas_alerta: territorioAlerta.provincias_normalizadas,
        provincias_detectadas_texto: territorioAlerta.provincias_detectadas_texto,
        provincia_concreta_detectada_texto: territorioAlerta.provincia_concreta_detectada_texto,
        comunidades_detectadas: territorioAlerta.comunidades_detectadas,
        ambito_detectado: territorioAlerta.ambito_detectado,
        origen_territorio: territorioAlerta.origen_territorio,
      },
    };
  }

  const diagnosticoBarreraSectorial = diagnosticarBarreraSectorialUsuario(alerta, user, {
    sectoresAlerta: sectoresANorm,
  });
  if (diagnosticoBarreraSectorial) return diagnosticoBarreraSectorial;

  const diagnosticoBarreraTematica = diagnosticarBarreraTematicaUsuario({
    ...alerta,
    sectores: sectoresANorm,
    subsectores: subsectoresANorm,
    tipos_alerta: tiposANorm,
  }, user, { tiposAlerta: tiposANorm });
  if (diagnosticoBarreraTematica) return diagnosticoBarreraTematica;

  const tieneMixtoUser = sectoresUserNorm.includes('mixto');
  const tieneMixtoAlerta = sectoresANorm.includes('mixto');
  const okSector =
    sectoresUserNorm.length === 0 ||
    intersecta(sectoresUserNorm, sectoresANorm) ||
    (tieneMixtoUser && intersecta(['agricultura', 'ganaderia'], sectoresANorm)) ||
    (tieneMixtoAlerta && intersecta(['agricultura', 'ganaderia'], sectoresUserNorm));
  if (!okSector) {
    return { ok: false, motivo: 'sector_no_coincide', detalle: { usuario: sectoresUserNorm, alerta: sectoresANorm } };
  }

  const okSubsector =
    subsectoresUserNorm.length === 0 ||
    subsectoresANorm.length === 0 ||
    intersecta(subsectoresUserNorm, subsectoresANorm) ||
    (ayudaGeneralConInteresUsuario && okSector);
  if (!okSubsector) {
    return { ok: false, motivo: 'subsector_no_coincide', detalle: { usuario: subsectoresUserNorm, alerta: subsectoresANorm } };
  }

  if (!tiposCompatibles(tiposUserActivos, tiposANorm, alerta)) {
    return { ok: false, motivo: 'tipo_alerta_no_coincide', detalle: { usuario: tiposUserActivos, alerta: tiposANorm } };
  }

  return { ok: true, motivo: 'coincide' };
}

function alertaCoincideConUsuario(alerta, user, options = {}) {
  return diagnosticarAlertaUsuario(alerta, user, options).ok;
}

module.exports = {
  alertaCoincideConUsuario,
  clasificarAmbitoSectorialAlerta,
  diagnosticarBarreraSectorialUsuario,
  diagnosticarBarreraTematicaUsuario,
  diagnosticarCoherenciaTaxonomicaAlerta,
  diagnosticarTaxonomiaDerivadaAlerta,
  diagnosticarTaxonomiaMinimaAlerta,
  diagnosticarAlertaUsuario,
  esAlertaNacional,
  esConvocatoriaAyudaGeneral,
  intersecta,
  inferirSectoresDesdeSubsectores,
  norm,
  obtenerSectorImplicitoUsuario,
  provinciasDerivadasAlerta,
  resolverTaxonomiaSeguraAlerta,
  resolverTerritorioAlerta,
  sectoresDerivadosAlerta,
  subsectoresDerivadosAlerta,
  taxonomyTagsAlerta,
  tiposActivosUsuario,
  tiposDerivadosAlerta,
  userHasAgricultureActivity,
  userHasIrrigationActivity,
  userHasLivestockActivity,
};
