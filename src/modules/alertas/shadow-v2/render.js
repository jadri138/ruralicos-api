function renderSelectedItem(item, position) {
  const lines = [
    `${position}. ${item.title}`,
    item.summary,
    `Que puedes hacer: ${item.action}`,
  ];
  if (item.deadline) lines.push(`Plazo: ${item.deadline}`);
  return lines.join('\n');
}

function projectDigest(ai2Result = {}) {
  const selected = ai2Result.selected || [];
  return {
    message: selected.length === 0 ? '' : String(ai2Result.message || '').trim(),
    items: selected.map((item, index) => ({
      ...item,
      position: index + 1,
      rendered_block: renderSelectedItem(item, index + 1),
    })),
  };
}

module.exports = { renderSelectedItem, projectDigest };
