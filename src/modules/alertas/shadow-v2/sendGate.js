const SEND_GATE_VERSION = 'shadow-v2-send-gate-3';

const CLOSED_DOCUMENT_PATTERNS = Object.freeze([
  ['administrative_agreement', /\bconvenio(?:\s+de\s+colaboracion)?\b/],
  ['granted_authorization', /\b(?:se\s+)?(?:otorg\w*|conced\w*)\b.{0,100}\bautorizacion(?:es)?\b|\bautorizacion(?:es)?\b.{0,80}\b(?:otorgad\w*|concedid\w*)\b/],
  ['resolved_procedure', /\bresuelve\s+favorablemente\b|\bresolucion\s+favorable\b/],
  ['completed_environmental_assessment', /\bse\s+formula\s+(?:la\s+)?declaracion\s+de\s+impacto\s+ambiental\b|\bse\s+hace\s+publico\s+(?:el\s+)?informe\s+(?:de\s+)?impacto\s+ambiental\b/],
  ['completed_award', /\bconcesion\s+definitiva\b|\bpor\s+la\s+que\s+se\s+conced\w*\b.{0,60}\bayudas?\b|\b(?:relacion|listado)\s+(?:definitiv[oa]\s+)?de\s+(?:personas\s+)?beneficiari/],
  ['provisional_award', /\b(?:resolucion|propuesta)\s+provisional\b.{0,120}\b(?:concesion|ayudas?|beneficiari)/],
  ['final_approval', /\baprobacion\s+definitiva\b|\bse\s+aprueba\s+definitivamente\b/],
  ['resolved_authorization_modification', /\bresolucion\b.{0,140}\b(?:modifica|modificacion)\b.{0,120}\bautorizacion\s+ambiental\b|\b(?:modifica|modificacion)\b.{0,120}\bautorizacion\s+ambiental\b.{0,120}\bresolucion\b/],
  ['completed_specification_change', /\b(?:se\s+aprueba|aprobacion)\b.{0,120}\bmodificacion\b.{0,120}\b(?:pliego\s+de\s+condiciones|denominacion\s+de\s+origen|indicacion\s+geografica)\b/],
  ['individual_proceeding', /\b(?:procedimientos?|expedientes?)\s+(?:administrativos?\s+)?sancionadores?\b|\bnotificacion(?:es)?\s+individual(?:es)?\b/],
  ['public_employment', /\bempleo\s+publico\b|\bbolsa\s+de\s+empleo\b|\bprocesos?\s+selectivos?\b|\bplantillas?\s+de\s+personal\b|\bplazas?\b.{0,80}\b(?:funcionari|personal\s+laboral)\b/],
]);

const ACTION_RULES = Object.freeze([
  {
    code: 'application_or_appeal',
    action: /\b(?:solicit|inscrib|present|aleg|recurr|recurso|subsan|tramita)/,
    source: /\b(?:solicit|inscrip|present|aleg|recurr|recurso|subsan|tramita)/,
  },
  {
    code: 'contract_or_insure',
    action: /\b(?:contrat|suscrib|asegur)/,
    source: /\b(?:contrat|suscrib|asegur)/,
  },
  {
    code: 'mandatory_compliance',
    action: /\b(?:cumpl|adapt|vacun|registr|comunic|declar|notific)/,
    source: /\b(?:deber|oblig|requisit|prohib|restric|vacun|registr|comunic|declar|notific)/,
  },
  {
    code: 'participation',
    action: /\b(?:particip|asist)/,
    source: /\b(?:particip|asist|inscrip|solicit|suscrib|contrat)/,
  },
  {
    code: 'protective_action',
    action: /\b(?:adopt|evit|proteg|retir|suspend|limita|restring)/,
    source: /\b(?:alerta|riesgo|prohib|suspend|limit|restric|medida)/,
  },
]);

const GENERIC_REVIEW_ACTION = /\b(?:revis|comprob|consulta)/;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function evidenceFragments(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const split = raw.split(/[\n|;]+|["“”]\s*,\s*["“”]/g);
  return [...new Set([raw, ...split]
    .map((item) => normalizeText(item))
    .filter((item) => item.length >= 12))];
}

function literalEvidence(card = {}, sourceText = '') {
  const source = normalizeText(sourceText);
  if (!source) return [];
  const matched = [];
  for (const evidence of Array.isArray(card.evidence) ? card.evidence : []) {
    const fragment = evidenceFragments(evidence).find((item) => source.includes(item));
    if (fragment) matched.push(fragment);
  }
  return [...new Set(matched)];
}

function closedDocumentReason(title = '') {
  const normalized = normalizeText(title);
  for (const [reason, pattern] of CLOSED_DOCUMENT_PATTERNS) {
    if (pattern.test(normalized)) return reason;
  }
  return null;
}

function supportedAction(card = {}, sourceText = '') {
  const action = normalizeText(card.action);
  const source = normalizeText(sourceText);
  const direct = ACTION_RULES
    .filter((rule) => rule.action.test(action) && rule.source.test(source))
    .map((rule) => rule.code);
  if (direct.length > 0) return [...new Set(direct)];

  // "Revisa" o "comprueba" solo es aceptable cuando el documento demuestra
  // una actuacion concreta. Por si solas son las frases genericas que queremos
  // impedir que IA 1 convierta en accionabilidad.
  if (GENERIC_REVIEW_ACTION.test(action)) {
    const sourceBacked = ACTION_RULES.filter((rule) => rule.source.test(source));
    if (sourceBacked.length > 0) return sourceBacked.map((rule) => rule.code);
  }
  return [];
}

function evaluateSendGate({ officialSnapshot = {}, card = {}, workflowDate = null } = {}) {
  const reasons = [];
  const outcomeReason = closedDocumentReason(officialSnapshot.title)
    || closedDocumentReason(String(card.summary || '').slice(0, 180));
  const evidence = literalEvidence(card, officialSnapshot.official_content);
  const actionSupport = supportedAction(card, officialSnapshot.official_content);
  const officialUrl = String(officialSnapshot.official_url || '').trim();

  if (card.relevant !== true) reasons.push('not_relevant');
  if (card.actionable !== true) reasons.push('not_actionable');
  if (!['active', 'upcoming', 'informational'].includes(String(card.status || ''))) {
    reasons.push(`status_${card.status || 'missing'}`);
  }
  if (!/^https?:\/\/\S+$/i.test(officialUrl)) reasons.push('official_url_missing');
  if (outcomeReason) reasons.push(outcomeReason);
  if (evidence.length === 0) reasons.push('literal_evidence_missing');
  if (actionSupport.length === 0) reasons.push('user_action_not_supported');
  if (
    /^\d{4}-\d{2}-\d{2}$/.test(String(card.deadline || ''))
    && /^\d{4}-\d{2}-\d{2}$/.test(String(workflowDate || ''))
    && card.deadline < workflowDate
  ) {
    reasons.push('deadline_expired');
  }

  return {
    version: SEND_GATE_VERSION,
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    diagnostics: {
      literal_evidence_count: evidence.length,
      action_support: actionSupport,
      closed_document_reason: outcomeReason,
    },
  };
}

module.exports = {
  SEND_GATE_VERSION,
  normalizeText,
  evidenceFragments,
  literalEvidence,
  closedDocumentReason,
  supportedAction,
  evaluateSendGate,
};
