/**
 * Encryption at rest for a secret the server must read back — today, an
 * authenticator's TOTP secret (`user_totp.secret_ciphertext`). A hash cannot
 * stand in for it: checking a code needs the secret itself.
 *
 * AES-256-GCM, a fresh 96-bit IV per seal, and the row's identity as
 * additional authenticated data (`context`, e.g. `totp|<userId>`), so a
 * ciphertext copied onto another account's row does not open.
 *
 * The key is DERIVED, not configured: HKDF-SHA256 over `DEVICE_ID_SALT` — the
 * server secret `config/env.ts` already requires in production (≥ 32
 * characters, fail-fast at boot) — with its own info label, so it shares no
 * output with any other use of that secret. No new variable has to be set
 * before a deploy, and a database dump alone never opens a ciphertext.
 *
 * The sealed form names its key version (`v1.`), so a dedicated key can be
 * introduced later next to this one and rows re-sealed on use.
 */
import crypto from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_INFO = 'oxy/secret-box/v1';

let cachedKey: { salt: string; key: Buffer } | null = null;

function key(): Buffer {
  const salt = process.env.DEVICE_ID_SALT;
  if (!salt) {
    // Fail closed: an empty salt would make the key public.
    throw new Error('secretBox: DEVICE_ID_SALT is not configured');
  }
  if (cachedKey?.salt === salt) return cachedKey.key;
  const derived = Buffer.from(crypto.hkdfSync('sha256', salt, Buffer.alloc(0), KEY_INFO, 32));
  cachedKey = { salt, key: derived };
  return derived;
}

/** Encrypt `plaintext`, bound to `context`. */
export function sealSecret(plaintext: string, context: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
}

/** Decrypt what {@link sealSecret} produced for the same `context`; throws on any tampering. */
export function openSecret(sealed: string, context: string): string {
  const [version, iv, ciphertext, tag] = sealed.split('.');
  if (version !== VERSION || !iv || !ciphertext || !tag) {
    throw new Error('secretBox: unrecognised sealed value');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
