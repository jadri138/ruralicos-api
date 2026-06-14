// src/utils/phoneNormalizer.js
//
// Normaliza números de teléfono españoles al formato 34XXXXXXXXX (11 dígitos).
// Compartido por users.js y userAuth.js.

const LONGITUD_TELEFONO = 11; // 34 + 9 dígitos ES

function normalizePhone(input) {
  let digits = String(input || '').trim().replace(/\D/g, '');
  if (digits.length === 9) digits = '34' + digits;
  return digits;
}

function isPhoneValid(digits) {
  return digits.length === LONGITUD_TELEFONO;
}

module.exports = { normalizePhone, isPhoneValid, LONGITUD_TELEFONO };
