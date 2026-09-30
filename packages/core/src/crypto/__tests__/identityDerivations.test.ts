/**
 * The identity derivations agree byte for byte with Commons' native identity
 * host.
 *
 * On Android only Commons holds the identity key, and its identity host
 * (Kotlin, BouncyCastle) computes the challenge proofs, scoped seeds and
 * social-receive signatures other apps ask for. On iOS, and inside Commons,
 * this module computes the same values in JavaScript. The two must never drift:
 * a different seed is a different wallet. `vectors.json` next to the Kotlin is
 * the contract; the Commons JVM unit test checks the Kotlin against it, and
 * this suite checks the JavaScript.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deriveSecp256k1PublicKey, signSecp256k1Digest, verifySecp256k1Digest } from '@oxy.so/protocol/secp256k1';
import {
  SCOPED_SEED_KDF_SALT,
  SOCIAL_RECEIVE_CHAIN_CODE_KEY,
  authChallengeDigest,
  deriveScopedSeedFromKey,
  deriveSocialReceiveKey,
  signSocialReceiveDigest,
} from '../identityDerivations';

interface Vectors {
  scopedSeedSalt: string;
  socialReceiveChainCodeKey: string;
  identities: Array<{
    privateKey: string;
    publicKey: string;
    proveIdentity: { challenge: string; timestamp: number; digest: string; signature: string };
    scopedSeeds: Array<{ info: string; seed: string }>;
    socialReceive: Array<{
      index: number;
      childPrivateKey: string;
      childPublicKey: string;
      digest: string;
      signature: string;
    }>;
  }>;
}

const VECTORS_PATH = resolve(__dirname, '../../../../commons/modules/oxy-identity-host/vectors.json');
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Vectors;
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

/** The S half of a DER signature. */
function derS(der: string): bigint {
  const bytes = Buffer.from(der, 'hex');
  const rLength = bytes[3];
  const sLength = bytes[5 + rLength];
  return BigInt(`0x${bytes.subarray(6 + rLength, 6 + rLength + sLength).toString('hex')}`);
}

describe('identity derivations match the Commons identity host vectors', () => {
  test('the vector file is actually being read', () => {
    expect(vectors.identities.length).toBeGreaterThanOrEqual(3);
    expect(vectors.scopedSeedSalt).toBe(SCOPED_SEED_KDF_SALT);
    expect(vectors.socialReceiveChainCodeKey).toBe(SOCIAL_RECEIVE_CHAIN_CODE_KEY);
  });

  test.each(vectors.identities.map((v) => [v.privateKey.slice(0, 8), v] as const))(
    'identity %s',
    (_label, identity) => {
      expect(deriveSecp256k1PublicKey(identity.privateKey)).toBe(identity.publicKey);

      const proof = identity.proveIdentity;
      const digest = authChallengeDigest(identity.publicKey, proof.challenge, proof.timestamp);
      expect(digest).toBe(proof.digest);
      // What `POST /auth/verify` checks, over the unchanged message format.
      expect(signSecp256k1Digest(identity.privateKey, digest)).toBe(proof.signature);
      expect(verifySecp256k1Digest(identity.publicKey, digest, proof.signature)).toBe(true);

      for (const { info, seed } of identity.scopedSeeds) {
        expect(toHex(deriveScopedSeedFromKey(identity.privateKey, info))).toBe(seed);
      }

      for (const social of identity.socialReceive) {
        const child = deriveSocialReceiveKey(identity.privateKey, social.index);
        expect(child).toEqual({ privateKey: social.childPrivateKey, publicKey: social.childPublicKey });
        const signed = signSocialReceiveDigest(identity.privateKey, social.index, social.digest);
        expect(signed).toEqual({ signature: social.signature, publicKey: social.childPublicKey });
        expect(verifySecp256k1Digest(social.childPublicKey, social.digest, social.signature)).toBe(true);
        // FairCoin relays only low-S input signatures (BIP 62).
        expect(derS(social.signature) <= N / 2n).toBe(true);
      }
    },
  );

  test('the proofs cover both halves of S (Commons must not normalise them)', () => {
    const halves = new Set(
      vectors.identities.map((v) => (derS(v.proveIdentity.signature) > N / 2n ? 'high' : 'low')),
    );
    expect(halves).toEqual(new Set(['high', 'low']));
  });

  test('pins the Peable wallet seeds', () => {
    const aa = vectors.identities.find((v) => v.privateKey === 'aa'.repeat(32));
    expect(aa?.scopedSeeds).toEqual([
      { info: 'oxypay/faircoin/v1', seed: '4b90d900a11b0a1737ed643db3446e5f28035d86f1a4fda92474ea8ab152adf5' },
      { info: 'peable/faircoin/v1', seed: '3282e7b8585d3de14fc8856debc352b7b238eccd5c861ec33c92a443857e6040' },
    ]);
  });

  test('rejects hardened indices and malformed digests', () => {
    const key = 'aa'.repeat(32);
    expect(() => deriveSocialReceiveKey(key, 0x80000000)).toThrow();
    expect(() => deriveSocialReceiveKey(key, -1)).toThrow();
    expect(() => deriveSocialReceiveKey(key, 1.5)).toThrow();
    expect(() => signSocialReceiveDigest(key, 0, 'AB'.repeat(32))).toThrow();
    expect(() => signSocialReceiveDigest(key, 0, 'ab')).toThrow();
  });
});
