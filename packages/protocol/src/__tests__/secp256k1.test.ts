import {
  deriveSecp256k1PublicKey,
  deriveSecp256k1SharedSecret,
  generateSecp256k1KeyPair,
  isValidSecp256k1PrivateKey,
  isValidSecp256k1PublicKey,
  normalizeSecp256k1PrivateKey,
  normalizeSecp256k1PublicKey,
  signSecp256k1Digest,
  verifySecp256k1Digest,
} from "../secp256k1";

const PRIVATE_KEY_ONE = `${"0".repeat(63)}1`;
const PRIVATE_KEY_TWO = `${"0".repeat(63)}2`;
const DIGEST_ONE = `${"0".repeat(63)}1`;

const PUBLIC_KEY_ONE =
  "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
  "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
const COMPRESSED_PUBLIC_KEY_ONE =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PUBLIC_KEY_TWO =
  "04c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5" +
  "1ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a";

// Exact DER output produced by elliptic 6.6.1 for this RFC 6979 vector.
const HISTORICAL_HIGH_S_SIGNATURE =
  "304502206673ffad2147741f04772b6f921f0ba6af0c1e77fc439e65c36dedf4092e8898" +
  "022100b3e568e9ad1f52577fedf107fda18f5ebb8e5c220badf23532bf6fbcc67fb4b8";
const LOW_S_SIGNATURE =
  "304402206673ffad2147741f04772b6f921f0ba6af0c1e77fc439e65c36dedf4092e8898" +
  "02204c1a971652e0ada880120ef8025e709fff2080c4a39aae068d12eed009b68c89";

describe("secp256k1 primitives", () => {
  test("preserves the canonical private/public key formats", () => {
    expect(normalizeSecp256k1PrivateKey("1")).toBe(PRIVATE_KEY_ONE);
    expect(deriveSecp256k1PublicKey(PRIVATE_KEY_ONE)).toBe(PUBLIC_KEY_ONE);
    expect(deriveSecp256k1PublicKey(PRIVATE_KEY_ONE, true)).toBe(
      COMPRESSED_PUBLIC_KEY_ONE,
    );
    expect(normalizeSecp256k1PublicKey(COMPRESSED_PUBLIC_KEY_ONE)).toBe(
      PUBLIC_KEY_ONE,
    );
    expect(normalizeSecp256k1PublicKey(PUBLIC_KEY_ONE, true)).toBe(
      COMPRESSED_PUBLIC_KEY_ONE,
    );
  });

  test("matches the historical deterministic DER wire format", () => {
    const signature = signSecp256k1Digest(PRIVATE_KEY_ONE, DIGEST_ONE);
    expect(signature).toBe(HISTORICAL_HIGH_S_SIGNATURE);
    expect(verifySecp256k1Digest(PUBLIC_KEY_ONE, DIGEST_ONE, signature)).toBe(
      true,
    );
    expect(
      verifySecp256k1Digest(COMPRESSED_PUBLIC_KEY_ONE, DIGEST_ONE, signature),
    ).toBe(true);
  });

  test("supports explicit low-S signatures while accepting both historical forms", () => {
    const signature = signSecp256k1Digest(PRIVATE_KEY_ONE, DIGEST_ONE, {
      lowS: true,
    });
    expect(signature).toBe(LOW_S_SIGNATURE);
    expect(verifySecp256k1Digest(PUBLIC_KEY_ONE, DIGEST_ONE, signature)).toBe(
      true,
    );
    expect(
      verifySecp256k1Digest(
        PUBLIC_KEY_ONE,
        DIGEST_ONE,
        HISTORICAL_HIGH_S_SIGNATURE,
      ),
    ).toBe(true);
  });

  test("derives the fixed-width ECDH x-coordinate symmetrically", () => {
    const expected =
      "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    const oneToTwo = deriveSecp256k1SharedSecret(
      PRIVATE_KEY_ONE,
      PUBLIC_KEY_TWO,
    );
    const twoToOne = deriveSecp256k1SharedSecret(
      PRIVATE_KEY_TWO,
      PUBLIC_KEY_ONE,
    );

    expect(Buffer.from(oneToTwo).toString("hex")).toBe(expected);
    expect(oneToTwo).toEqual(twoToOne);
    expect(oneToTwo).toHaveLength(32);
  });

  test("generates canonical key pairs that round-trip", () => {
    const keyPair = generateSecp256k1KeyPair();
    expect(keyPair.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(keyPair.publicKey).toMatch(/^04[0-9a-f]{128}$/);
    expect(deriveSecp256k1PublicKey(keyPair.privateKey)).toBe(
      keyPair.publicKey,
    );
  });

  test("strictly rejects malformed scalars, points, digests, and DER", () => {
    expect(isValidSecp256k1PrivateKey("0")).toBe(false);
    expect(isValidSecp256k1PrivateKey("zz")).toBe(false);
    expect(isValidSecp256k1PrivateKey("f".repeat(66))).toBe(false);
    expect(isValidSecp256k1PublicKey(`04${"0".repeat(128)}`)).toBe(false);
    expect(isValidSecp256k1PublicKey(`05${PUBLIC_KEY_ONE.slice(2)}`)).toBe(
      false,
    );
    expect(() => signSecp256k1Digest(PRIVATE_KEY_ONE, "00")).toThrow(
      "digest must be exactly 32 bytes",
    );
    expect(() =>
      verifySecp256k1Digest(PUBLIC_KEY_ONE, DIGEST_ONE, "00"),
    ).toThrow();
  });
});
