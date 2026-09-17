/**
 * The one identity-proof format (ADR 0024 D7): the signed bytes name every
 * claim, so a signature for one operation verifies for nothing else.
 */

import { buildIdentityProofMessage, canonicalJson, type IdentityProofClaims } from '@oxy.so/contracts';
import { verifySignature } from '@oxy.so/protocol';
import { digestIdentityPayload, signIdentityProof } from '../identityProof';
import { deriveIdentityFromMnemonic } from '../webIdentityCarrier';

const identity = deriveIdentityFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');

const claims = (overrides: Partial<IdentityProofClaims> = {}): IdentityProofClaims => ({
  action: 'web_envelope_put',
  subject: 'user-1',
  actor: 'user-1',
  rootPublicKey: identity.publicKey,
  payloadDigest: digestIdentityPayload({ b: 1, a: [1, 'x'] }),
  expectedRevision: 3,
  audience: 'oxy-api/identity',
  challenge: 'ab'.repeat(32),
  expiresAt: 1_800_000_000_000,
  ...overrides,
});

describe('canonical JSON', () => {
  it('sorts keys at every depth and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('digests the same payload identically whatever its key order', () => {
    expect(digestIdentityPayload({ a: 1, b: 2 })).toBe(digestIdentityPayload({ b: 2, a: 1 }));
    expect(digestIdentityPayload({ a: 1, b: 2 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses values JSON cannot represent exactly', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow('non-finite');
    expect(() => canonicalJson({ a: () => 1 })).toThrow('unsupported');
  });
});

describe('the signed bytes', () => {
  it('are a fixed, versioned, domain-separated shape', () => {
    expect(buildIdentityProofMessage(claims())).toBe(
      `{"action":"web_envelope_put","actor":"user-1","audience":"oxy-api/identity","challenge":"${'ab'.repeat(32)}","domain":"oxy-identity-proof","expectedRevision":3,"expiresAt":1800000000000,"payloadDigest":"${claims().payloadDigest}","rootPublicKey":"${identity.publicKey}","subject":"user-1","v":2}`,
    );
  });

  it('refuse malformed claims instead of signing something ambiguous', () => {
    expect(() => buildIdentityProofMessage(claims({ action: 'anything' as never }))).toThrow('unknown action');
    expect(() => buildIdentityProofMessage(claims({ payloadDigest: 'AB'.repeat(32) }))).toThrow('payloadDigest');
    expect(() => buildIdentityProofMessage(claims({ challenge: 'short' }))).toThrow('challenge');
    expect(() => buildIdentityProofMessage(claims({ rootPublicKey: identity.publicKey.toUpperCase() }))).toThrow('rootPublicKey');
  });
});

describe('signing', () => {
  it('verifies for exactly the claims it was made for', async () => {
    const proof = await signIdentityProof(identity, claims());
    expect(proof).toMatchObject({ v: 2, challenge: 'ab'.repeat(32), expiresAt: 1_800_000_000_000 });

    expect(await verifySignature(buildIdentityProofMessage(claims()), proof.signature, identity.publicKey)).toBe(true);
    for (const changed of [
      claims({ action: 'web_envelope_delete' }),
      claims({ subject: 'user-2' }),
      claims({ actor: 'user-2' }),
      claims({ payloadDigest: digestIdentityPayload({ b: 2 }) }),
      claims({ expectedRevision: 4 }),
      claims({ audience: 'somewhere-else' }),
      claims({ challenge: 'cd'.repeat(32) }),
      claims({ expiresAt: 1_800_000_000_001 }),
    ]) {
      expect(await verifySignature(buildIdentityProofMessage(changed), proof.signature, identity.publicKey)).toBe(false);
    }
  });

  it('will not sign claims naming a different root', async () => {
    const other = deriveIdentityFromMnemonic('legal winner thank year wave sausage worth useful legal winner thank yellow');
    await expect(signIdentityProof(identity, claims({ rootPublicKey: other.publicKey }))).rejects.toThrow('different root');
  });
});
