/**
 * Unit tests for the secp256k1 → `Multikey` encoder.
 *
 * Verifies the atproto/W3C `did:key` properties WITHOUT a hardcoded vector: the
 * output round-trips through a base58btc decoder to the exact multicodec prefix +
 * compressed public key. secp256k1 Multikeys are always the `zQ3sh…` family, so
 * that prefix is asserted too. Accepting both the uncompressed (stored) and the
 * compressed key forms is checked for stability.
 */

import {
  generateSecp256k1KeyPair,
  normalizeSecp256k1PublicKey,
} from '@oxyhq/protocol/secp256k1';
import { secp256k1PublicKeyToMultikey } from '../multikey';


/** Standard base58btc decode (Bitcoin alphabet) — inverse of the encoder. */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58btcDecode(str: string): Uint8Array {
  const digits: number[] = [];
  let zeros = 0;
  while (zeros < str.length && str[zeros] === BASE58_ALPHABET[0]) zeros++;
  for (let i = zeros; i < str.length; i++) {
    let carry = BASE58_ALPHABET.indexOf(str[i]);
    if (carry < 0) throw new Error(`invalid base58 char: ${str[i]}`);
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 58;
      digits[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + digits.length);
  for (let i = 0; i < digits.length; i++) out[zeros + digits.length - 1 - i] = digits[i];
  return out;
}

describe('secp256k1PublicKeyToMultikey', () => {
  it('encodes the multicodec-prefixed compressed key as a zQ3sh… multibase string', () => {
    const kp = generateSecp256k1KeyPair();
    const uncompressed = kp.publicKey;
    const compressed = normalizeSecp256k1PublicKey(kp.publicKey, true);

    const multikey = secp256k1PublicKeyToMultikey(uncompressed);

    // Multibase base58btc prefix, secp256k1 did:key family.
    expect(multikey.startsWith('z')).toBe(true);
    expect(multikey.startsWith('zQ3sh')).toBe(true);

    const decoded = base58btcDecode(multikey.slice(1));
    // secp256k1 multicodec varint (0xe7 0x01) + 33-byte compressed key.
    expect(decoded.length).toBe(35);
    expect(decoded[0]).toBe(0xe7);
    expect(decoded[1]).toBe(0x01);
    expect(Buffer.from(decoded.slice(2)).toString('hex')).toBe(compressed);
  });

  it('is stable across the uncompressed and compressed input forms', () => {
    const kp = generateSecp256k1KeyPair();
    const uncompressed = kp.publicKey;
    const compressed = normalizeSecp256k1PublicKey(kp.publicKey, true);

    expect(secp256k1PublicKeyToMultikey(uncompressed)).toBe(
      secp256k1PublicKeyToMultikey(compressed),
    );
  });

  it('is deterministic for the same key', () => {
    const publicKey = generateSecp256k1KeyPair().publicKey;
    expect(secp256k1PublicKeyToMultikey(publicKey)).toBe(secp256k1PublicKeyToMultikey(publicKey));
  });

  it('throws on an invalid secp256k1 public key', () => {
    expect(() => secp256k1PublicKeyToMultikey('deadbeef')).toThrow();
  });
});
