/**
 * b3 Phase 0 crypto primitives — HKDF-SHA256, XChaCha20-Poly1305 AEAD, and
 * secp256k1 ECDH. These are the pure, self-contained foundation for the Commons
 * encrypted-backup and device-to-device transfer flows.
 *
 * - kdf: pinned against the published RFC 5869 test vectors (TC1/TC2/TC3) so an
 *   accidental algorithm/library swap is caught as a regression.
 * - aead: round-trip plus exhaustive tamper coverage (flipped byte, wrong AAD,
 *   wrong key, wrong nonce) — every mismatch must throw.
 * - ecdh: symmetry (`derive(a,pubB) === derive(b,pubA)`), fixed 32-byte width,
 *   and compressed/uncompressed public-key parity.
 */

import {
  generateSecp256k1KeyPair,
  normalizeSecp256k1PublicKey,
} from '@oxyhq/protocol/secp256k1';
import { hkdfSha256 } from '../kdf';
import { encryptAead, decryptAead, AEAD_KEY_LENGTH, AEAD_NONCE_LENGTH } from '../aead';
import { deriveSharedSecret } from '../ecdh';

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(Buffer.from(hex.replace(/\s/g, ''), 'hex'));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const range = (start: number, end: number): Uint8Array =>
  Uint8Array.from(Array.from({ length: end - start + 1 }, (_, i) => start + i));

