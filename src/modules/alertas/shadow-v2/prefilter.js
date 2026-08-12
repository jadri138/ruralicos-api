const {
  RURAL_ORGANIZATIONS,
  RURAL_TERMS_BY_TOPIC,
  METADATA_ONLY_RURAL_TERMS,
} = require('./config');

const METADATA_ONLY_TERM_SET = new Set(METADATA_ONLY_RURAL_TERMS);

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
  const organizationText = normalizeText([
    officialSnapshot.title,
    officialSnapshot.organization,
    officialSnapshot.section,
  ].filter(Boolean).join('\n'));
  const metadataText = normalizeText([
    officialSnapshot.title,
    officialSnapshot.organization,
    officialSnapshot.section,
  ].filter(Boolean).join('\n'));
  const bodyText = normalizeText(officialContent);

  const organizations = detectedTerms(organizationText, RURAL_ORGANIZATIONS);
  const ruralTermsByTopic = {};
  for (const [topic, terms] of Object.entries(RURAL_TERMS_BY_TOPIC)) {
    const metadataFound = detectedTerms(metadataText, terms);
    const bodyFound = detectedTerms(
      bodyText,
      terms.filter((term) => !METADATA_ONLY_TERM_SET.has(normalizeText(term)))
    );
    const found = [...new Set([...metadataFound, ...bodyFound])];
    if (found.length > 0) ruralTermsByTopic[topic] = found;
  }
  const ruralTerms = [...new Set(Object.values(ruralTermsByTopic).flat())];
  const ruralSignal = organizations.length > 0 || ruralTerms.length > 0;
  const reasons = [];
  let passed = false;

  if (duplicateOf !== null && duplicateOf !== undefined) {
    reasons.push('duplicate_already_resolved');
  } else if (ruralSignal) {
    passed = true;
    if (organizations.length > 0) reasons.push('rural_organization');
    if (ruralTerms.length > 0) reasons.push('rural_vocabulary');
  } else {
    reasons.push('no_rural_signal');
  }

  return {
    decision: passed ? 'PASS' : 'REJECT',
    passed,
    reasons,
    detected_organizations: organizations,
    detected_rural_terms: ruralTerms,
    detected_rural_terms_by_topic: ruralTermsByTopic,
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
