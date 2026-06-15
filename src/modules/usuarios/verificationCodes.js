const crypto = require('crypto');

const MISSING_SCHEMA_CODES = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);
const PURPOSES = new Set(['phone_verification', 'password_reset']);
const DEFAULT_MAX_ATTEMPTS = 5;

function isMissingSchemaError(error) {
  return Boolean(error && MISSING_SCHEMA_CODES.has(error.code));
}

function normalizePurpose(purpose) {
  const value = String(purpose || '').trim().toLowerCase();
  if (!PURPOSES.has(value)) throw new Error(`verification purpose invalido: ${value}`);
  return value;
}

function getVerificationPepper() {
  return (
    process.env.VERIFICATION_CODE_PEPPER ||
    process.env.JWT_SECRET ||
    process.env.CRON_TOKEN ||
    'ruralicos-local-verification-pepper'
  );
}

function hashVerificationCode({ code, purpose, phone }) {
  const normalizedPurpose = normalizePurpose(purpose);
  const normalizedCode = String(code || '').trim();
  const normalizedPhone = String(phone || '').trim();

  return crypto
    .createHash('sha256')
    .update([getVerificationPepper(), normalizedPurpose, normalizedPhone, normalizedCode].join('|'))
    .digest('hex');
}

function codeExpired(expiresAt, now = new Date()) {
  if (!expiresAt) return true;
  const expires = new Date(expiresAt);
  return Number.isNaN(expires.getTime()) || expires <= now;
}

function legacyCodeMatches(user, code, now = new Date()) {
  if (!user) return false;
  const storedCode = String(user.phone_verification_code || '').trim();
  const receivedCode = String(code || '').trim();
  if (!storedCode || storedCode !== receivedCode) return false;
  return !codeExpired(user.phone_verification_expires_at, now);
}

async function markPreviousCodesConsumed(supabase, { userId, purpose }) {
  const normalizedPurpose = normalizePurpose(purpose);
  const { error } = await supabase
    .from('verification_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('purpose', normalizedPurpose)
    .is('consumed_at', null);

  if (error && isMissingSchemaError(error)) return { ok: true, available: false };
  if (error) throw error;
  return { ok: true, available: true };
}

async function storeVerificationCode(supabase, { userId, phone, purpose, code, expiresAt }) {
  const normalizedPurpose = normalizePurpose(purpose);
  const previous = await markPreviousCodesConsumed(supabase, { userId, purpose: normalizedPurpose });
  if (previous.available === false) return previous;

  const row = {
    user_id: userId,
    phone,
    purpose: normalizedPurpose,
    code_hash: hashVerificationCode({ code, purpose: normalizedPurpose, phone }),
    expires_at: expiresAt,
    attempts: 0,
  };

  const { error } = await supabase.from('verification_codes').insert([row]);
  if (error && isMissingSchemaError(error)) return { ok: true, available: false };
  if (error) throw error;
  return { ok: true, available: true };
}

async function storeVerificationCodeOrLegacy(supabase, options = {}) {
  const {
    userId,
    phone,
    purpose,
    code,
    expiresAt,
    markPhoneUnverified = false,
  } = options;

  const stored = await storeVerificationCode(supabase, { userId, phone, purpose, code, expiresAt });
  const userPatch = stored.available === false
    ? {
      ...(markPhoneUnverified ? { phone_verified: false } : {}),
      phone_verification_code: code,
      phone_verification_expires_at: expiresAt,
    }
    : {
      ...(markPhoneUnverified ? { phone_verified: false } : {}),
      phone_verification_code: null,
      phone_verification_expires_at: null,
    };

  const { error } = await supabase
    .from('users')
    .update(userPatch)
    .eq('id', userId);

  if (error) throw error;

  return {
    ok: true,
    available: stored.available !== false,
    fallback: stored.available === false ? 'users_legacy_columns' : null,
  };
}

async function incrementAttempts(supabase, row, attempts) {
  const patch = { attempts };
  if (attempts >= DEFAULT_MAX_ATTEMPTS) {
    patch.consumed_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('verification_codes')
    .update(patch)
    .eq('id', row.id);

  if (error && !isMissingSchemaError(error)) throw error;
}

async function verifyStoredCode(supabase, { userId, phone, purpose, code, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
  const normalizedPurpose = normalizePurpose(purpose);
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from('verification_codes')
    .select('id, code_hash, attempts, expires_at, consumed_at')
    .eq('user_id', userId)
    .eq('purpose', normalizedPurpose)
    .is('consumed_at', null)
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error && isMissingSchemaError(error)) return { ok: false, available: false };
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, available: true, reason: 'invalid_or_expired' };

  const attempts = Number(row.attempts || 0);
  if (attempts >= maxAttempts) {
    return { ok: false, available: true, reason: 'too_many_attempts' };
  }

  const expectedHash = hashVerificationCode({ code, purpose: normalizedPurpose, phone });
  if (row.code_hash !== expectedHash) {
    await incrementAttempts(supabase, row, attempts + 1);
    return { ok: false, available: true, reason: 'invalid_or_expired' };
  }

  const { error: consumeError } = await supabase
    .from('verification_codes')
    .update({
      consumed_at: new Date().toISOString(),
      attempts: attempts + 1,
    })
    .eq('id', row.id);

  if (consumeError && !isMissingSchemaError(consumeError)) throw consumeError;

  return { ok: true, available: true };
}

async function verifyStoredCodeOrLegacy(supabase, { user, phone, purpose, code }) {
  const verified = await verifyStoredCode(supabase, {
    userId: user?.id,
    phone,
    purpose,
    code,
  });

  if (verified.ok) return verified;

  if (
    (verified.available === false || verified.reason === 'invalid_or_expired') &&
    legacyCodeMatches(user, code)
  ) {
    return { ok: true, available: verified.available !== false, fallback: 'users_legacy_columns' };
  }

  return verified;
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  hashVerificationCode,
  legacyCodeMatches,
  codeExpired,
  storeVerificationCode,
  storeVerificationCodeOrLegacy,
  verifyStoredCode,
  verifyStoredCodeOrLegacy,
  isMissingSchemaError,
  normalizePurpose,
};
