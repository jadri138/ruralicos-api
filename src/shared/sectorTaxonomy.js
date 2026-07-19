const {
  canonicalSector,
  canonicalSubsector,
} = require('./preferenceCanonical');

const TAXONOMY_COHERENCE_VERSION = 'taxonomy_coherence_v1';

const SUBSECTORES_GANADERIA = new Set([
  'ovino',
  'vacuno',
  'caprino',
  'porcino',
  'avicultura',
  'cunicultura',
  'equinocultura',
  'apicultura',
  'bienestar_animal',
  'sanidad_animal',
  'transporte_animales',
  'razas_autoctonas',
  'ganaderia_precision',
  'bioseguridad',
]);

const SUBSECTORES_AGRICULTURA = new Set([
  'trigo',
  'cebada',
  'cereal',
  'maiz',
  'arroz',
  'hortalizas',
  'frutales',
  'hortofruticola',
  'olivar',
  'trufas',
  'vinedo',
  'almendro',
  'citricos',
  'frutos_secos',
  'leguminosas',
  'patata',
  'fitosanitarios',
  'jovenes_agricultores',
  'maquinaria',
  'agricultura_precision',
  'cultivos_industriales',
  'semillas',
  'viveros',
  'floricultura',
  'agua',
]);

const SUBSECTORES_TRANSVERSALES = new Set([
  'seguros_agrarios',
  'desarrollo_rural',
  'modernizacion_explotaciones',
  'forrajes',
  'forestal',
  'medio_ambiente',
  'energia',
  'financiacion',
  'pac',
  'registro_explotaciones',
  'calidad_diferenciada',
  'agroindustria',
  'comercializacion',
  'formacion',
  'infraestructuras',
  'fauna_silvestre',
]);

