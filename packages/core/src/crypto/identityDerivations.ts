/**
 * What can be computed FROM the identity private key without handing it out.
 *
 * Pure functions over a private key. On the device that holds the key they run
 * here (`KeyManager`); on Android, where only Commons holds it, Commons runs the
 * same computations natively (`modules/oxy-identity-host` in Commons) and
 * answers over IPC. The two implementations must agree byte for byte:
 * `packages/commons/modules/oxy-identity-host/vectors.json` pins them, and
 * both this package's tests and the Commons Kotlin unit test check it.
 *
 * ESM/CJS safe: static `import` only, no `require()`.
 */

import { hmac } from '@noble/hashes/hmac';
import { sha256, sha512 } from '@noble/hashes/sha2';
import {
  deriveSecp256k1PublicKey,
  normalizeSecp256k1PrivateKey,
  signSecp256k1Digest,
  tweakAddSecp256k1PrivateKey,
} from '@oxy.so/protocol/secp256k1';
import { hkdfSha256 } from './kdf';

/**
 * HKDF salt that domain-separates every identity-scoped seed. Versioned so a
 * future scheme change is a new, non-colliding tag. The per-app domain (e.g.
 * Peable's FairCoin wallet, `peable/faircoin/v1`) is the caller's `info`.
 */
export const SCOPED_SEED_KDF_SALT = 'oxy-identity-scoped-seed-v1';

/**
 * HMAC key of the social-receive chain code. Byte-identical to
 * `SOCIAL_RECEIVE_CHAIN_CODE_KEY` in `@fairco.in/core`'s `social-receive`
 * (payers derive the same addresses from the public key alone), so it keeps
 * its historical `oxypay/` spelling: renaming it moves every address.
 */
export const SOCIAL_RECEIVE_CHAIN_CODE_KEY = 'oxypay/faircoin/social/v1';

/** Highest non-hardened BIP32 index. */
export const MAX_SOCIAL_RECEIVE_INDEX = 0x7fffffff;

const DIGEST_HEX = /^[0-9a-f]{64}$/;

function utf8(label: string): Uint8Array {
  return new TextEncoder().encode(label);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 32 bytes of HKDF-SHA256 keying material bound to `info`:
 * `HKDF(ikm = privateKey (32 bytes), salt = SCOPED_SEED_KDF_SALT, info, L = 32)`.
 * Distinct `info` labels give independent seeds; the output never reveals the key.
 */
export function deriveScopedSeedFromKey(privateKeyHex: string, info: string): Uint8Array {
  const ikm = hexToBytes(normalizeSecp256k1PrivateKey(privateKeyHex));
  return hkdfSha256(ikm, utf8(SCOPED_SEED_KDF_SALT), utf8(info), 32);
}

/**
 * The spending key of social-receive child `index`: the non-hardened BIP32
 * child (`CKDpriv`) of the identity key under the chain code
 * `HMAC-SHA256(SOCIAL_RECEIVE_CHAIN_CODE_KEY, compressed identity public key)`.
 * Identical to `@fairco.in/core`'s `deriveSocialReceiveSpendingKey`.
 *
 * @returns the child private key and its compressed public key, lowercase hex.
 */
export function deriveSocialReceiveKey(
  privateKeyHex: string,
  index: number,
): { privateKey: string; publicKey: string } {
  if (!Number.isInteger(index) || index < 0 || index > MAX_SOCIAL_RECEIVE_INDEX) {
    throw new Error(`social-receive: index must be an integer in [0, ${MAX_SOCIAL_RECEIVE_INDEX}]`);
  }
  const privateKey = normalizeSecp256k1PrivateKey(privateKeyHex);
  const parentPublic = hexToBytes(deriveSecp256k1PublicKey(privateKey, true));
  const chainCode = hmac(sha256, utf8(SOCIAL_RECEIVE_CHAIN_CODE_KEY), parentPublic);
  const data = new Uint8Array(37);
  data.set(parentPublic, 0);
  new DataView(data.buffer).setUint32(33, index, false);
  const i = hmac(sha512, chainCode, data);
  const childPrivate = tweakAddSecp256k1PrivateKey(privateKey, bytesToHex(i.slice(0, 32)));
  return { privateKey: childPrivate, publicKey: deriveSecp256k1PublicKey(childPrivate, true) };
}

/**
 * Sign a 32-byte digest (a transaction sighash) with social-receive child
 * `index`: RFC 6979, low-S (BIP 62), DER hex.
 */
export function signSocialReceiveDigest(
  privateKeyHex: string,
  index: number,
  digestHex: string,
): { signature: string; publicKey: string } {
  if (!DIGEST_HEX.test(digestHex)) {
    throw new Error('social-receive: digest must be 32 bytes of lowercase hex');
  }
  const child = deriveSocialReceiveKey(privateKeyHex, index);
  return {
    signature: signSecp256k1Digest(child.privateKey, digestHex, { lowS: true }),
    publicKey: child.publicKey,
  };
}

/**
 * The digest a server challenge proof signs:
 * `sha256("auth:${publicKey}:${challenge}:${timestamp}")`, hex. The message
 * format is the one `POST /auth/verify` checks, unchanged.
 */
export function authChallengeDigest(publicKey: string, challenge: string, timestamp: number): string {
  return bytesToHex(sha256(utf8(`auth:${publicKey}:${challenge}:${timestamp}`)));
}
