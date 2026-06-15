process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const assert = require('assert');

const {
  codeExpired,
  hashVerificationCode,
  legacyCodeMatches,
  normalizePurpose,
} = require('../src/modules/usuarios/verificationCodes');

function test(name, fn) {
  try {
    fn();
    console.log(`OK: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err.message);
    process.exitCode = 1;
  }
}

console.log('\n=== TESTS: verification codes ===\n');

test('hashea codigos sin conservar el valor en claro', () => {
  const hash = hashVerificationCode({
    code: '123456',
    purpose: 'phone_verification',
    phone: '34600000000',
  });

  assert.strictEqual(hash.length, 64);
  assert(!hash.includes('123456'));
});

test('separa hashes por proposito y telefono', () => {
  const base = hashVerificationCode({
    code: '123456',
    purpose: 'phone_verification',
    phone: '34600000000',
  });
  const reset = hashVerificationCode({
    code: '123456',
    purpose: 'password_reset',
    phone: '34600000000',
  });
  const otherPhone = hashVerificationCode({
    code: '123456',
    purpose: 'phone_verification',
    phone: '34611111111',
  });

  assert.notStrictEqual(base, reset);
  assert.notStrictEqual(base, otherPhone);
});

test('valida propositos permitidos', () => {
  assert.strictEqual(normalizePurpose('password_reset'), 'password_reset');
  assert.throws(() => normalizePurpose('login'));
});

test('fallback legacy respeta codigo y caducidad', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();

  assert.strictEqual(legacyCodeMatches({
    phone_verification_code: '123456',
    phone_verification_expires_at: future,
  }, '123456'), true);
  assert.strictEqual(legacyCodeMatches({
    phone_verification_code: '123456',
    phone_verification_expires_at: future,
  }, '000000'), false);
  assert.strictEqual(legacyCodeMatches({
    phone_verification_code: '123456',
    phone_verification_expires_at: past,
  }, '123456'), false);
});

test('detecta caducidad insegura', () => {
  assert.strictEqual(codeExpired(null), true);
  assert.strictEqual(codeExpired('fecha mala'), true);
  assert.strictEqual(codeExpired(new Date(Date.now() + 60_000).toISOString()), false);
});