function dedupe(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function listaOriginal(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function listaCanonica(value, canonicalizer) {
  return dedupe(listaOriginal(value).map(canonicalizer).filter(Boolean));
}

function normalizarTag(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function taxonomyTagsAlerta(alerta = {}) {
  return Array.isArray(alerta.taxonomy_tags)
    ? alerta.taxonomy_tags.map(normalizarTag).filter(Boolean)
    : [];
}

function valoresTaxonomiaPorPrefijo(alerta = {}, prefijo = '', canonicalizer) {
  const prefix = normalizarTag(prefijo);
  return taxonomyTagsAlerta(alerta)
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => canonicalizer(tag.slice(prefix.length)))
    .filter(Boolean);
}

function sectoresDerivadosAlerta(alerta = {}) {
  return dedupe([
    ...listaCanonica(alerta.sectores, canonicalSector),
    ...valoresTaxonomiaPorPrefijo(alerta, 'sector:', canonicalSector),
  ]);
}

function subsectoresDerivadosAlerta(alerta = {}) {
  return dedupe([
    ...listaCanonica(alerta.subsectores, canonicalSubsector),
    ...valoresTaxonomiaPorPrefijo(alerta, 'subsector:', canonicalSubsector),
  ]);
}

function inferirSectoresDesdeSubsectores(subsectores = []) {
  const normalizados = listaCanonica(subsectores, canonicalSubsector);
  let agricultura = false;
  let ganaderia = false;

  for (const subsector of normalizados) {
    if (SUBSECTORES_TRANSVERSALES.has(subsector)) continue;
    if (SUBSECTORES_AGRICULTURA.has(subsector)) agricultura = true;
    if (SUBSECTORES_GANADERIA.has(subsector)) ganaderia = true;
  }

  return [
    ...(agricultura ? ['agricultura'] : []),
    ...(ganaderia ? ['ganaderia'] : []),
  ];
}

function clasificarAmbitoSectorialAlerta(sectores = []) {
  const normalizados = listaCanonica(sectores, canonicalSector);
  const agricultura = normalizados.includes('agricultura');
  const ganaderia = normalizados.includes('ganaderia');

  if (normalizados.includes('mixto') || (agricultura && ganaderia)) return 'mixto';
  if (agricultura) return 'agricultura';
  if (ganaderia) return 'ganaderia';
  return 'neutral';
}

function analizarCoherenciaSectorSubsector({ sectores = [], subsectores = [] } = {}) {
  const sectoresOriginales = listaOriginal(sectores);
  const subsectoresOriginales = listaOriginal(subsectores);
  const sectoresNormalizados = listaCanonica(sectores, canonicalSector);
  const subsectoresNormalizados = listaCanonica(subsectores, canonicalSubsector);
  const ambitoDeclarado = clasificarAmbitoSectorialAlerta(sectoresNormalizados);
  const sectoresInferidos = inferirSectoresDesdeSubsectores(subsectoresNormalizados);
  const conflicts = [];

  if (ambitoDeclarado === 'agricultura' && sectoresInferidos.includes('ganaderia')) {
    conflicts.push({
      code: 'sector_agricultura_con_subsector_ganadero',
      sector: 'agricultura',
      sectores_inferidos: sectoresInferidos,
      subsectores: subsectoresNormalizados,
    });
  }

  if (ambitoDeclarado === 'ganaderia' && sectoresInferidos.includes('agricultura')) {
    conflicts.push({
      code: 'sector_ganaderia_con_subsector_agricola',
      sector: 'ganaderia',
      sectores_inferidos: sectoresInferidos,
      subsectores: subsectoresNormalizados,
    });
  }

  let status = 'coherent';
  let ok = true;
  let motivo = null;

  if (conflicts.length > 0) {
    status = 'incoherent';
    ok = false;
    motivo = 'alerta_taxonomia_incoherente';
  } else if (sectoresNormalizados.length === 0) {
    status = 'insufficient';
    ok = false;
    motivo = 'alerta_sin_sector_clasificado';
  }

  return {
    version: TAXONOMY_COHERENCE_VERSION,
    status,
    ok,
    sectores_originales: sectoresOriginales,
    sectores_normalizados: sectoresNormalizados,
    subsectores_originales: subsectoresOriginales,
    subsectores_normalizados: subsectoresNormalizados,
    ambito_sectorial_declarado: ambitoDeclarado,
    sectores_inferidos_subsectores: sectoresInferidos,
    sectores_resultantes: sectoresNormalizados,
    repairs: [],
    conflicts,
    motivo,
  };
}

function repararClasificacionSectorialSegura(clasificacion = {}) {
  const inicial = analizarCoherenciaSectorSubsector(clasificacion);
  const normalizada = {
    ...clasificacion,
    sectores: inicial.sectores_normalizados,
    subsectores: inicial.subsectores_normalizados,
  };

  if (inicial.status === 'incoherent') {
    return { clasificacion: normalizada, diagnostico: inicial };
  }

  let sectoresResultantes = [...inicial.sectores_normalizados];
  const repairs = [];
  const inferidos = inicial.sectores_inferidos_subsectores;

  if (sectoresResultantes.length === 0 && inferidos.length > 0) {
    const after = inferidos.length > 1 ? ['mixto'] : [...inferidos];
    repairs.push({
      code: 'sector_inferido_desde_subsectores',
      before: [],
      after,
    });
    sectoresResultantes = after;
  } else if (sectoresResultantes.includes('otros')) {
    const sinOtros = sectoresResultantes.filter((sector) => sector !== 'otros');
    if (sinOtros.length > 0) {
      repairs.push({
        code: 'sector_otros_redundante_eliminado',
        before: [...sectoresResultantes],
        after: sinOtros,
      });
      sectoresResultantes = sinOtros;
    } else if (inferidos.length > 0) {
      const after = inferidos.length > 1 ? ['mixto'] : [...inferidos];
      repairs.push({
        code: 'sector_otros_reemplazado_por_inferencia',
        before: ['otros'],
        after,
      });
      sectoresResultantes = after;
    }
  }

  const clasificacionReparada = {
    ...normalizada,
    sectores: sectoresResultantes,
  };
  const final = analizarCoherenciaSectorSubsector(clasificacionReparada);

  if (repairs.length === 0) {
    return { clasificacion: clasificacionReparada, diagnostico: final };
  }

  return {
    clasificacion: clasificacionReparada,
    diagnostico: {
      ...final,
      status: final.ok ? 'repaired' : final.status,
      sectores_originales: inicial.sectores_originales,
      sectores_normalizados: inicial.sectores_normalizados,
      subsectores_originales: inicial.subsectores_originales,
      subsectores_normalizados: inicial.subsectores_normalizados,
      ambito_sectorial_declarado: inicial.ambito_sectorial_declarado,
      sectores_inferidos_subsectores: inicial.sectores_inferidos_subsectores,
      sectores_resultantes: sectoresResultantes,
      repairs,
      motivo: final.ok ? null : final.motivo,
    },
  };
}

function diagnosticarCoherenciaTaxonomicaAlerta(alerta = {}) {
  const diagnostico = analizarCoherenciaSectorSubsector({
    sectores: sectoresDerivadosAlerta(alerta),
    subsectores: subsectoresDerivadosAlerta(alerta),
  });

  if (diagnostico.status !== 'incoherent') return null;

  return {
    ok: false,
    motivo: 'alerta_taxonomia_incoherente',
    detalle: {
      sectores: diagnostico.sectores_normalizados,
      subsectores: diagnostico.subsectores_normalizados,
      sectores_inferidos_subsectores: diagnostico.sectores_inferidos_subsectores,
      ambito_sectorial_declarado: diagnostico.ambito_sectorial_declarado,
      conflicts: diagnostico.conflicts,
      taxonomy_validation: diagnostico,
    },
  };
}

module.exports = {
  SUBSECTORES_AGRICULTURA,
  SUBSECTORES_GANADERIA,
  SUBSECTORES_TRANSVERSALES,
  TAXONOMY_COHERENCE_VERSION,
  analizarCoherenciaSectorSubsector,
  clasificarAmbitoSectorialAlerta,
  diagnosticarCoherenciaTaxonomicaAlerta,
  inferirSectoresDesdeSubsectores,
  repararClasificacionSectorialSegura,
  sectoresDerivadosAlerta,
  subsectoresDerivadosAlerta,
  taxonomyTagsAlerta,
};
