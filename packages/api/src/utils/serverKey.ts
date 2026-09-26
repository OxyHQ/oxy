/**
 * Keys derived from the server secret, for the HMACs and the sealed box of
 * signing in with an email code or link, a password and an authenticator.
 *
 * One secret — `DEVICE_ID_SALT`, which `config/env.ts` requires in production
 * (≥ 32 characters, never the development placeholder, fail-fast at boot) —
 * and one HKDF-SHA256 derivation per use, each under its own label, so no two
 * uses ever share key material and no new variable has to be configured.
 *
 * Every function here FAILS CLOSED: with the secret missing it throws rather
 * than keying an HMAC with the empty string, which would make every stored
 * hash attacker-computable.
 */
import crypto from 'node:crypto';

const cache = new Map<string, { secret: string; key: Buffer }>();

/** The server secret, or a throw. */
function serverSecret(): string {
  const secret = process.env.DEVICE_ID_SALT;
  if (!secret) {
    throw new Error('Server key material (DEVICE_ID_SALT) is not configured');
  }
  return secret;
}

/** A 32-byte key for `label`, derived from the server secret. */
export function derivedServerKey(label: string): Buffer {
  const secret = serverSecret();
  const cached = cache.get(label);
  if (cached?.secret === secret) return cached.key;
  const key = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), label, 32));
  cache.set(label, { secret, key });
  return key;
}

/** HMAC-SHA256 hex of `message` under the key derived for `label`. */
export function serverHmacHex(label: string, message: string): string {
  return crypto.createHmac('sha256', derivedServerKey(label)).update(message).digest('hex');
}

/** The labels in use — one per purpose, never shared. */
export const SERVER_KEY_LABELS = {
  secretBox: 'oxy/secret-box/v1',
  emailCode: 'oxy/email-code/v1',
  totpBackupCode: 'oxy/totp-backup-code/v1',
  lockoutIdentifier: 'oxy/lockout-identifier/v1',
  mailBudget: 'oxy/mail-budget/v1',
} as const;
