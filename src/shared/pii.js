function maskPhone(phone) {
  const value = String(phone || '').trim();
  return value ? `****${value.slice(-4)}` : null;
}

function maskEmail(email) {
  const value = String(email || '').trim();
  if (!value || !value.includes('@')) return null;
  const [local, domain] = value.split('@');
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
}

module.exports = {
  maskPhone,
  maskEmail,
};
