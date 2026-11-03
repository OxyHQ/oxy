/**
 * Key Derivation Function (HKDF-SHA256)
 *
 * Pure-JS/TS HKDF via `@noble/hashes` — identical behaviour on web, Node, and
 * React Native with zero WebCrypto / native-module dependency. Used to derive
 * fixed-length symmetric keys from higher-entropy input keying material (an
 * ECDH shared secret, a recovery-phrase seed, etc.) for the Commons encrypted
 * backup and device-to-device transfer flows.
 *
 * ESM/CJS safe: static `import` only, no `require()`.
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Derive `length` bytes of keying material from `ikm` using HKDF-SHA256
 * (RFC 5869 — extract-then-expand).
 *
 * @param ikm    Input keying material (the raw secret; NOT necessarily uniform).
 * @param salt   Non-secret random salt. An empty array is treated by HKDF as a
 *               zero-filled salt of the hash length — pass a real salt whenever
 *               one is available so derivations for different contexts diverge.
 * @param info   Context/application-binding string ("what is this key for").
 *               Distinct `info` values yield independent keys from the same ikm.
 * @param length Number of output bytes. Must be in (0, 255 * 32].
 * @returns      Exactly `length` bytes of derived keying material.
 */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error('hkdfSha256: length must be a positive integer');
  }
  // HKDF-Expand is defined for at most 255 * HashLen bytes of output.
  if (length > 255 * 32) {
    throw new Error('hkdfSha256: length must not exceed 8160 bytes (255 * 32)');
  }
  return hkdf(sha256, ikm, salt, info, length);
}
