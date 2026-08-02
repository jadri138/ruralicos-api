const { renderSafeMessageBlock } = require('../alertas/decision');

const DEFAULT_MAX_MESSAGE_CHARS = 3200;

function compact(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trim()}…`;
}

function userName(user = {}) {
  return compact(user.first_name || user.name || '', 50);
}

function formatDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(date || 'hoy');
}

function factMap(projection = {}) {
  return new Map((projection.facts || []).map((fact) => [fact.field, fact.value]));
}

function renderDecisionAlertBlock(alerta = {}, index = 0) {
  const projection = alerta.personal_decision?.message_projection
    || alerta.decision_digest?.canonical?.message_projection
    || null;
  if (!projection?.allowed || !renderSafeMessageBlock(projection)) return null;

  const facts = factMap(projection);
  const title = compact(facts.get('title'), 150);
  const officialUrl = String(facts.get('official_url') || '').trim();
  if (!title || !/^https?:\/\//i.test(officialUrl)) return null;

  const lines = [`*${index + 1}. ${title}*`];
  if (projection.user_reason) {
    lines.push(`Por qué te puede interesar: ${compact(projection.user_reason, 180)}`);
  }
  if (facts.get('summary')) lines.push(compact(facts.get('summary'), 260));
  if (facts.get('beneficiaries')) {
    lines.push(`Para quién: ${compact(facts.get('beneficiaries'), 150)}`);
  }
  if (facts.get('territory')) lines.push(`Ámbito: ${compact(facts.get('territory'), 120)}`);
  if (facts.get('action')) lines.push(`Qué puedes hacer: ${compact(facts.get('action'), 170)}`);
  if (facts.get('deadline')) lines.push(`Plazo oficial: ${compact(facts.get('deadline'), 110)}`);
  if (facts.get('amount')) lines.push(`Cuantía indicada: ${compact(facts.get('amount'), 100)}`);
  lines.push(`Fuente oficial: ${officialUrl}`);
  return lines.join('\n');
}

function fitBlocks(header, blocks, maxChars) {
  const included = [];
  for (const block of blocks) {
    const next = [header, ...included, block].filter(Boolean).join('\n\n');
    if (next.length > maxChars) break;
    included.push(block);
  }
  return included;
}

function renderDecisionDigestMessage({
  user = {},
  alertas = [],
  fecha,
  maxChars = Number(process.env.ALERT_DECISION_MESSAGE_MAX_CHARS) || DEFAULT_MAX_MESSAGE_CHARS,
} = {}) {
  const limit = Math.max(800, Math.min(4096, Number(maxChars) || DEFAULT_MAX_MESSAGE_CHARS));
  const name = userName(user);
  const header = `${name ? `Hola ${name} 👋\n\n` : ''}*Tus alertas rurales del ${formatDate(fecha)}*`;
  const validAlerts = [];
  const blocks = [];
  for (const alerta of alertas || []) {
    const block = renderDecisionAlertBlock(alerta, blocks.length);
    if (!block) continue;
    blocks.push(block);
    validAlerts.push(alerta);
  }
  if (blocks.length === 0) return { message: null, alertas: [], omitted: (alertas || []).length };

  const includedBlocks = fitBlocks(header, blocks, limit);
  if (includedBlocks.length === 0) {
    return { message: null, alertas: [], omitted: (alertas || []).length };
  }
  return {
    message: [header, ...includedBlocks].join('\n\n'),
    alertas: validAlerts.slice(0, includedBlocks.length),
    omitted: Math.max(0, (alertas || []).length - includedBlocks.length),
  };
}

module.exports = {
  DEFAULT_MAX_MESSAGE_CHARS,
  renderDecisionAlertBlock,
  renderDecisionDigestMessage,
};
