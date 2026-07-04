const {
  TAXONOMIA_INDEXADA,
  extraerFeatureTagsDeTexto,
  normalizarTextoTaxonomia,
} = require('../modules/aprendizaje/taxonomiaRuralicos');
const {
  canonicalSector,
  canonicalSubsector,
  canonicalTipoAlerta,
} = require('./preferenceCanonical');

const LEGACY_SECTORS = new Set(['agricultura', 'ganaderia', 'mixto', 'otros']);
const LEGACY_ALERT_TYPES = new Set([
  'ayudas_subvenciones',
  'normativa_general',
  'agua_infraestructuras',
  'fiscalidad',
  'medio_ambiente',
  'sanidad_animal',
]);

const TYPE_FEATURES = Object.freeze({
  ayudas_subvenciones: 'concepto:ayuda_directa',
  normativa_general: 'concepto:normativa',
  agua_infraestructuras: 'concepto:agua_riego',
  fiscalidad: 'concepto:fiscalidad',
  medio_ambiente: 'concepto:medio_ambiente',
  sanidad_animal: 'concepto:sanidad_animal',
});

function lista(value) {
  return Array.isArray(value) ? value : [];
}

function dedupe(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function aliasesCanonicos(type, value) {
  const canonicalizer = type === 'sector' ? canonicalSector : canonicalSubsector;
  const canonical = canonicalizer(value);
  if (!canonical) return [];

  const match = TAXONOMIA_INDEXADA.find((item) => {
    if (item.type !== type) return false;
    const itemCanonical = canonicalizer(item.value);
    return itemCanonical === canonical;
  });

  return dedupe([
    canonical,
    match?.value,
    match?.label,
    ...(match?.aliases_normalizados || []),
  ].map(normalizarTextoTaxonomia));
}

function textoClasificacion(alerta = {}, clasificacion = {}) {
  return [
    alerta.titulo,
    alerta.contenido,
    alerta.resumen,
    alerta.resumen_final,
    ...lista(clasificacion.sectores),
    ...lista(clasificacion.subsectores),
    ...lista(clasificacion.tipos_alerta),
  ].filter(Boolean).join(' ');
}

function construirTaxonomyTags(alerta = {}, clasificacion = {}) {
  const sectores = dedupe(lista(clasificacion.sectores).map(canonicalSector));
  const subsectores = dedupe(lista(clasificacion.subsectores).map(canonicalSubsector));
  const tipos = dedupe(lista(clasificacion.tipos_alerta).map(canonicalTipoAlerta));
  const tags = [
    ...extraerFeatureTagsDeTexto(textoClasificacion(alerta, clasificacion)),
    ...sectores.map((value) => `sector:${value}`),
    ...subsectores.map((value) => {
      const match = TAXONOMIA_INDEXADA.find((item) =>
        item.type === 'subsector' && canonicalSubsector(item.value) === value
      );
      return match?.featureTag || match?.id || `subsector:${value}`;
    }),
    ...tipos.map((value) => `tipo:${value}`),
    ...tipos.map((value) => TYPE_FEATURES[value]),
  ];
  return dedupe(tags).sort();
}

function normalizarClasificacionCanonica(alerta = {}, clasificacion = {}) {
  const sectores = dedupe(
    lista(clasificacion.sectores)
      .map(canonicalSector)
      .filter((value) => LEGACY_SECTORS.has(value))
  );
  const subsectores = dedupe(
    lista(clasificacion.subsectores)
      .map(canonicalSubsector)
      .filter(Boolean)
  );
  const tiposAlerta = dedupe(
    lista(clasificacion.tipos_alerta)
      .map(canonicalTipoAlerta)
      .filter((value) => LEGACY_ALERT_TYPES.has(value))
  );
  const normalized = {
    ...clasificacion,
    sectores,
    subsectores,
    tipos_alerta: tiposAlerta,
  };

  return {
    ...normalized,
    taxonomy_tags: construirTaxonomyTags(alerta, normalized),
  };
}

module.exports = {
  LEGACY_ALERT_TYPES,
  LEGACY_SECTORS,
  TYPE_FEATURES,
  aliasesCanonicos,
  construirTaxonomyTags,
  normalizarClasificacionCanonica,
};