describe('hkdfSha256 (RFC 5869)', () => {
  // RFC 5869 Appendix A — Test Case 1 (basic, with salt & info).
  it('matches RFC 5869 Test Case 1', () => {
    const okm = hkdfSha256(
      fromHex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
      fromHex('000102030405060708090a0b0c'),
      fromHex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(toHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  // RFC 5869 Appendix A — Test Case 2 (longer inputs & output).
  it('matches RFC 5869 Test Case 2', () => {
    const okm = hkdfSha256(range(0x00, 0x4f), range(0x60, 0xaf), range(0xb0, 0xff), 82);
    expect(toHex(okm)).toBe(
      'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87',
    );
  });

  // RFC 5869 Appendix A — Test Case 3 (zero-length salt & info).
  it('matches RFC 5869 Test Case 3 (empty salt/info)', () => {
    const okm = hkdfSha256(
      fromHex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
      new Uint8Array(0),
      new Uint8Array(0),
      42,
    );
    expect(toHex(okm)).toBe(
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
    );
  });

  it('returns exactly the requested number of bytes', () => {
    const ikm = fromHex('deadbeef');
    expect(hkdfSha256(ikm, new Uint8Array(0), new Uint8Array(0), 16).length).toBe(16);
    expect(hkdfSha256(ikm, new Uint8Array(0), new Uint8Array(0), 32).length).toBe(32);
    expect(hkdfSha256(ikm, new Uint8Array(0), new Uint8Array(0), 64).length).toBe(64);
  });

  it('derives independent keys for distinct info (context binding)', () => {
    const ikm = fromHex('00112233445566778899aabbccddeeff');
    const salt = fromHex('a1b2c3d4');
    const backup = hkdfSha256(ikm, salt, new TextEncoder().encode('oxy.backup.v1'), 32);
    const transfer = hkdfSha256(ikm, salt, new TextEncoder().encode('oxy.transfer.v1'), 32);
    expect(toHex(backup)).not.toBe(toHex(transfer));
  });

  it('rejects invalid output lengths', () => {
    const ikm = fromHex('deadbeef');
    expect(() => hkdfSha256(ikm, new Uint8Array(0), new Uint8Array(0), 0)).toThrow();
    expect(() => hkdfSha256(ikm, new Uint8Array(0), new Uint8Array(0), -1)).toThrow();
    expect(() => hkdfSha256(ikm, new Uint8Array(0), new Uint8Array(0), 1.5)).toThrow();
    expect(() => hkdfSha256(ikm, new Uint8Array(0), new Uint8Array(0), 255 * 32 + 1)).toThrow();
  });
});

describe('encryptAead / decryptAead (XChaCha20-Poly1305)', () => {
  const key = hkdfSha256(fromHex('00'), new Uint8Array(0), new TextEncoder().encode('aead-test'), AEAD_KEY_LENGTH);
  const plaintext = new TextEncoder().encode('the quick brown fox jumps over the lazy dog');
  const aad = new TextEncoder().encode('oxy.backup.v1:did:web:oxy.so:u:123');

  it('round-trips without AAD', () => {
    const { nonce, ciphertext } = encryptAead(key, plaintext);
    expect(nonce.length).toBe(AEAD_NONCE_LENGTH);
    // Ciphertext = plaintext length + 16-byte Poly1305 tag.
    expect(ciphertext.length).toBe(plaintext.length + 16);
    expect(toHex(decryptAead(key, nonce, ciphertext))).toBe(toHex(plaintext));
  });

  it('round-trips with AAD', () => {
    const { nonce, ciphertext } = encryptAead(key, plaintext, aad);
    expect(toHex(decryptAead(key, nonce, ciphertext, aad))).toBe(toHex(plaintext));
  });

  it('produces a distinct random nonce on each call', () => {
    const a = encryptAead(key, plaintext);
    const b = encryptAead(key, plaintext);
    expect(toHex(a.nonce)).not.toBe(toHex(b.nonce));
    // Random nonce => distinct ciphertext even for identical plaintext+key.
    expect(toHex(a.ciphertext)).not.toBe(toHex(b.ciphertext));
  });

  it('throws when a ciphertext byte is flipped (tamper detection)', () => {
    const { nonce, ciphertext } = encryptAead(key, plaintext, aad);
    const tampered = Uint8Array.from(ciphertext);
    tampered[0] ^= 0x01;
    expect(() => decryptAead(key, nonce, tampered, aad)).toThrow();
  });

  it('throws when the authentication tag is flipped (tamper detection)', () => {
    const { nonce, ciphertext } = encryptAead(key, plaintext, aad);
    const tampered = Uint8Array.from(ciphertext);
    tampered[tampered.length - 1] ^= 0x80;
    expect(() => decryptAead(key, nonce, tampered, aad)).toThrow();
  });

  it('throws when AAD does not match', () => {
    const { nonce, ciphertext } = encryptAead(key, plaintext, aad);
    const wrongAad = new TextEncoder().encode('oxy.backup.v1:did:web:oxy.so:u:999');
    expect(() => decryptAead(key, nonce, ciphertext, wrongAad)).toThrow();
    // AAD present at encrypt, absent at decrypt must also fail.
    expect(() => decryptAead(key, nonce, ciphertext)).toThrow();
  });

  it('throws when the key does not match', () => {
    const { nonce, ciphertext } = encryptAead(key, plaintext, aad);
    const wrongKey = hkdfSha256(fromHex('01'), new Uint8Array(0), new TextEncoder().encode('aead-test'), AEAD_KEY_LENGTH);
    expect(() => decryptAead(wrongKey, nonce, ciphertext, aad)).toThrow();
  });

  it('throws when the nonce does not match', () => {
    const { nonce, ciphertext } = encryptAead(key, plaintext, aad);
    const wrongNonce = Uint8Array.from(nonce);
    wrongNonce[0] ^= 0x01;
    expect(() => decryptAead(key, wrongNonce, ciphertext, aad)).toThrow();
  });

  it('rejects keys of the wrong length', () => {
    expect(() => encryptAead(new Uint8Array(16), plaintext)).toThrow();
    const { nonce, ciphertext } = encryptAead(key, plaintext);
    expect(() => decryptAead(new Uint8Array(31), nonce, ciphertext)).toThrow();
  });

  it('rejects a nonce of the wrong length on decrypt', () => {
    const { ciphertext } = encryptAead(key, plaintext);
    expect(() => decryptAead(key, new Uint8Array(12), ciphertext)).toThrow();
  });

  it('handles empty plaintext', () => {
    const empty = new Uint8Array(0);
    const { nonce, ciphertext } = encryptAead(key, empty, aad);
    expect(ciphertext.length).toBe(16); // tag only
    expect(decryptAead(key, nonce, ciphertext, aad).length).toBe(0);
  });
});

describe('deriveSharedSecret (secp256k1 ECDH)', () => {
  const alice = generateSecp256k1KeyPair();
  const bob = generateSecp256k1KeyPair();
  const alicePriv = alice.privateKey;
  const bobPriv = bob.privateKey;
  const alicePubUncompressed = alice.publicKey;
  const bobPubUncompressed = bob.publicKey;

  it('is symmetric: derive(a, pubB) === derive(b, pubA)', () => {
    const ab = deriveSharedSecret(alicePriv, bobPubUncompressed);
    const ba = deriveSharedSecret(bobPriv, alicePubUncompressed);
    expect(toHex(ab)).toBe(toHex(ba));
  });

  it('returns exactly 32 bytes', () => {
    expect(deriveSharedSecret(alicePriv, bobPubUncompressed).length).toBe(32);
  });

  it('agrees for compressed and uncompressed public-key encodings', () => {
    const bobPubCompressed = normalizeSecp256k1PublicKey(bob.publicKey, true);
    const fromUncompressed = deriveSharedSecret(alicePriv, bobPubUncompressed);
    const fromCompressed = deriveSharedSecret(alicePriv, bobPubCompressed);
    expect(toHex(fromCompressed)).toBe(toHex(fromUncompressed));
  });

  it('yields different secrets for different counterparties', () => {
    const carol = generateSecp256k1KeyPair();
    const withBob = deriveSharedSecret(alicePriv, bobPubUncompressed);
    const withCarol = deriveSharedSecret(alicePriv, carol.publicKey);
    expect(toHex(withBob)).not.toBe(toHex(withCarol));
  });

  it('is stable across repeated derivations', () => {
    const first = deriveSharedSecret(alicePriv, bobPubUncompressed);
    const second = deriveSharedSecret(alicePriv, bobPubUncompressed);
    expect(toHex(first)).toBe(toHex(second));
  });

  it('composes with HKDF to yield a usable AEAD key round-trip', () => {
    const shared = deriveSharedSecret(alicePriv, bobPubUncompressed);
    const info = new TextEncoder().encode('oxy.transfer.v1');
    const aliceKey = hkdfSha256(shared, new Uint8Array(0), info, AEAD_KEY_LENGTH);
    const bobKey = hkdfSha256(
      deriveSharedSecret(bobPriv, alicePubUncompressed),
      new Uint8Array(0),
      info,
      AEAD_KEY_LENGTH,
    );
    expect(toHex(aliceKey)).toBe(toHex(bobKey));

    const message = new TextEncoder().encode('device transfer payload');
    const { nonce, ciphertext } = encryptAead(aliceKey, message);
    expect(toHex(decryptAead(bobKey, nonce, ciphertext))).toBe(toHex(message));
  });

  it('rejects non-hex inputs', () => {
    expect(() => deriveSharedSecret('zzzz', bobPubUncompressed)).toThrow();
    expect(() => deriveSharedSecret(alicePriv, 'nothex')).toThrow();
  });
});
