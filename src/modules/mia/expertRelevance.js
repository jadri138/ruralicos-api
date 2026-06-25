const {
  evaluarAlertaParaDigest,
} = require('../alertas/seleccion/alertSelectionEngine');

function mapearVeredicto(action) {
  if (action === 'include') return 'incluir';
  if (action === 'review_only') return 'revisar';
  return 'bloquear';
}

function adaptarRazonesLegacy(reasons = []) {
  return reasons.map((reason) => {
    if (reason?.code !== 'expediente_municipio_declarado') return reason;
    return {
      ...reason,
      code: 'expediente_local_explicito',
      source_code: reason.code,
    };
  });
}

function evaluarRelevanciaExperta(alerta = {}, user = {}, options = {}) {
  const decision = evaluarAlertaParaDigest(alerta, user, {
    qualityGate: options.qualityGate !== false,
    minQualityScore: options.minQualityScore ?? 65,
    minIncludeScore: options.minExpertScore ?? 68,
    minReviewScore: options.minReviewScore ?? Math.max(55, (options.minExpertScore ?? 68) - 10),
    allowReview: options.allowReview !== false,
    allowIndividualWithoutMunicipio: options.allowIndividualWithoutMunicipio === true,
  });
  const policy = decision.diagnostico?.policy || {};
  const ranking = decision.diagnostico?.ranking || {};
  const calidad = decision.diagnostico?.calidad || {};
  const blocks = Array.isArray(policy.blocks) ? policy.blocks : [];
  const veredicto = mapearVeredicto(decision.action);

  return {
    version: 'mia_expert_relevance_v2_selection_engine',
    score: decision.score,
    veredicto,
    incluir: decision.action === 'include',
    riesgo: decision.riesgo,
    blocks,
    reasons: adaptarRazonesLegacy(ranking.reasons || []),
    features: ranking.features || [],
    signals: policy.signals || {},
    matcher: {
      ok: !blocks.some((block) =>
        ['fuente_no_permitida', 'provincia_no_coincide', 'sector_no_coincide', 'subsector_no_coincide', 'tipo_alerta_no_coincide', 'matcher_no_coincide'].includes(block.code)
      ),
      motivo: decision.diagnostico?.matcher || null,
      detalle: decision.detalle || null,
    },
    calidad: {
      score: calidad.score,
      grade: calidad.grade,
      flags: calidad.flags || [],
      critical: Boolean(calidad.critical),
      ready_for_digest: Boolean(calidad.ready_for_digest),
    },
    decision_digest: decision,
  };
}

module.exports = {
  evaluarRelevanciaExperta,
};
