const {
  RURAL_ORGANIZATIONS,
  POSITIVE_TERMS_BY_TOPIC,
  UNAMBIGUOUS_NEGATIVE_TERMS,
} = require('./config');

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsTerm(haystack, term) {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegex(normalizedTerm)}(?:$|[^a-z0-9])`, 'i')
    .test(haystack);
}

function detectedTerms(text, terms) {
  return [...new Set(terms.filter((term) => containsTerm(text, term)).map(normalizeText))];
}

function prefilterAlert(officialSnapshot = {}) {
  const duplicateOf = officialSnapshot.duplicate_of ?? null;
  const officialContent = String(officialSnapshot.official_content || '').trim();
  const officialUrl = String(officialSnapshot.official_url || '').trim();
  const searchable = normalizeText([
    officialSnapshot.title,
    officialSnapshot.organization,
    officialSnapshot.source,
    officialContent,
    officialUrl,
  ].filter(Boolean).join('\n'));

  const organizations = detectedTerms(searchable, RURAL_ORGANIZATIONS);
  const positiveByTopic = {};
  for (const [topic, terms] of Object.entries(POSITIVE_TERMS_BY_TOPIC)) {
    const found = detectedTerms(searchable, terms);
    if (found.length > 0) positiveByTopic[topic] = found;
  }
  const positiveTerms = [...new Set(Object.values(positiveByTopic).flat())];
  const negativeTerms = detectedTerms(searchable, UNAMBIGUOUS_NEGATIVE_TERMS);
  const ruralSignal = organizations.length > 0 || positiveTerms.length > 0;
  const reasons = [];
  let passed = true;

  if (duplicateOf !== null && duplicateOf !== undefined) {
    passed = false;
    reasons.push('duplicate_already_resolved');
  } else if (negativeTerms.length > 0 && !ruralSignal) {
    passed = false;
    reasons.push('unambiguous_non_rural_noise');
  } else {
    if (organizations.length > 0) reasons.push('rural_organization');
    if (positiveTerms.length > 0) reasons.push('rural_positive_term');
    if (negativeTerms.length > 0 && ruralSignal) reasons.push('contradictory_signals_forwarded');
    if (!ruralSignal && negativeTerms.length === 0) reasons.push('uncertain_forwarded');
  }

  return {
    passed,
    reasons,
    detected_organizations: organizations,
    detected_positive_terms: positiveTerms,
    detected_positive_terms_by_topic: positiveByTopic,
    detected_negative_terms: negativeTerms,
    has_official_document: officialContent.length > 0,
    has_official_url: /^https?:\/\//i.test(officialUrl),
    duplicate_of: duplicateOf,
  };
}

module.exports = {
  normalizeText,
  containsTerm,
  detectedTerms,
  prefilterAlert,
};
