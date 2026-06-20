function normalizarClavePreferencia(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .trim();
}

function limpiarTextoPreferencia(value, maxLength = 80) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

function entriesMap(entries) {
  return new Map(entries.map(([alias, canonical]) => [normalizarClavePreferencia(alias), canonical]));
}

const SECTOR_ALIASES = entriesMap([
  ['agricultura', 'agricultura'],
  ['agricola', 'agricultura'],
  ['agrario', 'agricultura'],
  ['agraria', 'agricultura'],
  ['agricultor', 'agricultura'],
  ['agricultores', 'agricultura'],
  ['agricultora', 'agricultura'],
  ['agricultoras', 'agricultura'],
  ['agropecuario', 'agricultura'],
  ['cultivo', 'agricultura'],
  ['cultivos', 'agricultura'],
  ['explotacion agraria', 'agricultura'],
  ['ganaderia', 'ganaderia'],
  ['ganadero', 'ganaderia'],
  ['ganadera', 'ganaderia'],
  ['ganaderos', 'ganaderia'],
  ['ganaderas', 'ganaderia'],
  ['explotacion ganadera', 'ganaderia'],
  ['ganado', 'ganaderia'],
  ['mixto', 'mixto'],
  ['agricultura y ganaderia', 'mixto'],
  ['ganaderia y agricultura', 'mixto'],
  ['otros', 'otros'],
  ['forestal', 'forestal'],
  ['agua', 'agua'],
  ['medio_ambiente', 'medio_ambiente'],
  ['medio ambiente', 'medio_ambiente'],
  ['acuicultura', 'acuicultura'],
  ['energia', 'energia'],
  ['energía', 'energia'],
  ['apicultura', 'apicultura'],
]);

