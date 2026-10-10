/**
 * Authenticated Encryption with Associated Data (XChaCha20-Poly1305)
 *
 * Pure-JS/TS AEAD via `@noble/ciphers` — identical behaviour on web, Node, and
 * React Native with zero WebCrypto / native-module dependency. This replaces
 * the `crypto.subtle`-based path (unreliable on React Native) for the Commons
 * encrypted backup and device-to-device transfer flows.
 *
 * XChaCha20-Poly1305 is chosen over AES-GCM specifically for its 24-byte
 * (192-bit) random nonce: the nonce space is large enough that random nonces
 * never collide in practice, so callers do not need to maintain a per-key
 * counter. The 16-byte Poly1305 tag is appended to the ciphertext by the
 * underlying library and validated on decrypt.
 *
 * The optional Associated Data (AAD) is authenticated but NOT encrypted: it
 * binds the ciphertext to its context (e.g. a backup version, a device id, a
 * DID). Decryption fails if the key, nonce, ciphertext, OR aad differ from
 * those used at encryption time.
 *
 * ESM/CJS safe: static `import` only, no `require()`.
 */

// Loading the polyfill guarantees `globalThis.crypto.getRandomValues` exists on
// every platform (native crypto on web/Node; expo-crypto-backed shim on RN).
import './polyfill';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';

/** Key length for XChaCha20-Poly1305, in bytes (256-bit). */
export const AEAD_KEY_LENGTH = 32;
/** Nonce length for XChaCha20-Poly1305, in bytes (192-bit). */
export const AEAD_NONCE_LENGTH = 24;

/** Ciphertext (Poly1305 tag appended) plus the random nonce used to produce it. */
export interface AeadResult {
  /** The 24-byte random nonce. Store/transmit alongside the ciphertext. */
  nonce: Uint8Array;
  /** Ciphertext with the 16-byte Poly1305 authentication tag appended. */
  ciphertext: Uint8Array;
}

function assertKey(key: Uint8Array): void {
  if (key.length !== AEAD_KEY_LENGTH) {
    throw new Error(`AEAD key must be ${AEAD_KEY_LENGTH} bytes, got ${key.length}`);
  }
}

/** Generate a fresh 24-byte random nonce via the platform CSPRNG. */
function randomNonce(): Uint8Array {
  const nonce = new Uint8Array(AEAD_NONCE_LENGTH);
  globalThis.crypto.getRandomValues(nonce);
  return nonce;
}

/**
 * Encrypt `plaintext` under `key` with a fresh random nonce, authenticating the
 * optional `aad`.
 *
 * @param key       32-byte symmetric key (e.g. from `hkdfSha256`).
 * @param plaintext Bytes to encrypt.
 * @param aad       Optional associated data authenticated but not encrypted.
 * @returns         `{ nonce, ciphertext }` — both are required to decrypt.
 */
export function encryptAead(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): AeadResult {
  assertKey(key);
  const nonce = randomNonce();
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  return { nonce, ciphertext };
}

/**
 * Decrypt and authenticate `ciphertext` produced by {@link encryptAead}.
 *
 * Throws if the key, nonce, ciphertext, or aad differ from those used at
 * encryption time (tamper detection), or if the tag is invalid.
 *
 * @param key        32-byte symmetric key.
 * @param nonce      The 24-byte nonce returned by `encryptAead`.
 * @param ciphertext Ciphertext with the appended Poly1305 tag.
 * @param aad        The same associated data supplied at encryption time.
 * @returns          The recovered plaintext bytes.
 */
export function decryptAead(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  assertKey(key);
  if (nonce.length !== AEAD_NONCE_LENGTH) {
    throw new Error(`AEAD nonce must be ${AEAD_NONCE_LENGTH} bytes, got ${nonce.length}`);
  }
  return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
}
