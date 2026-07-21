const {
  canonicalSector,
  canonicalSubsector,
  canonicalTipoAlerta,
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

const ANIMAL_HEALTH_EVIDENCE = /\b(?:sanidad\s+animal|zoosanitari|antibiotic|presvet|veterinari|epizooti|bioseguridad|bienestar\s+animal|enfermedad(?:es)?\s+animal(?:es)?|explotaciones?\s+ganaderas?)\b/;
const PLANT_HEALTH_EVIDENCE = /\b(?:sanidad\s+vegetal|fitosanitari|plagas?\s+(?:agricolas?|vegetales?)|enfermedad(?:es)?\s+(?:de\s+los?\s+)?cultivos?|organismos?\s+nocivos?\s+vegetales?)\b/;
const LIVESTOCK_EVIDENCE = /\b(?:ganader|explotaciones?\s+ganaderas?|porcin|vacun|bovin|ovin|caprin|avicul|cunic|equin|apicult|abejas?|veterinari|animal(?:es)?)\b/;
const AGRICULTURE_EVIDENCE = /\b(?:agricultur|agricol|explotaciones?\s+agricolas?|cultivos?|trigo|cebada|cereal|maiz|arroz|hortaliz|frutal|olivar|vined|almendr|patata|citric|leguminos|semillas?|viveros?)\b/;
const FISCAL_EVIDENCE = /\b(?:irpf|iva|tributaci|tributari|modulos?|impuestos?|deducci(?:o|ó)n\s+fiscal|regimen\s+fiscal|r[ée]gimen\s+fiscal)\b/;
const WATER_EVIDENCE = /\b(?:agua|riego|regadio|regantes?|hidric|concesion\s+de\s+aguas?|aprovechamiento\s+de\s+aguas?)\b/;

function textoDocumentalAlerta(alerta = {}) {
  return normalizarTag([
    alerta.titulo,
    alerta.contenido,
    alerta.texto_oficial,
    alerta.texto_raw,
  ].filter(Boolean).join(' '));
}

function tiposDerivadosClasificacion(alerta = {}) {
  return dedupe([
    ...listaCanonica(alerta.tipos_alerta, canonicalTipoAlerta),
    ...valoresTaxonomiaPorPrefijo(alerta, 'tipo:', canonicalTipoAlerta),
  ]);
}

function tieneEvidenciaSanidadAnimal(alerta = {}) {
  return ANIMAL_HEALTH_EVIDENCE.test(textoDocumentalAlerta(alerta));
}

function tieneEvidenciaSanidadVegetal(alerta = {}) {
  return PLANT_HEALTH_EVIDENCE.test(textoDocumentalAlerta(alerta));
}

function esAlertaSanidadAnimal(alerta = {}) {
  const tipos = tiposDerivadosClasificacion(alerta);
  const tags = taxonomyTagsAlerta(alerta);
  return tipos.includes('sanidad_animal') ||
    tags.includes('concepto:sanidad_animal') ||
    tags.includes('concepto:bioseguridad') ||
    tags.includes('concepto:bienestar_animal') ||
    (tipos.length === 0 && tieneEvidenciaSanidadAnimal(alerta));
}

function esAlertaSanidadVegetal(alerta = {}) {
  const tipos = tiposDerivadosClasificacion(alerta);
  const tags = taxonomyTagsAlerta(alerta);
  return tipos.includes('sanidad_vegetal') ||
    tags.includes('concepto:sanidad_vegetal') ||
    (tipos.length === 0 && tieneEvidenciaSanidadVegetal(alerta));
}

function analizarCoherenciaTematica(alerta = {}, clasificacion = {}) {
  const combinada = { ...alerta, ...clasificacion };
  const texto = textoDocumentalAlerta(alerta);
  const sectores = listaCanonica(clasificacion.sectores ?? alerta.sectores, canonicalSector);
  const subsectores = listaCanonica(clasificacion.subsectores ?? alerta.subsectores, canonicalSubsector);
  const tipos = listaCanonica(clasificacion.tipos_alerta ?? alerta.tipos_alerta, canonicalTipoAlerta);
  const sanidadAnimal = esAlertaSanidadAnimal(combinada);
  const sanidadVegetal = esAlertaSanidadVegetal(combinada);
  const evidenciaAnimal = ANIMAL_HEALTH_EVIDENCE.test(texto);
  const evidenciaVegetal = PLANT_HEALTH_EVIDENCE.test(texto);
  const evidenciaGanadera = LIVESTOCK_EVIDENCE.test(texto);
  const evidenciaAgricola = AGRICULTURE_EVIDENCE.test(texto);
  const evidenciaFiscal = FISCAL_EVIDENCE.test(texto);
  const evidenciaAgua = WATER_EVIDENCE.test(texto);
  const cultivos = subsectores.filter((value) => SUBSECTORES_AGRICULTURA.has(value));
  const animales = subsectores.filter((value) => SUBSECTORES_GANADERIA.has(value));
  const issues = [];

  if (sanidadAnimal && !evidenciaAnimal) {
    issues.push({ code: 'animal_health_without_documentary_evidence', severity: 'critical' });
  }
  if (sanidadAnimal && !evidenciaAgricola && sectores.includes('agricultura')) {
    issues.push({ code: 'animal_health_with_unsupported_agriculture_sector', severity: 'repairable' });
  }
  if (sanidadAnimal && !evidenciaAgricola && sectores.includes('mixto')) {
    issues.push({ code: 'animal_health_with_unsupported_mixed_sector', severity: 'repairable' });
  }
  if (sanidadAnimal && !evidenciaAgricola && cultivos.length > 0) {
    issues.push({
      code: 'animal_health_with_unsupported_crop_subsectors',
      severity: 'repairable',
      values: cultivos,
    });
  }
  if (sanidadAnimal && tipos.includes('fiscalidad') && !evidenciaFiscal) {
    issues.push({ code: 'animal_health_with_unsupported_tax_tag', severity: 'repairable' });
  }
  if (
    sanidadAnimal &&
    (subsectores.includes('agua') || tipos.includes('agua_infraestructuras')) &&
    !evidenciaAgua
  ) {
    issues.push({ code: 'animal_health_with_unsupported_water_tag', severity: 'repairable' });
  }

  if (sanidadVegetal && !evidenciaVegetal) {
    issues.push({ code: 'plant_health_without_documentary_evidence', severity: 'critical' });
  }
  if (sanidadVegetal && !evidenciaGanadera && sectores.includes('ganaderia')) {
    issues.push({ code: 'plant_health_with_unsupported_livestock_sector', severity: 'repairable' });
  }
  if (sanidadVegetal && !evidenciaGanadera && sectores.includes('mixto')) {
    issues.push({ code: 'plant_health_with_unsupported_mixed_sector', severity: 'repairable' });
  }
  if (sanidadVegetal && !evidenciaGanadera && animales.length > 0) {
    issues.push({
      code: 'plant_health_with_unsupported_animal_subsectors',
      severity: 'repairable',
      values: animales,
    });
  }

  return {
    version: 'taxonomy_topic_coherence_v1',
    status: issues.some((issue) => issue.severity === 'critical')
      ? 'blocked'
      : (issues.length > 0 ? 'repairable' : 'coherent'),
    ok: issues.length === 0,
    specialized: sanidadAnimal || sanidadVegetal,
    topic: sanidadAnimal ? 'sanidad_animal' : (sanidadVegetal ? 'sanidad_vegetal' : null),
    evidence: {
      animal_health: evidenciaAnimal,
      plant_health: evidenciaVegetal,
      livestock: evidenciaGanadera,
      agriculture: evidenciaAgricola,
      fiscal: evidenciaFiscal,
      water: evidenciaAgua,
    },
    issues,
  };
}

function repararClasificacionTematicaSegura(alerta = {}, clasificacion = {}) {
  const diagnosticoInicial = analizarCoherenciaTematica(alerta, clasificacion);
  const sectoresIniciales = listaCanonica(clasificacion.sectores, canonicalSector);
  const subsectoresIniciales = listaCanonica(clasificacion.subsectores, canonicalSubsector);
  const tiposIniciales = listaCanonica(clasificacion.tipos_alerta, canonicalTipoAlerta);
  let sectores = [...sectoresIniciales];
  let subsectores = [...subsectoresIniciales];
  let tipos = [...tiposIniciales];
  const repairs = [];

  if (diagnosticoInicial.status === 'blocked') {
    return {
      clasificacion: { ...clasificacion, sectores, subsectores, tipos_alerta: tipos },
      diagnostico: diagnosticoInicial,
    };
  }

  if (diagnosticoInicial.topic === 'sanidad_animal' && diagnosticoInicial.evidence.animal_health) {
    if (!diagnosticoInicial.evidence.agriculture) {
      const nextSectores = sectores.filter((value) => value !== 'agricultura' && value !== 'mixto');
      if (nextSectores.length !== sectores.length) {
        repairs.push({ code: 'remove_unsupported_agriculture_from_animal_health', before: sectores, after: nextSectores });
        sectores = nextSectores;
      }
      const nextSubsectores = subsectores.filter((value) => !SUBSECTORES_AGRICULTURA.has(value));
      if (nextSubsectores.length !== subsectores.length) {
        repairs.push({ code: 'remove_unsupported_crops_from_animal_health', before: subsectores, after: nextSubsectores });
        subsectores = nextSubsectores;
      }
    }
    if (!sectores.includes('ganaderia') && !sectores.includes('mixto')) {
      repairs.push({ code: 'add_livestock_sector_from_animal_health_evidence', before: sectores, after: [...sectores, 'ganaderia'] });
      sectores.push('ganaderia');
    }
    if (!tipos.includes('sanidad_animal')) {
      repairs.push({ code: 'add_animal_health_type_from_evidence', before: tipos, after: [...tipos, 'sanidad_animal'] });
      tipos.push('sanidad_animal');
    }
    if (!diagnosticoInicial.evidence.fiscal && tipos.includes('fiscalidad')) {
      const next = tipos.filter((value) => value !== 'fiscalidad');
      repairs.push({ code: 'remove_unsupported_tax_type', before: tipos, after: next });
      tipos = next;
    }
    if (!diagnosticoInicial.evidence.water && tipos.includes('agua_infraestructuras')) {
      const next = tipos.filter((value) => value !== 'agua_infraestructuras');
      repairs.push({ code: 'remove_unsupported_water_type', before: tipos, after: next });
      tipos = next;
    }
  }

  if (diagnosticoInicial.topic === 'sanidad_vegetal' && diagnosticoInicial.evidence.plant_health) {
    if (!diagnosticoInicial.evidence.livestock) {
      const nextSectores = sectores.filter((value) => value !== 'ganaderia' && value !== 'mixto');
      if (nextSectores.length !== sectores.length) {
        repairs.push({ code: 'remove_unsupported_livestock_from_plant_health', before: sectores, after: nextSectores });
        sectores = nextSectores;
      }
      const nextSubsectores = subsectores.filter((value) => !SUBSECTORES_GANADERIA.has(value));
      if (nextSubsectores.length !== subsectores.length) {
        repairs.push({ code: 'remove_unsupported_animals_from_plant_health', before: subsectores, after: nextSubsectores });
        subsectores = nextSubsectores;
      }
    }
    if (!sectores.includes('agricultura') && !sectores.includes('mixto')) {
      repairs.push({ code: 'add_agriculture_sector_from_plant_health_evidence', before: sectores, after: [...sectores, 'agricultura'] });
      sectores.push('agricultura');
    }
  }

  const clasificacionReparada = {
    ...clasificacion,
    sectores: dedupe(sectores),
    subsectores: dedupe(subsectores),
    tipos_alerta: dedupe(tipos),
  };
  const diagnosticoFinal = analizarCoherenciaTematica(alerta, clasificacionReparada);
  return {
    clasificacion: clasificacionReparada,
    diagnostico: {
      ...diagnosticoFinal,
      status: diagnosticoFinal.ok && repairs.length > 0 ? 'repaired' : diagnosticoFinal.status,
      initial_issues: diagnosticoInicial.issues,
      repairs,
    },
  };
}

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

function diagnosticarCoherenciaTaxonomicaAlerta(alerta = {}, options = {}) {
  const sectores = Array.isArray(options.sectores)
    ? options.sectores
    : sectoresDerivadosAlerta(alerta);
  const subsectores = Array.isArray(options.subsectores)
    ? options.subsectores
    : subsectoresDerivadosAlerta(alerta);
  const diagnostico = analizarCoherenciaSectorSubsector({
    sectores,
    subsectores,
  });

  const tematica = options.topicValidation || analizarCoherenciaTematica(alerta, {
    sectores,
    subsectores,
    tipos_alerta: options.tipos,
  });

  if (tematica.status === 'blocked') {
    return {
      ok: false,
      motivo: 'alerta_taxonomia_sin_evidencia_tematica',
      detalle: {
        sectores: diagnostico.sectores_normalizados,
        subsectores: diagnostico.subsectores_normalizados,
        topic_validation: tematica,
      },
    };
  }

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
      topic_validation: tematica,
    },
  };
}

module.exports = {
  SUBSECTORES_AGRICULTURA,
  SUBSECTORES_GANADERIA,
  SUBSECTORES_TRANSVERSALES,
  TAXONOMY_COHERENCE_VERSION,
  analizarCoherenciaTematica,
  analizarCoherenciaSectorSubsector,
  clasificarAmbitoSectorialAlerta,
  diagnosticarCoherenciaTaxonomicaAlerta,
  esAlertaSanidadAnimal,
  esAlertaSanidadVegetal,
  inferirSectoresDesdeSubsectores,
  repararClasificacionSectorialSegura,
  repararClasificacionTematicaSegura,
  sectoresDerivadosAlerta,
  subsectoresDerivadosAlerta,
  taxonomyTagsAlerta,
  textoDocumentalAlerta,
  tieneEvidenciaSanidadAnimal,
  tieneEvidenciaSanidadVegetal,
  tiposDerivadosClasificacion,
};
