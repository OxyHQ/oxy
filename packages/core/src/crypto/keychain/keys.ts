/**
 * A device's keychain keys (ADR 0063 D2): an Ed25519 signing key and an X25519
 * box key, both made on the device from the platform CSPRNG and never
 * exported. Only their public halves enter the roster.
 *
 * Signatures are verified the RFC 8032 strict way (canonical encodings, a
 * small-order public key refused): `@noble/curves` with `zip215: false`, as
 * `ed25519-dalek`'s `verify_strict` on OxyOS.
 */

import '../polyfill';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { KEY_LENGTH, SIGNATURE_LENGTH } from './constants';
import { fromBase64Url, randomBytes, toBase64Url } from './encoding';
import { KeychainCryptoError, KeychainFormatError } from './errors';

/** A device's (or the recovery key's) four keys. The secrets are the caller's to zeroize. */
export interface KeychainKeyPairs {
  /** Ed25519 secret key (the 32-byte RFC 8032 seed). */
  signingSecretKey: Uint8Array;
  /** Ed25519 public key, 32 bytes. */
  signingPublicKey: Uint8Array;
  /** X25519 secret key, 32 bytes (clamped by X25519 itself). */
  boxSecretKey: Uint8Array;
  /** X25519 public key, 32 bytes. */
  boxPublicKey: Uint8Array;
}

/** The public halves as they appear in the roster: base64url. */
export interface KeychainPublicKeys {
  signingKey: string;
  boxKey: string;
}

/** Make a new device's keys from the platform CSPRNG. */
export function generateDeviceKeys(): KeychainKeyPairs {
  return deviceKeysFromSecrets(randomBytes(KEY_LENGTH), randomBytes(KEY_LENGTH));
}

/**
 * Rebuild the key pairs from the two stored secret keys. The returned object
 * holds the very buffers passed in, so zeroizing it zeroizes them.
 */
export function deviceKeysFromSecrets(
  signingSecretKey: Uint8Array,
  boxSecretKey: Uint8Array,
): KeychainKeyPairs {
  if (signingSecretKey.length !== KEY_LENGTH || boxSecretKey.length !== KEY_LENGTH) {
    throw new KeychainFormatError('secret keys must be 32 bytes');
  }
  return {
    signingSecretKey,
    signingPublicKey: ed25519.getPublicKey(signingSecretKey),
    boxSecretKey,
    boxPublicKey: x25519.getPublicKey(boxSecretKey),
  };
}

/** The public halves, base64url, for a roster `member` or `recovery` object. */
export function exportPublicKeys(keys: {
  signingPublicKey: Uint8Array;
  boxPublicKey: Uint8Array;
}): KeychainPublicKeys {
  return {
    signingKey: toBase64Url(keys.signingPublicKey),
    boxKey: toBase64Url(keys.boxPublicKey),
  };
}

/** Overwrite both secret keys with zeros. */
export function zeroizeKeyPairs(keys: KeychainKeyPairs): void {
  keys.signingSecretKey.fill(0);
  keys.boxSecretKey.fill(0);
}

/** Ed25519 signature (RFC 8032, deterministic). */
export function signBytes(signingSecretKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, signingSecretKey);
}

/** Strict Ed25519 verification; never throws on a malformed signature or key. */
export function verifyBytes(
  signingPublicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (signature.length !== SIGNATURE_LENGTH || signingPublicKey.length !== KEY_LENGTH) return false;
  try {
    return ed25519.verify(signature, message, signingPublicKey, { zip215: false });
  } catch {
    return false;
  }
}

/**
 * Decode a roster signing key: 32 bytes, a canonical encoding of a curve point
 * that is not of small order (a key no strict verifier would ever accept).
 */
export function decodeSigningKey(text: string, what = 'signingKey'): Uint8Array {
  const bytes = fromBase64Url(text, KEY_LENGTH, what);
  let ok = false;
  try {
    ok = !ed25519.Point.fromBytes(bytes, false).isSmallOrder();
  } catch {
    ok = false;
  }
  if (!ok) throw new KeychainFormatError(`${what} is not a usable Ed25519 public key`);
  return bytes;
}

// Any clamped scalar shows a low-order point: X25519 of it is all zeros.
const PROBE_SCALAR = new Uint8Array(KEY_LENGTH).fill(0x55);

/**
 * Decode a roster box key: 32 bytes and not a low-order point (one whose
 * shared secret with any key is all zeros, so nothing could be sealed to it).
 */
export function decodeBoxKey(text: string, what = 'boxKey'): Uint8Array {
  const bytes = fromBase64Url(text, KEY_LENGTH, what);
  try {
    x25519SharedSecret(PROBE_SCALAR, bytes);
  } catch {
    throw new KeychainFormatError(`${what} is not a usable X25519 public key`);
  }
  return bytes;
}

/** X25519, refusing an all-zero result (a low-order public key). */
export function x25519SharedSecret(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  let shared: Uint8Array;
  try {
    // Noble refuses low-order inputs itself, before the ladder.
    shared = x25519.getSharedSecret(secretKey, publicKey);
  } catch {
    throw new KeychainCryptoError('X25519 refused a low-order public key');
  }
  let acc = 0;
  for (let i = 0; i < shared.length; i += 1) acc |= shared[i];
  if (acc === 0) {
    shared.fill(0);
    throw new KeychainCryptoError('X25519 produced an all-zero shared secret');
  }
  return shared;
}

/** X25519 public key of a secret key. */
export function x25519PublicKey(secretKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secretKey);
}

/** Ed25519 public key of a secret key (seed). */
export function ed25519PublicKey(secretKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secretKey);
}
