const { AI2_LEVELS, verifiedCandidateTitle } = require('./ai2');

const RELATED_SECTION_TITLE = 'Otras novedades que también pueden interesarte';

function renderSelectedItem(item, position) {
  const officialUrl = /^https?:\/\/\S+$/i.test(String(item.official_url || '').trim())
    ? String(item.official_url).trim()
    : '';
  const lines = [
    `*${position}. ${item.title}*`,
    item.summary,
    `👉 *Qué puedes hacer:* ${item.action}`,
  ];
  if (item.deadline) lines.push(`⏳ *Plazo:* ${item.deadline}`);
  if (officialUrl) lines.push(`🔗 *Fuente oficial:* ${officialUrl}`);
  return lines.join('\n');
}

function recipientFirstName(user = {}) {
  const value = user.first_name || user.name || user.legal_name || '';
  return String(value).replace(/\s+/g, ' ').trim().split(' ')[0].slice(0, 80);
}

function renderDigestMessage(ai2Result = {}, user = {}) {
  const selected = ai2Result.selected || [];
  if (selected.length === 0) return '';
  const invalidLevel = selected.find((item) => !AI2_LEVELS.includes(item.level));
  if (invalidLevel) throw new Error('digest_item_level_invalid');
  const priority = selected.filter((item) => item.level === 'priority');
  const related = selected.filter((item) => item.level === 'related');
  const firstName = recipientFirstName(user);
  const greeting = firstName ? `¡Hola, ${firstName}! 👋` : '¡Hola! 👋';
  const opportunityLine = selected.length === 1
    ? 'Hoy he seleccionado para ti *una novedad rural que merece la pena revisar*.'
    : `Hoy he seleccionado para ti *${selected.length} novedades rurales que merecen la pena revisar*.`;
  const hook = String(ai2Result.message || '').trim();
  const feedbackQuestion = selected.length === 1
    ? '¿Qué te parece esta alerta?'
    : '¿Qué te parecen estas alertas?';
  const feedback = [
    `${feedbackQuestion} Responde brevemente para que el sistema aprenda tus intereses.`,
    '*Ruralicos* 🌱',
  ].join('\n');
  const renderedItems = priority.map((item, index) => renderSelectedItem(item, index + 1));
  if (related.length > 0) {
    renderedItems.push(`*${RELATED_SECTION_TITLE}*`);
    renderedItems.push(...related.map((item, index) => (
      renderSelectedItem(item, priority.length + index + 1)
    )));
  }
  return [
    greeting,
    opportunityLine,
    hook,
    ...renderedItems,
    feedback,
  ].filter(Boolean).join('\n\n');
}

function projectDigest(ai2Result = {}, { user = {}, candidates = [] } = {}) {
  const candidatesById = new Map(candidates.map((candidate) => [Number(candidate.alert_id), candidate]));
  const selected = (ai2Result.selected || []).map((item) => {
    const candidate = candidatesById.get(Number(item.alert_id));
    if (!candidate) throw new Error('selected_candidate_missing');
    const card = candidate.card || {};
    return {
      ...item,
      title: verifiedCandidateTitle(candidate),
      summary: card.summary || '',
      action: card.action || '',
      deadline: card.deadline || null,
      official_url: candidate.official_snapshot?.official_url || null,
    };
  });
  const enrichedResult = { ...ai2Result, selected };
  return {
    message: renderDigestMessage(enrichedResult, user),
    items: selected.map((item, index) => ({
      ...item,
      position: index + 1,
      rendered_block: renderSelectedItem(item, index + 1),
    })),
  };
}

module.exports = {
  RELATED_SECTION_TITLE,
  recipientFirstName,
  renderSelectedItem,
  renderDigestMessage,
  projectDigest,
};