const SUBSECTOR_ALIASES = entriesMap([
  ['ovino', 'ovino'],
  ['oveja', 'ovino'],
  ['ovejas', 'ovino'],
  ['cordero', 'ovino'],
  ['corderos', 'ovino'],
  ['vacuno', 'vacuno'],
  ['vaca', 'vacuno'],
  ['vacas', 'vacuno'],
  ['bovino', 'vacuno'],
  ['bovinos', 'vacuno'],
  ['caprino', 'caprino'],
  ['cabra', 'caprino'],
  ['cabras', 'caprino'],
  ['porcino', 'porcino'],
  ['cerdo', 'porcino'],
  ['cerdos', 'porcino'],
  ['avicultura', 'avicultura'],
  ['avicola', 'avicultura'],
  ['pollos', 'avicultura'],
  ['apicultura', 'apicultura'],
  ['abejas', 'apicultura'],
  ['cunicultura', 'cunicultura'],
  ['conejo', 'cunicultura'],
  ['conejos', 'cunicultura'],
  ['equinocultura', 'equinocultura'],
  ['equino', 'equinocultura'],
  ['caballos', 'equinocultura'],
  ['bienestar_animal', 'bienestar_animal'],
  ['bienestar animal', 'bienestar_animal'],
  ['sanidad_animal', 'sanidad_animal'],
  ['sanidad animal', 'sanidad_animal'],
  ['fitosanitarios', 'fitosanitarios'],
  ['fitosanitario', 'fitosanitarios'],
  ['seguros_agrarios', 'seguros_agrarios'],
  ['seguro agrario', 'seguros_agrarios'],
  ['seguros agrarios', 'seguros_agrarios'],
  ['transporte_animales', 'transporte_animales'],
  ['transporte animales', 'transporte_animales'],
  ['transporte_ganado', 'transporte_animales'],
  ['razas_autoctonas', 'razas_autoctonas'],
  ['razas autoctonas', 'razas_autoctonas'],
  ['cereal', 'cereal'],
  ['cereales', 'cereal'],
  ['trigo', 'trigo'],
  ['cebada', 'cebada'],
  ['maiz', 'maiz'],
  ['arroz', 'arroz'],
  ['hortalizas', 'hortalizas'],
  ['hortaliza', 'hortalizas'],
  ['huerta', 'hortalizas'],
  ['horticolas', 'hortalizas'],
  ['frutales', 'frutales'],
  ['frutal', 'frutales'],
  ['fruta', 'frutales'],
  ['fruticultura', 'frutales'],
  ['hortofruticola', 'hortofruticola'],
  ['hortofruticultura', 'hortofruticola'],
  ['frutas y hortalizas', 'hortofruticola'],
  ['olivar', 'olivar'],
  ['olivo', 'olivar'],
  ['olivos', 'olivar'],
  ['aceituna', 'olivar'],
  ['trufas', 'trufas'],
  ['trufa', 'trufas'],
  ['vinedo', 'vinedo'],
  ['viñedo', 'vinedo'],
  ['vinedos', 'vinedo'],
  ['viñedos', 'vinedo'],
  ['vino', 'vinedo'],
  ['uva', 'vinedo'],
  ['uvas', 'vinedo'],
  ['vid', 'vinedo'],
  ['almendro', 'almendro'],
  ['almendros', 'almendro'],
  ['almendra', 'almendro'],
  ['citricos', 'citricos'],
  ['citrico', 'citricos'],
  ['naranja', 'citricos'],
  ['naranjas', 'citricos'],
  ['frutos secos', 'frutos_secos'],
  ['fruto seco', 'frutos_secos'],
  ['frutos_secos', 'frutos_secos'],
  ['leguminosas', 'leguminosas'],
  ['leguminosa', 'leguminosas'],
  ['patata', 'patata'],
  ['patatas', 'patata'],
  ['forrajes', 'forrajes'],
  ['forraje', 'forrajes'],
  ['pastos', 'forrajes'],
  ['pasto', 'forrajes'],
  ['praderas', 'forrajes'],
  ['forestal', 'forestal'],
  ['monte', 'forestal'],
  ['montes', 'forestal'],
  ['desarrollo_rural', 'desarrollo_rural'],
  ['desarrollo rural', 'desarrollo_rural'],
  ['jovenes_agricultores', 'jovenes_agricultores'],
  ['jovenes agricultores', 'jovenes_agricultores'],
  ['joven agricultor', 'jovenes_agricultores'],
  ['modernizacion_explotaciones', 'modernizacion_explotaciones'],
  ['modernizacion explotaciones', 'modernizacion_explotaciones'],
  ['maquinaria', 'maquinaria'],
  ['maquinaria agricola', 'maquinaria'],
  ['agricultura_precision', 'agricultura_precision'],
  ['agricultura precision', 'agricultura_precision'],
  ['ganaderia_precision', 'ganaderia_precision'],
  ['ganaderia precision', 'ganaderia_precision'],
  ['cultivos_industriales', 'cultivos_industriales'],
  ['cultivos industriales', 'cultivos_industriales'],
  ['cultivos_industriales_textiles', 'cultivos_industriales'],
  ['semillas', 'semillas'],
  ['viveros', 'viveros'],
  ['viveros_y_ornamentales', 'viveros'],
  ['floricultura', 'floricultura'],
  ['fauna_silvestre', 'fauna_silvestre'],
  ['fauna silvestre', 'fauna_silvestre'],
  ['danos_fauna', 'fauna_silvestre'],
  ['daños fauna', 'fauna_silvestre'],
  ['financiacion', 'financiacion'],
  ['pac', 'pac'],
  ['formacion', 'formacion'],
  ['curso', 'formacion'],
  ['cursos', 'formacion'],
  ['infraestructuras', 'infraestructuras'],
  ['agua', 'agua'],
  ['agua_riego', 'agua'],
  ['riego', 'agua'],
  ['regadio', 'agua'],
  ['regadios', 'agua'],
  ['pozo', 'agua'],
  ['pozos', 'agua'],
  ['energia', 'energia'],
  ['fotovoltaica', 'energia'],
  ['autoconsumo', 'energia'],
  ['medio ambiente', 'medio_ambiente'],
  ['medio_ambiente', 'medio_ambiente'],
  ['medioambiental', 'medio_ambiente'],
  ['ambiental', 'medio_ambiente'],
  ['biodiversidad', 'medio_ambiente'],
]);

