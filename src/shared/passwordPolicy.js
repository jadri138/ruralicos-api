const PASSWORD_POLICY_MESSAGE =
  'La contrasena debe tener al menos 8 caracteres, una mayuscula, un numero y un simbolo.';

const PASSWORD_POLICY_REQUIREMENTS = {
  min_length: 8,
  uppercase: true,
  number: true,
  special_character: true,
};

function validarPassword(password) {
  const value = String(password || '');
  const missing = [];

  if (value.length < PASSWORD_POLICY_REQUIREMENTS.min_length) missing.push('min_length');
  if (!/[A-Z]/.test(value)) missing.push('uppercase');
  if (!/\d/.test(value)) missing.push('number');
  if (!/[^A-Za-z0-9\s]/.test(value)) missing.push('special_character');

  return {
    ok: missing.length === 0,
    error: PASSWORD_POLICY_MESSAGE,
    requirements: PASSWORD_POLICY_REQUIREMENTS,
    missing,
  };
}

module.exports = {
  PASSWORD_POLICY_MESSAGE,
  PASSWORD_POLICY_REQUIREMENTS,
  validarPassword,
};
