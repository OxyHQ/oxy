/**
 * Seal: public-key encryption to an X25519 key (ADR 0063 D8), the construction
 * of age's X25519 recipient.
 *
 *   (e, E)  an ephemeral X25519 pair
 *   shared  = X25519(e, R), refused if all zero
 *   key     = HKDF-SHA256(ikm = shared, salt = E ‖ R, info = "oxy.keychain.seal.v1", 32)
 *   ct      = XChaCha20-Poly1305(key, random 24-byte nonce, plaintext, aad)
 *
 * Sent as `{ epk: E, nonce, ciphertext }`, each base64url.
 */

import '../polyfill';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdfSha256 } from '../kdf';
import { KEY_LENGTH, NONCE_LENGTH, SEAL_INFO } from './constants';
import { concatBytes, fromBase64Url, randomBytes, toBase64Url, utf8, zeroize } from './encoding';
import { KeychainCryptoError } from './errors';
import { x25519PublicKey, x25519SharedSecret } from './keys';

/** A sealed box on the wire. */
export interface SealedBox {
  /** The ephemeral public key `E`, base64url. */
  epk: string;
  /** The 24-byte nonce, base64url. */
  nonce: string;
  /** Ciphertext with the 16-byte Poly1305 tag appended, base64url. */
  ciphertext: string;
}

const SEAL_INFO_BYTES = utf8(SEAL_INFO);

function sealKey(shared: Uint8Array, epk: Uint8Array, recipient: Uint8Array): Uint8Array {
  const salt = concatBytes(epk, recipient);
  return hkdfSha256(shared, salt, SEAL_INFO_BYTES, KEY_LENGTH);
}

/**
 * Seal with a given ephemeral secret and nonce. Deterministic, for the test
 * vectors only: reusing an ephemeral key or nonce breaks the construction.
 * Not exported from the public barrel.
 */
export function sealDeterministic(
  recipientBoxKey: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
  ephemeralSecretKey: Uint8Array,
  nonce: Uint8Array,
): SealedBox {
  if (recipientBoxKey.length !== KEY_LENGTH)
    throw new KeychainCryptoError('box key must be 32 bytes');
  if (ephemeralSecretKey.length !== KEY_LENGTH || nonce.length !== NONCE_LENGTH) {
    throw new KeychainCryptoError('ephemeral key must be 32 bytes and nonce 24');
  }
  const epk = x25519PublicKey(ephemeralSecretKey);
  const shared = x25519SharedSecret(ephemeralSecretKey, recipientBoxKey);
  const key = sealKey(shared, epk, recipientBoxKey);
  try {
    const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
    return {
      epk: toBase64Url(epk),
      nonce: toBase64Url(nonce),
      ciphertext: toBase64Url(ciphertext),
    };
  } finally {
    zeroize(shared, key);
  }
}

/** Seal `plaintext` to the X25519 public key `recipientBoxKey`, authenticating `aad`. */
export function seal(
  recipientBoxKey: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): SealedBox {
  const ephemeral = randomBytes(KEY_LENGTH);
  try {
    return sealDeterministic(recipientBoxKey, plaintext, aad, ephemeral, randomBytes(NONCE_LENGTH));
  } finally {
    zeroize(ephemeral);
  }
}

/**
 * Open a sealed box with the recipient's X25519 secret key. Throws
 * `KeychainCryptoError` when the box, the key or the `aad` do not match.
 */
export function openSealed(
  recipientBoxSecretKey: Uint8Array,
  box: SealedBox,
  aad: Uint8Array,
): Uint8Array {
  const epk = fromBase64Url(box.epk, KEY_LENGTH, 'epk');
  const nonce = fromBase64Url(box.nonce, NONCE_LENGTH, 'nonce');
  const ciphertext = fromBase64Url(box.ciphertext, undefined, 'ciphertext');
  const recipient = x25519PublicKey(recipientBoxSecretKey);
  const shared = x25519SharedSecret(recipientBoxSecretKey, epk);
  const key = sealKey(shared, epk, recipient);
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch {
    throw new KeychainCryptoError('sealed box does not open');
  } finally {
    zeroize(shared, key);
  }
}
