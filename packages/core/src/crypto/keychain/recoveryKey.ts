/**
 * The recovery key (ADR 0063 D2, D6, D8): 20 random bytes, shown once as 32
 * Crockford base32 characters in eight groups of four
 * (`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`), and the Ed25519 / X25519 keys
 * derived from it:
 *
 *   seed_s = HKDF-SHA256(ikm = recoveryKey, salt = "oxy.keychain.recovery.v1", info = "ed25519", 32)
 *   seed_b = HKDF-SHA256(ikm = recoveryKey, salt = "oxy.keychain.recovery.v1", info = "x25519", 32)
 *
 * 32 characters carry exactly 160 bits, so there is no room for a checksum: a
 * mistyped key is caught because its derived public keys are not the roster's
 * (`recoveryKeyMatches`).
 */

import { hkdfSha256 } from '../kdf';
import {
  KEY_LENGTH,
  RECOVERY_BOX_INFO,
  RECOVERY_KEY_LENGTH,
  RECOVERY_SALT,
  RECOVERY_SIGNING_INFO,
} from './constants';
import { bytesEqual, fromBase64Url, randomBytes, utf8 } from './encoding';
import { KeychainFormatError } from './errors';
import { deviceKeysFromSecrets, type KeychainKeyPairs, type KeychainPublicKeys } from './keys';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_TEXT_LENGTH = 32;

/** 20 fresh random bytes. The caller zeroizes them once shown and confirmed. */
export function generateRecoveryKey(): Uint8Array {
  return randomBytes(RECOVERY_KEY_LENGTH);
}

/** The recovery key as people see it: eight groups of four, upper case, hyphens. */
export function formatRecoveryKey(recoveryKey: Uint8Array): string {
  if (recoveryKey.length !== RECOVERY_KEY_LENGTH) {
    throw new KeychainFormatError('a recovery key is 20 bytes');
  }
  let chars = '';
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < recoveryKey.length; i += 1) {
    acc = ((acc << 8) | recoveryKey[i]) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      chars += CROCKFORD[(acc >> bits) & 0x1f];
    }
  }
  // 160 bits: no bits are left over.
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += 4) groups.push(chars.slice(i, i + 4));
  return groups.join('-');
}

/**
 * Read a typed recovery key. Ignores case, hyphens and whitespace (space, tab,
 * CR, LF); reads `I`/`L` as 1 and `O` as 0. Refuses any other character and
 * any length but 32 characters. Returns the 20 bytes (the caller zeroizes).
 */
export function parseRecoveryKey(text: string): Uint8Array {
  if (typeof text !== 'string') throw new KeychainFormatError('recovery key must be text');
  let normalized = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '-' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    // ASCII only: a non-ASCII letter must not upper-case into one (`ı` → `I`).
    if (ch.charCodeAt(0) > 0x7f) {
      throw new KeychainFormatError('recovery key holds a character that is not in it');
    }
    let up = ch.toUpperCase();
    if (up === 'I' || up === 'L') up = '1';
    else if (up === 'O') up = '0';
    if (CROCKFORD.indexOf(up) < 0) {
      throw new KeychainFormatError('recovery key holds a character that is not in it');
    }
    normalized += up;
  }
  if (normalized.length !== RECOVERY_TEXT_LENGTH) {
    throw new KeychainFormatError('a recovery key is 32 characters');
  }
  const out = new Uint8Array(RECOVERY_KEY_LENGTH);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    acc = ((acc << 5) | CROCKFORD.indexOf(normalized[i])) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (acc >> bits) & 0xff;
      o += 1;
    }
  }
  return out;
}

const RECOVERY_SALT_BYTES = utf8(RECOVERY_SALT);

/**
 * The recovery signing (Ed25519) and box (X25519) keys of a recovery key.
 * The secrets are the caller's to zeroize (`zeroizeKeyPairs`).
 */
export function deriveRecoveryKeys(recoveryKey: Uint8Array): KeychainKeyPairs {
  if (recoveryKey.length !== RECOVERY_KEY_LENGTH) {
    throw new KeychainFormatError('a recovery key is 20 bytes');
  }
  const signingSeed = hkdfSha256(
    recoveryKey,
    RECOVERY_SALT_BYTES,
    utf8(RECOVERY_SIGNING_INFO),
    KEY_LENGTH,
  );
  const boxSeed = hkdfSha256(recoveryKey, RECOVERY_SALT_BYTES, utf8(RECOVERY_BOX_INFO), KEY_LENGTH);
  return deviceKeysFromSecrets(signingSeed, boxSeed);
}

/**
 * Whether `keys` (derived from a typed recovery key) are the roster's current
 * recovery keys: how a mistyped recovery key is told apart before anything is
 * tried with it.
 */
export function recoveryKeyMatches(keys: KeychainKeyPairs, recovery: KeychainPublicKeys): boolean {
  return (
    bytesEqual(keys.signingPublicKey, fromBase64Url(recovery.signingKey, KEY_LENGTH)) &&
    bytesEqual(keys.boxPublicKey, fromBase64Url(recovery.boxKey, KEY_LENGTH))
  );
}