const TIPO_ALERTA_ALIASES = entriesMap([
  ['ayudas_subvenciones', 'ayudas_subvenciones'],
  ['ayuda', 'ayudas_subvenciones'],
  ['ayudas', 'ayudas_subvenciones'],
  ['subvencion', 'ayudas_subvenciones'],
  ['subvenciones', 'ayudas_subvenciones'],
  ['subsidio', 'ayudas_subvenciones'],
  ['pago', 'ayudas_subvenciones'],
  ['pagos', 'ayudas_subvenciones'],
  ['convocatoria', 'ayudas_subvenciones'],
  ['normativa_general', 'normativa_general'],
  ['normativa', 'normativa_general'],
  ['norma', 'normativa_general'],
  ['normas', 'normativa_general'],
  ['ley', 'normativa_general'],
  ['leyes', 'normativa_general'],
  ['agua_infraestructuras', 'agua_infraestructuras'],
  ['agua', 'agua_infraestructuras'],
  ['riego', 'agua_infraestructuras'],
  ['regadio', 'agua_infraestructuras'],
  ['agua_infraestructura', 'agua_infraestructuras'],
  ['agua infraestructura', 'agua_infraestructuras'],
  ['agua_infraestrucuras', 'agua_infraestructuras'],
  ['agua_infraestructura s', 'agua_infraestructuras'],
  ['agua_restricciones', 'agua_infraestructuras'],
  ['infraestructura', 'agua_infraestructuras'],
  ['infraestructuras', 'agua_infraestructuras'],
  ['fiscalidad', 'fiscalidad'],
  ['fiscal', 'fiscalidad'],
  ['irpf', 'fiscalidad'],
  ['iva', 'fiscalidad'],
  ['medio_ambiente', 'medio_ambiente'],
  ['medio ambiente', 'medio_ambiente'],
  ['medioambiental', 'medio_ambiente'],
  ['ambiental', 'medio_ambiente'],
  ['plazos', 'plazos'],
  ['plazo', 'plazos'],
  ['fecha limite', 'plazos'],
  ['formacion', 'formacion'],
  ['curso', 'formacion'],
  ['cursos', 'formacion'],
  ['jornada', 'formacion'],
  ['jornadas', 'formacion'],
  ['licitaciones', 'licitaciones'],
  ['licitacion', 'licitaciones'],
  ['contrato', 'licitaciones'],
  ['contratos', 'licitaciones'],
  ['sanidad_animal', 'sanidad_animal'],
  ['sanidad animal', 'sanidad_animal'],
  ['seguros_agrarios', 'seguros_agrarios'],
  ['seguro_agrario', 'seguros_agrarios'],
  ['seguro agrario', 'seguros_agrarios'],
  ['eventos_ferias', 'eventos_ferias'],
  ['eventos ferias', 'eventos_ferias'],
  ['ferias', 'eventos_ferias'],
  ['expropiaciones', 'expropiaciones'],
]);

const SECTORES_CONOCIDOS = new Set(SECTOR_ALIASES.values());
const SUBSECTORES_CONOCIDOS = new Set(SUBSECTOR_ALIASES.values());
const TIPOS_ALERTA_CONOCIDOS = new Set(TIPO_ALERTA_ALIASES.values());

function canonizarDesdeMapa(value, aliases) {
  const key = normalizarClavePreferencia(value);
  if (!key) return '';
  return aliases.get(key) || key;
}

function canonicalSector(value) {
  return canonizarDesdeMapa(value, SECTOR_ALIASES);
}

function canonicalSubsector(value) {
  return canonizarDesdeMapa(value, SUBSECTOR_ALIASES);
}

function canonicalTipoAlerta(value) {
  return canonizarDesdeMapa(value, TIPO_ALERTA_ALIASES);
}

function dedupe(values = [], keyFn = normalizarClavePreferencia) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }

  return result;
}

function normalizarListaLibre(value, maxLength = 80) {
  if (!Array.isArray(value)) return [];
  return dedupe(
    value
      .map((item) => limpiarTextoPreferencia(item, maxLength))
      .filter(Boolean)
  );
}

function normalizarListaCanonica(value, canonicalizer, conocidos) {
  if (!Array.isArray(value)) return [];

  return dedupe(
    value
      .map(canonicalizer)
      .filter((item) => item && (!conocidos || conocidos.has(item))),
    (item) => item
  );
}

function valorActivo(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function normalizarTiposAlerta(value) {
  const result = {};

  if (Array.isArray(value)) {
    for (const item of value) {
      const tipo = canonicalTipoAlerta(item);
      if (tipo && TIPOS_ALERTA_CONOCIDOS.has(tipo)) result[tipo] = true;
    }
    return result;
  }

  if (!value || typeof value !== 'object') return result;

  for (const [key, active] of Object.entries(value)) {
    if (!valorActivo(active)) continue;
    const tipo = canonicalTipoAlerta(key);
    if (tipo && TIPOS_ALERTA_CONOCIDOS.has(tipo)) result[tipo] = true;
  }

  return result;
}

function normalizarPreferenciasUsuario(preferences = {}) {
  const prefs = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    ? preferences
    : {};

  return {
    provincias: normalizarListaLibre(prefs.provincias),
    sectores: normalizarListaCanonica(prefs.sectores, canonicalSector, SECTORES_CONOCIDOS),
    subsectores: normalizarListaCanonica(prefs.subsectores, canonicalSubsector, SUBSECTORES_CONOCIDOS),
    tipos_alerta: normalizarTiposAlerta(prefs.tipos_alerta),
  };
}

module.exports = {
  SECTORES_CONOCIDOS,
  SUBSECTORES_CONOCIDOS,
  TIPOS_ALERTA_CONOCIDOS,
  canonicalSector,
  canonicalSubsector,
  canonicalTipoAlerta,
  limpiarTextoPreferencia,
  normalizarClavePreferencia,
  normalizarListaLibre,
  normalizarPreferenciasUsuario,
  normalizarTiposAlerta,
};
