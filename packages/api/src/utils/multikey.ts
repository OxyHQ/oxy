/**
 * `Multikey` encoding for secp256k1 public keys (the atproto / W3C `did:key`
 * form).
 *
 * AtProto verification methods are `Multikey`: `publicKeyMultibase` is the
 * multibase-`base58btc` (leading `z`) encoding of the multicodec-prefixed,
 * COMPRESSED public key. For secp256k1 the multicodec prefix is the unsigned
 * varint of `0xe7` — the two bytes `0xe7 0x01`.
 *
 *   multikey = 'z' + base58btc( 0xe7 0x01 || compressedPubKey(33 bytes) )
 *
 * Oxy stores secp256k1 public keys as UNCOMPRESSED hex (the `04 || X || Y`,
 * 65-byte form used by Oxy); this module re-derives the 33-byte compressed
 * point from it. The shared protocol primitive does the point math;
 * `base58btc` is implemented inline (the standard Bitcoin
 * alphabet) to avoid pulling a multiformats dependency for ~20 lines.
 */

import { normalizeSecp256k1PublicKey } from '@oxyhq/protocol/secp256k1';

/** The Bitcoin/IPFS base58btc alphabet. */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Unsigned-varint multicodec prefix for secp256k1 public keys (`0xe7`). */
const SECP256K1_MULTICODEC_PREFIX = Uint8Array.from([0xe7, 0x01]);

/** Multibase prefix for `base58btc`. */
const MULTIBASE_BASE58BTC_PREFIX = 'z';

/**
 * Encode bytes as base58btc (no multibase prefix). Uses the canonical Bitcoin
 * base-256 → base-58 long division over a digit buffer (no `BigInt`, so it is
 * independent of the compile target). Leading zero bytes map to leading `'1'`s.
 */
function base58btcEncode(bytes: Uint8Array): string {
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) {
        zeros++;
    }

    // Repeated division of the big-endian byte array by 58, collecting remainders.
    // `digits` holds the base-58 result least-significant first.
    const digits: number[] = [];
    for (let i = zeros; i < bytes.length; i++) {
        let carry = bytes[i];
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] << 8;
            digits[j] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }

    let out = BASE58_ALPHABET[0].repeat(zeros);
    for (let i = digits.length - 1; i >= 0; i--) {
        out += BASE58_ALPHABET[digits[i]];
    }
    return out;
}

/**
 * Compress a SEC1-encoded secp256k1 public key (hex) to its 33-byte
 * compressed form. Accepts the uncompressed (`04…`, 65-byte) form Oxy stores as
 * well as an already-compressed key. Throws when the input is not a valid
 * secp256k1 point.
 */
function compressSecp256k1PublicKey(publicKeyHex: string): Uint8Array {
    return Uint8Array.from(
        Buffer.from(normalizeSecp256k1PublicKey(publicKeyHex, true), 'hex'),
    );
}

/**
 * Encode a secp256k1 public key (hex) as an atproto `Multikey`
 * (`publicKeyMultibase`): `z` + base58btc(`0xe7 0x01` || compressedPubKey).
 *
 * @param publicKeyHex - secp256k1 public key in hex (uncompressed or compressed).
 * @returns the multibase `publicKeyMultibase` string (leading `z`).
 * @throws when `publicKeyHex` is not a valid secp256k1 public key.
 */
export function secp256k1PublicKeyToMultikey(publicKeyHex: string): string {
    const compressed = compressSecp256k1PublicKey(publicKeyHex);
    const prefixed = new Uint8Array(SECP256K1_MULTICODEC_PREFIX.length + compressed.length);
    prefixed.set(SECP256K1_MULTICODEC_PREFIX, 0);
    prefixed.set(compressed, SECP256K1_MULTICODEC_PREFIX.length);
    return MULTIBASE_BASE58BTC_PREFIX + base58btcEncode(prefixed);
}
