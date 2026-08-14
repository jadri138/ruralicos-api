function renderSelectedItem(item, position) {
  const lines = [
    `*${position}. ${item.title}*`,
    item.summary,
    `👉 *Qué puedes hacer:* ${item.action}`,
  ];
  if (item.deadline) lines.push(`⏳ *Plazo:* ${item.deadline}`);
  return lines.join('\n');
}

function recipientFirstName(user = {}) {
  const value = user.first_name || user.name || user.legal_name || '';
  return String(value).replace(/\s+/g, ' ').trim().split(' ')[0].slice(0, 80);
}

function renderDigestMessage(ai2Result = {}, user = {}) {
  const selected = ai2Result.selected || [];
  if (selected.length === 0) return '';
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
  return [
    greeting,
    opportunityLine,
    hook,
    ...selected.map((item, index) => renderSelectedItem(item, index + 1)),
    feedback,
  ].filter(Boolean).join('\n\n');
}

function projectDigest(ai2Result = {}, { user = {} } = {}) {
  const selected = ai2Result.selected || [];
  return {
    message: renderDigestMessage(ai2Result, user),
    items: selected.map((item, index) => ({
      ...item,
      position: index + 1,
      rendered_block: renderSelectedItem(item, index + 1),
    })),
  };
}

module.exports = {
  recipientFirstName,
  renderSelectedItem,
  renderDigestMessage,
  projectDigest,
};
