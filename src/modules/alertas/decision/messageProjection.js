const { CONTRACT_VERSIONS, DECISION_STATES } = require('./contracts');
const { compactText, evidenceIsUsable } = require('./truthCard');

function uniqueTerritoryParts(values = []) {
  const seen = new Set();
  return values.reduce((parts, value) => {
    const text = compactText(value, 120);
    if (!text) return parts;
    const key = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (seen.has(key)) return parts;
    seen.add(key);
    parts.push(text);
    return parts;
  }, []);
}

function canonicalFieldValue(card, field) {
  const values = {
    title: card?.nature?.title,
    summary: card?.nature?.summary,
    beneficiaries: card?.beneficiaries?.description,
    territory: card?.territory?.national
      ? 'Nacional'
      : uniqueTerritoryParts([
        ...(card?.territory?.municipalities || []),
        ...(card?.territory?.provinces || []),
        ...(card?.territory?.regions || []),
      ]).join(', '),
    action: card?.action?.label || card?.action?.code,
    deadline: card?.time?.deadline,
    amount: card?.value?.amount,
    official_url: card?.identity?.official_url,
  };
  return values[field] ?? null;
}

function projectApprovedMessageFacts({ truthCard, decision, userReason = null } = {}) {
  if (![DECISION_STATES.ADD_TO_DIGEST, DECISION_STATES.SEND_NOW].includes(decision?.decision)) {
    return {
      contract_version: CONTRACT_VERSIONS.messageFacts,
      allowed: false,
      facts: [],
      user_reason: null,
    };
  }
  const facts = [];
  const seen = new Set();
  for (const requested of decision.message_facts || []) {
    const evidence = truthCard?.evidence?.[requested.field];
    const value = canonicalFieldValue(truthCard, requested.field);
    if (!value || !evidenceIsUsable(evidence) || requested.evidence_ref !== evidence.ref) continue;
    if (seen.has(requested.field)) continue;
    seen.add(requested.field);
    facts.push({
      field: requested.field,
      value: compactText(value, requested.field === 'official_url' ? 500 : 400),
      evidence_ref: evidence.ref,
      evidence_level: evidence.level,
    });
  }
  return {
    contract_version: CONTRACT_VERSIONS.messageFacts,
    allowed: facts.length > 0,
    facts,
    user_reason: compactText(userReason, 280),
  };
}

function renderSafeMessageBlock(projection = {}) {
  if (!projection.allowed) return null;
  const byField = new Map(projection.facts.map((fact) => [fact.field, fact.value]));
  const lines = [];
  if (byField.get('title')) lines.push(byField.get('title'));
  if (projection.user_reason) lines.push(projection.user_reason);
  if (byField.get('summary')) lines.push(byField.get('summary'));
  if (byField.get('beneficiaries')) lines.push(`Para quién: ${byField.get('beneficiaries')}`);
  if (byField.get('territory')) lines.push(`Ámbito: ${byField.get('territory')}`);
  if (byField.get('deadline')) lines.push(`Plazo oficial: ${byField.get('deadline')}`);
  if (byField.get('action')) lines.push(`Qué hacer: ${byField.get('action')}`);
  if (byField.get('amount')) lines.push(`Cuantía indicada: ${byField.get('amount')}`);
  if (byField.get('official_url')) lines.push(`Fuente oficial: ${byField.get('official_url')}`);
  return lines.filter(Boolean).join('\n');
}

module.exports = {
  uniqueTerritoryParts,
  canonicalFieldValue,
  projectApprovedMessageFacts,
  renderSafeMessageBlock,
};
