/**
 * The library wiring under the keychain (RFC 7748 X25519, RFC 8032 Ed25519,
 * RFC 4648 base64url), the strict encodings, seal, the recovery key, the
 * password generator and TOTP.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import {
  fromBase64Url,
  fromHex,
  fromUtf8,
  isKeychainTimestamp,
  jcs,
  parseCanonicalJson,
  toBase64Url,
  toHex,
} from '../encoding';
import { KeychainCryptoError, KeychainFormatError } from '../errors';
import {
  decodeBoxKey,
  decodeSigningKey,
  deviceKeysFromSecrets,
  ed25519PublicKey,
  generateDeviceKeys,
  signBytes,
  verifyBytes,
  zeroizeKeyPairs,
} from '../keys';
import { generateStrongPassword, isStrongPasswordShape } from '../password';
import {
  deriveRecoveryKeys,
  formatRecoveryKey,
  generateRecoveryKey,
  parseRecoveryKey,
  recoveryKeyMatches,
} from '../recoveryKey';
import { openSealed, seal } from '../seal';
import {
  decodeBase32Secret,
  encodeBase32Secret,
  hotpCode,
  parseOtpauthUri,
  totpCode,
  totpSecondsRemaining,
} from '../totp';
import { exportPublicKeys } from '../keys';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('library wiring', () => {
  it('X25519 matches RFC 7748 §5.2 and §6.1', () => {
    const scalar = fromHex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4');
    const u = fromHex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c');
    expect(toHex(x25519.getSharedSecret(scalar, u))).toBe(
      'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552',
    );
    const alice = fromHex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
    const bob = fromHex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
    expect(toHex(x25519.getPublicKey(alice))).toBe(
      '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
    );
    expect(toHex(x25519.getPublicKey(bob))).toBe(
      'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
    );
    const keys = deviceKeysFromSecrets(new Uint8Array(32).fill(1), alice);
    expect(toHex(keys.boxPublicKey)).toBe(
      '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
    );
  });

  it('Ed25519 matches RFC 8032 §7.1 test 1 and test 2', () => {
    const sk1 = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
    expect(toHex(ed25519PublicKey(sk1))).toBe(
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    );
    expect(toHex(signBytes(sk1, new Uint8Array(0)))).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
    const sk2 = fromHex('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb');
    const pk2 = ed25519PublicKey(sk2);
    expect(toHex(pk2)).toBe('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c');
    const sig2 = signBytes(sk2, fromHex('72'));
    expect(toHex(sig2)).toBe(
      '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
    );
    expect(verifyBytes(pk2, fromHex('72'), sig2)).toBe(true);
    expect(verifyBytes(pk2, fromHex('73'), sig2)).toBe(false);
  });

  it('strict verification refuses a non-canonical S and a small-order key', () => {
    const keys = generateDeviceKeys();
    const message = utf8('m');
    const sig = signBytes(keys.signingSecretKey, message);
    // S + L is the same signature to a lax verifier; RFC 8032 refuses it.
    const L = fromHex('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010');
    const bad = sig.slice();
    let carry = 0;
    for (let i = 0; i < 32; i += 1) {
      const sum = bad[32 + i] + L[i] + carry;
      bad[32 + i] = sum & 0xff;
      carry = sum >> 8;
    }
    expect(verifyBytes(keys.signingPublicKey, message, bad)).toBe(false);
    // The identity point (y = 1) is of small order.
    const identity = new Uint8Array(32);
    identity[0] = 1;
    expect(() => decodeSigningKey(toBase64Url(identity))).toThrow(KeychainFormatError);
    expect(() => decodeBoxKey(toBase64Url(new Uint8Array(32)))).toThrow(KeychainFormatError);
    expect(decodeSigningKey(toBase64Url(keys.signingPublicKey))).toEqual(keys.signingPublicKey);
  });

  it('zeroizes key pairs', () => {
    const keys = generateDeviceKeys();
    zeroizeKeyPairs(keys);
    expect(keys.signingSecretKey.every((x) => x === 0)).toBe(true);
    expect(keys.boxSecretKey.every((x) => x === 0)).toBe(true);
  });
});

describe('encodings', () => {
  it('base64url matches RFC 4648 §10 and Node', () => {
    const cases: Array<[string, string]> = [
      ['', ''],
      ['f', 'Zg'],
      ['fo', 'Zm8'],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg'],
      ['fooba', 'Zm9vYmE'],
      ['foobar', 'Zm9vYmFy'],
    ];
    for (const [plain, encoded] of cases) {
      expect(toBase64Url(utf8(plain))).toBe(encoded);
      expect(new TextDecoder().decode(fromBase64Url(encoded))).toBe(plain);
    }
    for (let n = 0; n < 70; n += 1) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n * 11) & 0xff);
      expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });

  it('base64url decoding is strict', () => {
    expect(() => fromBase64Url('Zg==')).toThrow(KeychainFormatError);
    expect(() => fromBase64Url('Zh')).toThrow(KeychainFormatError); // non-zero trailing bits
    expect(() => fromBase64Url('Z')).toThrow(KeychainFormatError);
    expect(() => fromBase64Url('Zm9v+/')).toThrow(KeychainFormatError);
    expect(() => fromBase64Url('Zm 9v')).toThrow(KeychainFormatError);
    expect(() => fromBase64Url('Zm9v', 4)).toThrow(KeychainFormatError);
  });

  it('JCS refuses what has no one spelling', () => {
    expect(jcs({ b: [1, 'x', null, true], a: { d: -7, c: '\u0000"\\ 😀' } })).toBe(
      '{"a":{"c":"\\u0000\\"\\\\ 😀","d":-7},"b":[1,"x",null,true]}',
    );
    expect(() => jcs({ a: 1.5 })).toThrow(KeychainFormatError);
    expect(() => jcs({ a: -0 })).toThrow(KeychainFormatError);
    expect(() => jcs({ a: 2 ** 53 })).toThrow(KeychainFormatError);
    expect(() => jcs({ a: '\ud800' })).toThrow(KeychainFormatError);
    expect(() => jcs({ a: undefined })).toThrow(KeychainFormatError);
    expect(() => jcs(new Date())).toThrow(KeychainFormatError);
    expect(() => parseCanonicalJson('{"b":1,"a":2}')).toThrow(KeychainFormatError);
    expect(() => parseCanonicalJson('{"a":1,"a":1}')).toThrow(KeychainFormatError);
    expect(() => parseCanonicalJson('{"a":"\\u0041"}')).toThrow(KeychainFormatError);
    expect(() => parseCanonicalJson('{"a":1} ')).toThrow(KeychainFormatError);
    expect(parseCanonicalJson('{"a":"A"}')).toEqual({ a: 'A' });
  });

  it('timestamps have one spelling', () => {
    expect(isKeychainTimestamp('2026-11-07T12:00:00.000Z')).toBe(true);
    expect(isKeychainTimestamp('2026-11-07T12:00:00Z')).toBe(false);
    expect(isKeychainTimestamp('2026-11-07T12:00:00.000+00:00')).toBe(false);
    expect(isKeychainTimestamp('2026-02-30T12:00:00.000Z')).toBe(false);
  });
});

describe('seal', () => {
  const recipient = generateDeviceKeys();
  const aad = utf8('context');
  const plaintext = utf8('secret');

  it('round-trips and uses a fresh ephemeral key and nonce each time', () => {
    const a = seal(recipient.boxPublicKey, plaintext, aad);
    const b = seal(recipient.boxPublicKey, plaintext, aad);
    expect(a.epk).not.toBe(b.epk);
    expect(a.nonce).not.toBe(b.nonce);
    expect(openSealed(recipient.boxSecretKey, a, aad)).toEqual(plaintext);
  });

  it('refuses a changed aad, key, ciphertext, nonce or ephemeral key', () => {
    const box = seal(recipient.boxPublicKey, plaintext, aad);
    const flip = (s: string) => {
      const bytes = fromBase64Url(s);
      bytes[0] ^= 1;
      return toBase64Url(bytes);
    };
    expect(() => openSealed(recipient.boxSecretKey, box, utf8('other'))).toThrow(
      KeychainCryptoError,
    );
    expect(() => openSealed(generateDeviceKeys().boxSecretKey, box, aad)).toThrow(
      KeychainCryptoError,
    );
    expect(() =>
      openSealed(recipient.boxSecretKey, { ...box, ciphertext: flip(box.ciphertext) }, aad),
    ).toThrow(KeychainCryptoError);
    expect(() =>
      openSealed(recipient.boxSecretKey, { ...box, nonce: flip(box.nonce) }, aad),
    ).toThrow(KeychainCryptoError);
    expect(() =>
      openSealed(
        recipient.boxSecretKey,
        { ...box, epk: exportPublicKeys(generateDeviceKeys()).boxKey },
        aad,
      ),
    ).toThrow(KeychainCryptoError);
  });

  it('refuses a low-order ephemeral key (all-zero shared secret)', () => {
    const box = seal(recipient.boxPublicKey, plaintext, aad);
    expect(() =>
      openSealed(recipient.boxSecretKey, { ...box, epk: toBase64Url(new Uint8Array(32)) }, aad),
    ).toThrow(KeychainCryptoError);
    expect(() => seal(new Uint8Array(32), plaintext, aad)).toThrow(KeychainCryptoError);
  });
});

describe('recovery key', () => {
  it('is 20 bytes shown as eight groups of four', () => {
    const key = generateRecoveryKey();
    expect(key).toHaveLength(20);
    const text = formatRecoveryKey(key);
    expect(text).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
    expect(parseRecoveryKey(text)).toEqual(key);
  });

  it('reads case, hyphens, spaces and I/L/O leniently, and nothing else', () => {
    const key = parseRecoveryKey('0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ');
    expect(parseRecoveryKey('oI23 4567 89ab cdef ghjk mnpq rstv wxyz')).toEqual(key);
    expect(parseRecoveryKey('OL23456789ABCDEFGHJKMNPQRSTVWXYZ')).toEqual(key);
    expect(() => parseRecoveryKey('0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXY')).toThrow(
      KeychainFormatError,
    );
    expect(() => parseRecoveryKey('0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ0')).toThrow(
      KeychainFormatError,
    );
    expect(() => parseRecoveryKey('U123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ')).toThrow(
      KeychainFormatError,
    );
    expect(() => parseRecoveryKey('0123_4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ')).toThrow(
      KeychainFormatError,
    );
    expect(() => parseRecoveryKey('ı123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ')).toThrow(
      KeychainFormatError,
    );
    expect(() => parseRecoveryKey('')).toThrow(KeychainFormatError);
  });

  it('a mistyped key derives other keys, told apart before use', () => {
    const key = generateRecoveryKey();
    const keys = deriveRecoveryKeys(key);
    const typo = key.slice();
    typo[19] ^= 1;
    expect(recoveryKeyMatches(keys, exportPublicKeys(keys))).toBe(true);
    expect(recoveryKeyMatches(deriveRecoveryKeys(typo), exportPublicKeys(keys))).toBe(false);
  });
});

describe('strong password', () => {
  it('is four groups of five with every class', () => {
    for (let i = 0; i < 200; i += 1) {
      const password = generateStrongPassword();
      expect(password).toMatch(/^[a-zA-Z0-9]{5}(-[a-zA-Z0-9]{5}){3}$/);
      expect(isStrongPasswordShape(password)).toBe(true);
    }
  });

  it('never uses a byte at or above 248 (no modulo bias)', () => {
    // A source that offers only biased bytes first, then 0..61 in order.
    let calls = 0;
    const random = (n: number) => {
      calls += 1;
      if (calls === 1) return new Uint8Array(n).fill(250);
      return new Uint8Array(n).map((_, i) => ((calls * 7 + i) * 13) % 62);
    };
    const password = generateStrongPassword(random);
    expect(isStrongPasswordShape(password)).toBe(true);
    expect(calls).toBeGreaterThan(1);
  });

  it('draws again when a class is missing', () => {
    let calls = 0;
    const random = (n: number) => {
      calls += 1;
      // First draw: lower-case only. Then a mix.
      return new Uint8Array(n).map((_, i) => (calls === 1 ? i % 26 : (i * 29 + calls) % 62));
    };
    expect(isStrongPasswordShape(generateStrongPassword(random))).toBe(true);
    expect(calls).toBeGreaterThan(1);
  });

  it('is roughly uniform over the alphabet', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i += 1) {
      for (const ch of generateStrongPassword().replace(/-/g, ''))
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(counts.size).toBe(62);
    const expected = (2000 * 20) / 62;
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(expected * 0.75);
      expect(n).toBeLessThan(expected * 1.25);
    }
  });
});

describe('totp', () => {
  const seed = utf8('12345678901234567890');

  it('HOTP matches RFC 4226 Appendix D', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expected.forEach((code, counter) => expect(hotpCode(seed, counter)).toBe(code));
  });

  it('base32 secrets round-trip and read leniently', () => {
    expect(encodeBase32Secret(seed)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(decodeBase32Secret('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq====')).toEqual(seed);
    expect(() => decodeBase32Secret('GEZ1')).toThrow(KeychainFormatError);
    expect(() => decodeBase32Secret('')).toThrow(KeychainFormatError);
  });

  it('counts seconds left in the step', () => {
    expect(totpSecondsRemaining(59_000)).toBe(1);
    expect(totpSecondsRemaining(60_000)).toBe(30);
    expect(totpCode({ secret: seed }, 59_000)).toBe('287082');
  });

  it('refuses otpauth URIs it cannot use', () => {
    const ok = 'otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP';
    expect(parseOtpauthUri(ok).account).toBe('b');
    for (const bad of [
      'otpauth://hotp/A:b?secret=JBSWY3DPEHPK3PXP&counter=1',
      'https://totp/A:b?secret=JBSWY3DPEHPK3PXP',
      'otpauth://totp/A:b',
      'otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP&secret=JBSWY3DPEHPK3PXP',
      'otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP&algorithm=MD5',
      'otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP&digits=10',
      'otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP&period=0',
      'otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP#frag',
      'otpauth://totp/A%:b?secret=JBSWY3DPEHPK3PXP',
      'otpauth://totp/A:b?secret=1111',
    ]) {
      expect(() => parseOtpauthUri(bad)).toThrow(KeychainFormatError);
    }
  });
});

describe('strict UTF-8', () => {
  it('refuses malformed bytes and keeps a BOM', () => {
    expect(fromUtf8(new TextEncoder().encode('ñ😀'))).toBe('ñ😀');
    expect(() => fromUtf8(new Uint8Array([0xc3]))).toThrow(KeychainFormatError);
    expect(() => fromUtf8(new Uint8Array([0xed, 0xa0, 0x80]))).toThrow(KeychainFormatError);
    expect(() => fromUtf8(new Uint8Array([0xff]))).toThrow(KeychainFormatError);
    // A leading BOM is not silently dropped: the bytes must round-trip.
    expect(() => fromUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toThrow(KeychainFormatError);
  });
});
