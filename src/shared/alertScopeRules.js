function normalizarTextoScope(value) {
  const source = value && typeof value === 'object'
    ? [
      value.titulo,
      value.contenido,
      value.resumen,
      value.resumen_borrador,
      value.resumen_final,
    ].filter(Boolean).join(' ')
    : String(value || '');

  return source
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const OUT_OF_SCOPE_REASONS = Object.freeze({
  association_registration_without_user_action:
    'La publicacion inscribe una asociacion en un registro y no abre ninguna actuacion para el usuario.',
  cultural_content_out_of_scope:
    'La publicacion trata contenido cultural sin relacion operativa con la actividad agraria.',
  sports_grant_out_of_scope:
    'La convocatoria se dirige exclusivamente a clubes, entidades o actividades deportivas.',
  non_agricultural_collective_agreement:
    'La publicacion es un convenio colectivo sin relacion con la actividad agraria.',
});

function tieneAccionAbierta(texto) {
  return /\b(?:convocatoria|plazo|presentar solicitud|solicitudes?|inscripcion abierta|podran inscribirse|deberan inscribirse|subsanacion|alegaciones)\b/.test(texto);
}

function detectarDescarteEstructuradoFueraAlcance(value) {
  const texto = normalizarTextoScope(value);
  if (!texto) return null;

  const inscripcionAsociacion = /\b(?:asociacion|cexvet)\b/.test(texto)
    && /\bregistro\b/.test(texto)
    && /\b(?:inscripcion|inscribe|inscrita|registrada|constitucion)\b/.test(texto)
    && !tieneAccionAbierta(texto);
  if (inscripcionAsociacion) {
    return {
      reasonCode: 'association_registration_without_user_action',
      reason: OUT_OF_SCOPE_REASONS.association_registration_without_user_action,
    };
  }

  const contenidoBelenista = /\bbelenismo\b/.test(texto)
    || /\b(?:concurso|exposicion|premio|certamen)\b.{0,80}\bbelen(?:es)?\b/.test(texto);
  if (contenidoBelenista) {
    return {
      reasonCode: 'cultural_content_out_of_scope',
      reason: OUT_OF_SCOPE_REASONS.cultural_content_out_of_scope,
    };
  }

  const subvencionDeportiva = /\b(?:ayudas?|subvencion(?:es)?|convocatoria)\b/.test(texto)
    && /\b(?:deportiv|clubes? deportivos?|deportistas?|federaciones? deportivas?)\w*\b/.test(texto);
  if (subvencionDeportiva) {
    return {
      reasonCode: 'sports_grant_out_of_scope',
      reason: OUT_OF_SCOPE_REASONS.sports_grant_out_of_scope,
    };
  }

  const convenioColectivoNoAgrario = /\bconvenio colectivo\b/.test(texto)
    && /\b(?:no agrario|oficinas|despachos|comercio|hosteleria)\b/.test(texto);
  if (convenioColectivoNoAgrario) {
    return {
      reasonCode: 'non_agricultural_collective_agreement',
      reason: OUT_OF_SCOPE_REASONS.non_agricultural_collective_agreement,
    };
  }

  return null;
}

function detectarTratamientoEspecialAlerta(value) {
  const texto = normalizarTextoScope(value);
  if (!texto) return null;

  const convenioHiguera = /\b(?:higuera|ficus carica)\b/.test(texto)
    && /\b(?:convenio|variedad(?:es)?|material vegetal|recursos fitogeneticos|viveros?|obtentores?|investigacion)\b/.test(texto);
  if (convenioHiguera) {
    return {
      decision: 'keep_specialist',
      priority: 'low',
      audience: 'variety_breeders_nurseries_researchers',
      automatic_general_send: false,
      reason_code: 'specialist_plant_variety_content',
    };
  }

  const holaluz = /\bholaluz\b/.test(texto);
  const condicionCliente = /\b(?:clientes?|ser cliente|comercializadora|contrato de suministro|titulares? del contrato)\b/.test(texto);
  if (holaluz && condicionCliente) {
    return {
      decision: 'store_not_send',
      priority: 'low',
      audience: 'verified_commercializer_customers',
      automatic_general_send: false,
      reason_code: 'commercializer_customer_condition_not_verified',
      reason: 'Relevancia condicionada a ser cliente de la comercializadora.',
    };
  }

  return null;
}

function construirClasificacionTratamientoEspecial(alerta = {}) {
  const specialHandling = detectarTratamientoEspecialAlerta(alerta);
  if (!specialHandling) return null;

  if (specialHandling.decision === 'keep_specialist') {
    return {
      id: String(alerta.id),
      es_relevante: true,
      provincias: [],
      sectores: ['agricultura'],
      subsectores: ['frutales'],
      tipos_alerta: ['normativa_general'],
      special_handling: specialHandling,
    };
  }

  return {
    id: String(alerta.id),
    es_relevante: true,
    provincias: [],
    sectores: ['otros'],
    subsectores: ['energia'],
    tipos_alerta: ['normativa_general'],
    special_handling: specialHandling,
  };
}

module.exports = {
  OUT_OF_SCOPE_REASONS,
  construirClasificacionTratamientoEspecial,
  detectarDescarteEstructuradoFueraAlcance,
  detectarTratamientoEspecialAlerta,
  normalizarTextoScope,
};
