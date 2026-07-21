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
const {
  TAXONOMY_COHERENCE_VERSION,
  analizarCoherenciaSectorSubsector,
  repararClasificacionSectorialSegura,
  repararClasificacionTematicaSegura,
} = require('./sectorTaxonomy');

const LEGACY_SECTORS = new Set(['agricultura', 'ganaderia', 'mixto', 'otros']);
const LEGACY_ALERT_TYPES = new Set([
  'ayudas_subvenciones',
  'normativa_general',
  'agua_infraestructuras',
  'fiscalidad',
  'medio_ambiente',
  'sanidad_animal',
  'sanidad_vegetal',
  'incendios_emergencias',
  'obligaciones',
  'restricciones',
  'forestal',
  'formacion',
  'registros_certificaciones',
  'plazos_alegaciones',
]);

const TYPE_FEATURES = Object.freeze({
  ayudas_subvenciones: 'concepto:ayuda_directa',
  normativa_general: 'concepto:normativa',
  agua_infraestructuras: 'concepto:agua_riego',
  fiscalidad: 'concepto:fiscalidad',
  medio_ambiente: 'concepto:medio_ambiente',
  sanidad_animal: 'concepto:sanidad_animal',
  sanidad_vegetal: 'concepto:fitosanitarios',
  incendios_emergencias: 'concepto:dano_climatico',
  obligaciones: 'accion:declarar',
  restricciones: 'concepto:normativa',
  forestal: 'subsector:forestal',
  formacion: 'concepto:formacion',
  registros_certificaciones: 'subsector:registro_explotaciones',
  plazos_alegaciones: 'accion:alegar',
});

function lista(value) {
  return Array.isArray(value) ? value : [];
}

function dedupe(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function listasIguales(a = [], b = []) {
  return Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length && a.every((value, index) => value === b[index]);
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
  const sectoresCanonicos = dedupe(
    lista(clasificacion.sectores)
      .map(canonicalSector)
      .filter((value) => LEGACY_SECTORS.has(value))
  );
  const subsectoresCanonicos = dedupe(
    lista(clasificacion.subsectores)
      .map(canonicalSubsector)
      .filter(Boolean)
  );
  const reparacionSectorial = repararClasificacionSectorialSegura({
    ...clasificacion,
    sectores: sectoresCanonicos,
    subsectores: subsectoresCanonicos,
  });
  const tiposAlertaIniciales = dedupe(
    lista(clasificacion.tipos_alerta)
      .map(canonicalTipoAlerta)
      .filter((value) => LEGACY_ALERT_TYPES.has(value))
  );
  const reparacionTematica = repararClasificacionTematicaSegura(alerta, {
    ...reparacionSectorial.clasificacion,
    tipos_alerta: tiposAlertaIniciales,
  });
  const sectores = reparacionTematica.clasificacion.sectores;
  const subsectores = reparacionTematica.clasificacion.subsectores;
  const tiposAlerta = reparacionTematica.clasificacion.tipos_alerta;
  const diagnosticoSectorialFinal = analizarCoherenciaSectorSubsector({ sectores, subsectores });
  const validacionAnterior = clasificacion.taxonomy_validation;
  const conservarReparacionAnterior =
    validacionAnterior?.version === TAXONOMY_COHERENCE_VERSION &&
    validacionAnterior.status === 'repaired' &&
    diagnosticoSectorialFinal.status === 'coherent' &&
    reparacionTematica.diagnostico.status === 'coherent' &&
    listasIguales(validacionAnterior.sectores_resultantes, sectores) &&
    listasIguales(validacionAnterior.subsectores_normalizados, subsectores);
  const taxonomyValidation = conservarReparacionAnterior
    ? validacionAnterior
    : {
      ...diagnosticoSectorialFinal,
      status: (
        reparacionSectorial.diagnostico.repairs.length > 0 ||
        (reparacionTematica.diagnostico.repairs || []).length > 0
      ) && diagnosticoSectorialFinal.ok && reparacionTematica.diagnostico.ok
        ? 'repaired'
        : diagnosticoSectorialFinal.status,
      sectores_originales: reparacionSectorial.diagnostico.sectores_originales,
      subsectores_originales: reparacionSectorial.diagnostico.subsectores_originales,
      sectores_resultantes: sectores,
      repairs: [
        ...(reparacionSectorial.diagnostico.repairs || []),
        ...(reparacionTematica.diagnostico.repairs || []),
      ],
      topic_validation: reparacionTematica.diagnostico,
    };
  const normalized = {
    ...clasificacion,
    sectores,
    subsectores,
    tipos_alerta: tiposAlerta,
    taxonomy_validation: taxonomyValidation,
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
