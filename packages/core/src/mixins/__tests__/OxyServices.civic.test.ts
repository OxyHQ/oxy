/**
 * Civic Mixin tests (Commons "Oxy ID" — Fase 1; anti-gaming — Fase 2;
 * proof-of-personhood web-of-trust — Fase 3).
 *
 * Fase 3 covers the staked vouch: `vouchForPerson` fetches the caller's chain
 * head, signs a self-issued `personhood_vouch` v2 envelope (about=subjectDid,
 * stake from `stakeAmount`, collection `app.oxy.vouch`, rkey=subjectDid), POSTs
 * it, and sweeps the personhood + `/users/me` GET caches; `withdrawVouch` DELETEs
 * + sweeps; `getPersonhood`/`getMyPersonhood` shape the right cached GET.
 *
 * Stubs `makeRequest` so the tests run with no network, then asserts:
 *  - Fase 1: `getPublicCard` shapes the request (GET `/civic/:userId/card`,
 *    cached) and verifies a GENUINE Oxy signature over `canonicalize(card)` →
 *    `verified:true`; a tampered card / wrong key → `verified:false` (NO throw);
 *    a `null` attestation → `verified:false`; a transport failure still rejects;
 *    `getMyIdPayload` builds the exact `oxycommons://card?did=…&v=1` string and
 *    round-trips through `parseIdPayload`, which rejects garbage.
 *  - Fase 2: `buildAttestQrPayload` mints a fresh nonce + 10-min exp and encodes
 *    the context safely; `parseAttestPayload` round-trips + rejects garbage;
 *    `submitRealLifeAttestation` fetches the caller's chain head, signs a
 *    self-issued v2 envelope (about=subjectDid, seq=head+1, prev=head id,
 *    collection `app.oxy.attestation`, rkey=nonce) and POSTs it;
 *    `getValidatorInbox`/`submitValidationVote`/`denyValidation` shape their
 *    requests and the vote signs the right verdict envelope.
 *
 * The Fase 1 "genuine" card signatures use real secp256k1 keypairs (the same
 * `ES256K-DER-SHA256` scheme the server uses). The Fase 2 write tests mock
 * `SignatureService.signRecordV2` (asserting the exact record + chain coords) so
 * they isolate the SDK's request shaping from native key storage.
 */

import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import type {
  ExportAttestation,
  PublicCard,
  SignedRecordEnvelope,
  VerifiableCredentialResponse,
} from '@oxyhq/contracts';
import { OxyServices } from '../../OxyServices';
import { canonicalize, signMessage } from '@oxyhq/protocol';
import { SignatureService } from '../../crypto/signatureService';
import { parseAttestPayload, parseIdPayload, verifyPublicCardAttestation } from '../OxyServices.civic';

const baseCard: PublicCard = {
  did: 'did:web:oxy.so:u:user-123',
  userId: 'user-123',
  name: 'Nate',
  username: 'nate',
  avatarUrl: 'https://cloud.oxy.so/file-1',
  trustTier: 'trusted',
  personhoodStatus: 'unverified',
  verifiedDomains: ['nate.com'],
  credentialBadges: [],
  issuedAt: 1700000000000,
};

/** Sign `canonicalize(card)` with a fresh keypair and return the sealed attestation. */
async function signCard(card: PublicCard): Promise<{ attestation: ExportAttestation; publicKey: string }> {
  const keyPair = generateSecp256k1KeyPair();
  const privateKey = keyPair.privateKey;
  const publicKey = keyPair.publicKey;
  const signature = await signMessage(canonicalize(card), privateKey);
  return {
    attestation: {
      issuer: 'did:web:api.oxy.so',
      publicKey,
      alg: 'ES256K-DER-SHA256',
      signature,
      signedAt: 1700000000001,
    },
    publicKey,
  };
}

describe('OxyServices.civic', () => {
  let oxy: OxyServices;
  let makeRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequestSpy = jest.spyOn(oxy, 'makeRequest');
    jest.spyOn(oxy, 'getCurrentUserId').mockReturnValue('user-123');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getPublicCard', () => {
    it('GETs /civic/:userId/card (cached) and verifies a genuine Oxy signature', async () => {
      const { attestation } = await signCard(baseCard);
      makeRequestSpy.mockResolvedValue({ card: baseCard, attestation });

      const result = await oxy.getPublicCard('user-123');

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/civic/user-123/card',
        undefined,
        expect.objectContaining({ cache: true }),
      );
      expect(result.card).toEqual(baseCard);
      expect(result.attestation).toEqual(attestation);
      expect(result.verified).toBe(true);
    });

    it('URL-encodes the userId path segment', async () => {
      makeRequestSpy.mockResolvedValue({ card: baseCard, attestation: null });
      await oxy.getPublicCard('a/b');
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/civic/a%2Fb/card',
        undefined,
        expect.anything(),
      );
    });

    it('returns verified:false (no throw) when the card was tampered after signing', async () => {
      const { attestation } = await signCard(baseCard);
      // Attestation covers the ORIGINAL card; serve a mutated one.
      const tampered: PublicCard = { ...baseCard, name: 'Eve' };
      makeRequestSpy.mockResolvedValue({ card: tampered, attestation });

      const result = await oxy.getPublicCard('user-123');

      expect(result.card).toEqual(tampered);
      expect(result.verified).toBe(false);
    });

    it('returns verified:false (no throw) when the signature is from a different key', async () => {
      const { attestation } = await signCard(baseCard);
      const otherKey = generateSecp256k1KeyPair().publicKey;
      const forged: ExportAttestation = { ...attestation, publicKey: otherKey };
      makeRequestSpy.mockResolvedValue({ card: baseCard, attestation: forged });

      const result = await oxy.getPublicCard('user-123');

      expect(result.verified).toBe(false);
    });

    it('returns verified:false (no throw) for an unsigned card (attestation null)', async () => {
      makeRequestSpy.mockResolvedValue({ card: baseCard, attestation: null });

      const result = await oxy.getPublicCard('user-123');

      expect(result.attestation).toBeNull();
      expect(result.verified).toBe(false);
    });

    it('rejects on a transport failure (the fetch itself)', async () => {
      makeRequestSpy.mockRejectedValue(new Error('network down'));
      await expect(oxy.getPublicCard('user-123')).rejects.toThrow();
    });
  });

  describe('verifyPublicCardAttestation (pure helper)', () => {
    it('verifies a genuine signature regardless of wire key order', async () => {
      const { attestation } = await signCard(baseCard);
      // A re-keyed object (different insertion order) must canonicalize identically.
      const reordered: PublicCard = {
        issuedAt: baseCard.issuedAt,
        credentialBadges: baseCard.credentialBadges,
        verifiedDomains: baseCard.verifiedDomains,
        personhoodStatus: baseCard.personhoodStatus,
        trustTier: baseCard.trustTier,
        avatarUrl: baseCard.avatarUrl,
        username: baseCard.username,
        name: baseCard.name,
        userId: baseCard.userId,
        did: baseCard.did,
      };
      await expect(verifyPublicCardAttestation(reordered, attestation)).resolves.toBe(true);
    });

    it('returns false for a null attestation', async () => {
      await expect(verifyPublicCardAttestation(baseCard, null)).resolves.toBe(false);
    });

    it('returns false when signature or publicKey is empty', async () => {
      const empty: ExportAttestation = {
        issuer: 'did:web:api.oxy.so',
        publicKey: '',
        alg: 'ES256K-DER-SHA256',
        signature: '',
        signedAt: 1,
      };
      await expect(verifyPublicCardAttestation(baseCard, empty)).resolves.toBe(false);
    });
  });

  describe('getMyIdPayload', () => {
    it('builds oxycommons://card?did=<did>&v=1 for the current user', () => {
      expect(oxy.getMyIdPayload()).toBe('oxycommons://card?did=did:web:oxy.so:u:user-123&v=1');
    });

    it('throws when no user is authenticated', () => {
      jest.spyOn(oxy, 'getCurrentUserId').mockReturnValue(null);
      expect(() => oxy.getMyIdPayload()).toThrow(/No authenticated user/);
    });
  });

  describe('parseIdPayload', () => {
    it('round-trips the payload getMyIdPayload produces', () => {
      const payload = oxy.getMyIdPayload();
      expect(parseIdPayload(payload)).toEqual({ did: 'did:web:oxy.so:u:user-123' });
    });

    it('parses a percent-encoded DID', () => {
      const payload = 'oxycommons://card?did=did%3Aweb%3Aoxy.so%3Au%3A42&v=1';
      expect(parseIdPayload(payload)).toEqual({ did: 'did:web:oxy.so:u:42' });
    });

    it('tolerates a trailing slash before the query', () => {
      expect(parseIdPayload('oxycommons://card/?did=did:web:oxy.so:u:7')).toEqual({
        did: 'did:web:oxy.so:u:7',
      });
    });

    it('rejects a non-card scheme', () => {
      expect(parseIdPayload('https://evil.example/card?did=did:web:oxy.so:u:1')).toBeNull();
      expect(parseIdPayload('oxycommons://approve?did=did:web:oxy.so:u:1')).toBeNull();
      expect(parseIdPayload('oxycommons://attest?did=did:web:oxy.so:u:1')).toBeNull();
    });

    it('rejects a card payload with no did', () => {
      expect(parseIdPayload('oxycommons://card?v=1')).toBeNull();
      expect(parseIdPayload('oxycommons://card')).toBeNull();
    });

    it('rejects empty / non-string input', () => {
      expect(parseIdPayload('')).toBeNull();
      expect(parseIdPayload('   ')).toBeNull();
      // Exercise the runtime guard for non-string callers (JS callers / scanners
      // can pass anything) without an `as any` cast or a ts-ignore directive.
      const notAString: unknown = undefined;
      expect(parseIdPayload(notAString as string)).toBeNull();
    });
  });

  // ===========================================================================
  // FASE 2 — real-life attestation
  // ===========================================================================

  describe('buildAttestQrPayload', () => {
    it('builds oxycommons://attest with a fresh nonce + 10-min exp for the current user', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
      jest.spyOn(SignatureService, 'generateChallenge').mockResolvedValue('deadbeefnonce');

      const result = await oxy.buildAttestQrPayload({ context: 'payment-42' });

      expect(result.nonce).toBe('deadbeefnonce');
      expect(result.exp).toBe(1700000000000 + 10 * 60 * 1000);
      expect(result.payload).toBe(
        'oxycommons://attest?subject=did:web:oxy.so:u:user-123&ctx=payment-42&nonce=deadbeefnonce&exp=1700000600000',
      );
    });

    it('URL-encodes the context so a space / & cannot break the query', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
      jest.spyOn(SignatureService, 'generateChallenge').mockResolvedValue('n1');

      const result = await oxy.buildAttestQrPayload({ context: 'a b&c' });

      expect(result.payload).toContain('&ctx=a%20b%26c&');
      // And it must round-trip back to the original context.
      expect(parseAttestPayload(result.payload)?.context).toBe('a b&c');
    });

    it('throws when no user is authenticated', async () => {
      jest.spyOn(oxy, 'getCurrentUserId').mockReturnValue(null);
      await expect(oxy.buildAttestQrPayload({ context: 'x' })).rejects.toThrow(/No authenticated user/);
    });
  });

  describe('parseAttestPayload', () => {
    it('round-trips a payload built by buildAttestQrPayload', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
      jest.spyOn(SignatureService, 'generateChallenge').mockResolvedValue('abc123');
      const { payload } = await oxy.buildAttestQrPayload({ context: 'ctx-1' });

      expect(parseAttestPayload(payload)).toEqual({
        subjectDid: 'did:web:oxy.so:u:user-123',
        context: 'ctx-1',
        nonce: 'abc123',
        exp: 1700000600000,
      });
    });

    it('defaults context to "" when ctx is omitted', () => {
      expect(parseAttestPayload('oxycommons://attest?subject=did:web:oxy.so:u:7&nonce=n&exp=123')).toEqual({
        subjectDid: 'did:web:oxy.so:u:7',
        context: '',
        nonce: 'n',
        exp: 123,
      });
    });

    it('rejects a non-attest scheme, missing fields, and a bad exp', () => {
      expect(parseAttestPayload('oxycommons://card?did=did:web:oxy.so:u:1')).toBeNull();
      expect(parseAttestPayload('oxycommons://attest?subject=did:web:oxy.so:u:1&exp=1')).toBeNull(); // no nonce
      expect(parseAttestPayload('oxycommons://attest?nonce=n&exp=1')).toBeNull(); // no subject
      expect(parseAttestPayload('oxycommons://attest?subject=d&nonce=n')).toBeNull(); // no exp
      expect(parseAttestPayload('oxycommons://attest?subject=d&nonce=n&exp=notnum')).toBeNull();
      expect(parseAttestPayload('')).toBeNull();
    });
  });

  describe('submitRealLifeAttestation', () => {
    it('signs a self-issued v2 envelope (about=subjectDid) on the caller chain and POSTs it', async () => {
      const signedEnvelope: SignedRecordEnvelope = {
        version: 2,
        type: 'real_life_attestation',
        subject: 'did:web:oxy.so:u:user-123',
        issuer: 'did:web:oxy.so:u:user-123',
        record: {},
        issuedAt: 1700000000000,
        seq: 4,
        prev: 'rec-3',
        collection: 'app.oxy.attestation',
        rkey: 'nonce-xyz',
        publicKey: 'pub',
        alg: 'ES256K-DER-SHA256',
        signature: 'sig',
      };
      const signV2Spy = jest
        .spyOn(SignatureService, 'signRecordV2')
        .mockResolvedValue(signedEnvelope);
      // 1st makeRequest = chain head; 2nd = POST result.
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: 'rec-3', seq: 3, recordCount: 4 })
        .mockResolvedValueOnce({
          accepted: true,
          recordId: 'rec-4',
          subjectUserId: 'subject-1',
          attestorUserId: 'user-123',
          points: 25,
        });

      const result = await oxy.submitRealLifeAttestation({
        subjectDid: 'did:web:oxy.so:u:subject-1',
        context: 'payment-42',
        nonce: 'nonce-xyz',
        exp: 1700000600000,
        geohash: 'u4pruyd',
        biometricOk: true,
      });

      // Fetched the caller's chain head first (uncached).
      expect(makeRequestSpy).toHaveBeenNthCalledWith(
        1,
        'GET',
        '/identity/records/user-123/chain/head',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      // Signed a self-issued v2 record: about=subjectDid, seq=head+1, prev=head id,
      // collection app.oxy.attestation, rkey=nonce.
      expect(signV2Spy).toHaveBeenCalledWith(
        'real_life_attestation',
        'did:web:oxy.so:u:user-123',
        {
          about: 'did:web:oxy.so:u:subject-1',
          context: 'payment-42',
          nonce: 'nonce-xyz',
          exp: 1700000600000,
          geohash: 'u4pruyd',
          biometricOk: true,
        },
        { seq: 4, prev: 'rec-3', collection: 'app.oxy.attestation', rkey: 'nonce-xyz' },
      );
      // POSTed the signed envelope to /civic/attestations.
      expect(makeRequestSpy).toHaveBeenNthCalledWith(
        2,
        'POST',
        '/civic/attestations',
        signedEnvelope,
        expect.objectContaining({ cache: false }),
      );
      expect(result.points).toBe(25);
      expect(result.subjectUserId).toBe('subject-1');
    });

    it('omits optional record keys (geohash/biometricOk) when not provided', async () => {
      const signV2Spy = jest
        .spyOn(SignatureService, 'signRecordV2')
        .mockResolvedValue({} as SignedRecordEnvelope);
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: null, seq: -1, recordCount: 0 })
        .mockResolvedValueOnce({ accepted: true, recordId: 'r', subjectUserId: 's', attestorUserId: 'user-123', points: 25 });

      await oxy.submitRealLifeAttestation({
        subjectDid: 'did:web:oxy.so:u:s',
        context: 'c',
        nonce: 'n',
        exp: 1700000600000,
      });

      // Genesis chain coords (no head yet) + a record with ONLY the required keys.
      expect(signV2Spy).toHaveBeenCalledWith(
        'real_life_attestation',
        'did:web:oxy.so:u:user-123',
        { about: 'did:web:oxy.so:u:s', context: 'c', nonce: 'n', exp: 1700000600000 },
        { seq: 0, prev: null, collection: 'app.oxy.attestation', rkey: 'n' },
      );
    });

    it('throws when no user is authenticated (before any network)', async () => {
      jest.spyOn(oxy, 'getCurrentUserId').mockReturnValue(null);
      await expect(
        oxy.submitRealLifeAttestation({ subjectDid: 'd', context: 'c', nonce: 'n', exp: 1 }),
      ).rejects.toThrow(/No authenticated user/);
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // FASE 2 — validator / jury
  // ===========================================================================

  describe('getValidatorInbox', () => {
    it('GETs the inbox (uncached) and unwraps requests', async () => {
      const request = {
        id: 'req-1',
        subjectUserId: 'subject-1',
        actionType: 'event_check_in',
        payload: { foo: 'bar' },
        payloadHash: 'hash-1',
        status: 'pending' as const,
        highValue: false,
        expiresAt: '2026-06-27T00:00:00.000Z',
      };
      makeRequestSpy.mockResolvedValue({ requests: [request] });

      const result = await oxy.getValidatorInbox();

      expect(result).toEqual([request]);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/civic/validations/inbox',
        undefined,
        expect.objectContaining({ cache: false }),
      );
    });

    it('defaults to an empty array when requests is absent', async () => {
      makeRequestSpy.mockResolvedValue({});
      await expect(oxy.getValidatorInbox()).resolves.toEqual([]);
    });
  });

  describe('submitValidationVote', () => {
    it('signs a self-issued verdict envelope bound to requestId+payloadHash and POSTs it', async () => {
      const signedEnvelope: SignedRecordEnvelope = {
        version: 2,
        type: 'validation_verdict',
        subject: 'did:web:oxy.so:u:user-123',
        issuer: 'did:web:oxy.so:u:user-123',
        record: { requestId: 'req-1', payloadHash: 'hash-1', verdict: 'valid' },
        issuedAt: 1700000000000,
        seq: 1,
        prev: 'rec-0',
        collection: 'app.oxy.validation',
        rkey: 'req-1',
        publicKey: 'pub',
        alg: 'ES256K-DER-SHA256',
        signature: 'sig',
      };
      const signV2Spy = jest
        .spyOn(SignatureService, 'signRecordV2')
        .mockResolvedValue(signedEnvelope);
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: 'rec-0', seq: 0, recordCount: 1 })
        .mockResolvedValueOnce({ recorded: true, requestId: 'req-1', verdict: 'valid', status: 'quorum_met' });

      const result = await oxy.submitValidationVote('req-1', 'hash-1', 'valid');

      expect(signV2Spy).toHaveBeenCalledWith(
        'validation_verdict',
        'did:web:oxy.so:u:user-123',
        { requestId: 'req-1', payloadHash: 'hash-1', verdict: 'valid' },
        { seq: 1, prev: 'rec-0', collection: 'app.oxy.validation', rkey: 'req-1' },
      );
      expect(makeRequestSpy).toHaveBeenNthCalledWith(
        2,
        'POST',
        '/civic/validations/req-1/vote',
        signedEnvelope,
        expect.objectContaining({ cache: false }),
      );
      expect(result).toEqual({ recorded: true, requestId: 'req-1', verdict: 'valid', status: 'quorum_met' });
    });

    it('throws when no user is authenticated (before any network)', async () => {
      jest.spyOn(oxy, 'getCurrentUserId').mockReturnValue(null);
      await expect(oxy.submitValidationVote('req-1', 'hash-1', 'invalid')).rejects.toThrow(
        /No authenticated user/,
      );
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });
  });

  describe('denyValidation', () => {
    it('POSTs /civic/validations/:id/deny and returns the verdict', async () => {
      makeRequestSpy.mockResolvedValue({ denied: true });

      const result = await oxy.denyValidation('req-9');

      expect(result).toEqual({ denied: true });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/civic/validations/req-9/deny',
        undefined,
        expect.objectContaining({ cache: false }),
      );
    });
  });

  // ===========================================================================
  // FASE 3 — proof-of-personhood web-of-trust (staked vouch)
  // ===========================================================================

  describe('vouchForPerson', () => {
    it('signs a self-issued v2 vouch envelope (about=subjectDid, stake) on the caller chain and POSTs it', async () => {
      const signedEnvelope: SignedRecordEnvelope = {
        version: 2,
        type: 'personhood_vouch',
        subject: 'did:web:oxy.so:u:user-123',
        issuer: 'did:web:oxy.so:u:user-123',
        record: { about: 'did:web:oxy.so:u:subject-1', stake: 5, biometricOk: true },
        issuedAt: 1700000000000,
        seq: 4,
        prev: 'rec-3',
        collection: 'app.oxy.vouch',
        rkey: 'did:web:oxy.so:u:subject-1',
        publicKey: 'pub',
        alg: 'ES256K-DER-SHA256',
        signature: 'sig',
      };
      const signV2Spy = jest
        .spyOn(SignatureService, 'signRecordV2')
        .mockResolvedValue(signedEnvelope);
      // 1st makeRequest = chain head; 2nd = POST result.
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: 'rec-3', seq: 3, recordCount: 4 })
        .mockResolvedValueOnce({
          accepted: true,
          recordId: 'rec-4',
          subjectUserId: 'subject-1',
          voucherUserId: 'user-123',
          stakeAmount: 5,
          points: 30,
        });

      const result = await oxy.vouchForPerson({
        subjectDid: 'did:web:oxy.so:u:subject-1',
        stakeAmount: 5,
        biometricOk: true,
      });

      // Fetched the caller's chain head first (uncached).
      expect(makeRequestSpy).toHaveBeenNthCalledWith(
        1,
        'GET',
        '/identity/records/user-123/chain/head',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      // Signed a self-issued v2 record: about=subjectDid, stake=stakeAmount, seq=head+1,
      // prev=head id, collection app.oxy.vouch, rkey=subjectDid.
      expect(signV2Spy).toHaveBeenCalledWith(
        'personhood_vouch',
        'did:web:oxy.so:u:user-123',
        { about: 'did:web:oxy.so:u:subject-1', stake: 5, biometricOk: true },
        { seq: 4, prev: 'rec-3', collection: 'app.oxy.vouch', rkey: 'did:web:oxy.so:u:subject-1' },
      );
      // POSTed the signed envelope to /civic/personhood/vouch.
      expect(makeRequestSpy).toHaveBeenNthCalledWith(
        2,
        'POST',
        '/civic/personhood/vouch',
        signedEnvelope,
        expect.objectContaining({ cache: false }),
      );
      expect(result.stakeAmount).toBe(5);
      expect(result.subjectUserId).toBe('subject-1');
      expect(result.points).toBe(30);
    });

    it('omits the optional stake/biometricOk record keys when not provided', async () => {
      const signV2Spy = jest
        .spyOn(SignatureService, 'signRecordV2')
        .mockResolvedValue({} as SignedRecordEnvelope);
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: null, seq: -1, recordCount: 0 })
        .mockResolvedValueOnce({
          accepted: true,
          recordId: 'r',
          subjectUserId: 's',
          voucherUserId: 'user-123',
          stakeAmount: 10,
          points: 30,
        });

      await oxy.vouchForPerson({ subjectDid: 'did:web:oxy.so:u:s' });

      // Genesis chain coords (no head yet) + a record with ONLY `about`.
      expect(signV2Spy).toHaveBeenCalledWith(
        'personhood_vouch',
        'did:web:oxy.so:u:user-123',
        { about: 'did:web:oxy.so:u:s' },
        { seq: 0, prev: null, collection: 'app.oxy.vouch', rkey: 'did:web:oxy.so:u:s' },
      );
    });

    it('sweeps the personhood + /users/me GET caches after a successful vouch', async () => {
      jest.spyOn(SignatureService, 'signRecordV2').mockResolvedValue({} as SignedRecordEnvelope);
      const sweepSpy = jest.spyOn(oxy, 'clearCacheByPrefix').mockReturnValue(0);
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: null, seq: -1, recordCount: 0 })
        .mockResolvedValueOnce({
          accepted: true,
          recordId: 'r',
          subjectUserId: 's',
          voucherUserId: 'user-123',
          stakeAmount: 10,
          points: 30,
        });

      await oxy.vouchForPerson({ subjectDid: 'did:web:oxy.so:u:s' });

      expect(sweepSpy).toHaveBeenCalledWith('GET:/civic/personhood/');
      expect(sweepSpy).toHaveBeenCalledWith('GET:/users/me');
    });

    it('does NOT sweep caches when the POST fails', async () => {
      jest.spyOn(SignatureService, 'signRecordV2').mockResolvedValue({} as SignedRecordEnvelope);
      const sweepSpy = jest.spyOn(oxy, 'clearCacheByPrefix').mockReturnValue(0);
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: null, seq: -1, recordCount: 0 })
        .mockRejectedValueOnce(new Error('already_vouched'));

      await expect(oxy.vouchForPerson({ subjectDid: 'did:web:oxy.so:u:s' })).rejects.toThrow();
      expect(sweepSpy).not.toHaveBeenCalled();
    });

    it('throws when no user is authenticated (before any network)', async () => {
      jest.spyOn(oxy, 'getCurrentUserId').mockReturnValue(null);
      await expect(oxy.vouchForPerson({ subjectDid: 'did:web:oxy.so:u:s' })).rejects.toThrow(
        /No authenticated user/,
      );
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });
  });

  describe('withdrawVouch', () => {
    it('DELETEs /civic/personhood/vouch/:subjectUserId and sweeps caches', async () => {
      const sweepSpy = jest.spyOn(oxy, 'clearCacheByPrefix').mockReturnValue(0);
      makeRequestSpy.mockResolvedValue({ withdrawn: true });

      const result = await oxy.withdrawVouch('subject-1');

      expect(result).toEqual({ withdrawn: true });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'DELETE',
        '/civic/personhood/vouch/subject-1',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(sweepSpy).toHaveBeenCalledWith('GET:/civic/personhood/');
      expect(sweepSpy).toHaveBeenCalledWith('GET:/users/me');
    });

    it('URL-encodes the subjectUserId path segment', async () => {
      jest.spyOn(oxy, 'clearCacheByPrefix').mockReturnValue(0);
      makeRequestSpy.mockResolvedValue({ withdrawn: true });

      await oxy.withdrawVouch('a/b');

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'DELETE',
        '/civic/personhood/vouch/a%2Fb',
        undefined,
        expect.anything(),
      );
    });
  });

  describe('getPersonhood', () => {
    const status = {
      userId: 'subject-1',
      score: 0.82,
      isRealPerson: true,
      vouchCount: 3,
      realLifeCount: 1,
      biometricBound: true,
      sybilPenalty: 0,
      breakdown: {
        vouchSignal: 0.7,
        realLifeSignal: 0.5,
        biometricSignal: 1,
        evidence: 0.82,
        sybilPenalty: 0,
        seed: false,
      },
      updatedAt: '2026-06-27T00:00:00.000Z',
    };

    it('GETs /civic/personhood/:userId (cached) and returns the snapshot', async () => {
      makeRequestSpy.mockResolvedValue(status);

      const result = await oxy.getPersonhood('subject-1');

      expect(result).toEqual(status);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/civic/personhood/subject-1',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('URL-encodes the userId path segment', async () => {
      makeRequestSpy.mockResolvedValue(status);
      await oxy.getPersonhood('a/b');
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/civic/personhood/a%2Fb',
        undefined,
        expect.anything(),
      );
    });
  });

  describe('getMyPersonhood', () => {
    it('GETs the current user id', async () => {
      makeRequestSpy.mockResolvedValue({
        userId: 'user-123',
        score: 0,
        isRealPerson: false,
        vouchCount: 0,
        realLifeCount: 0,
        biometricBound: false,
        sybilPenalty: 0,
        breakdown: null,
        updatedAt: null,
      });

      const result = await oxy.getMyPersonhood();

      expect(result.userId).toBe('user-123');
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/civic/personhood/user-123',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('throws when no user is authenticated (before any network)', async () => {
      jest.spyOn(oxy, 'getCurrentUserId').mockReturnValue(null);
      await expect(oxy.getMyPersonhood()).rejects.toThrow(/No authenticated user/);
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // FASE 4 — verifiable credentials
  // ===========================================================================

  describe('issueCredential', () => {
    const credentialResponse: VerifiableCredentialResponse = {
      id: 'cred-1',
      recordId: 'rec-4',
      holderUserId: 'holder-1',
      holderDid: 'did:web:oxy.so:u:holder-1',
      issuerUserId: 'user-123',
      issuerDid: 'did:web:oxy.so:u:user-123',
      types: ['VerifiableCredential', 'EmploymentCredential'],
      claims: { role: 'Engineer' },
      status: 'active',
      issuedAt: 1700000000000,
    };

    it('prepends the base type, signs a self-issued v2 record on the caller chain and POSTs it', async () => {
      const signedEnvelope: SignedRecordEnvelope = {
        version: 2,
        type: 'credential',
        subject: 'did:web:oxy.so:u:user-123',
        issuer: 'did:web:oxy.so:u:user-123',
        record: {
          about: 'did:web:oxy.so:u:holder-1',
          types: ['VerifiableCredential', 'EmploymentCredential'],
          claims: { role: 'Engineer' },
        },
        issuedAt: 1700000000000,
        seq: 4,
        prev: 'rec-3',
        collection: 'app.oxy.credential',
        rkey: 'cred-rkey-1',
        publicKey: 'pub',
        alg: 'ES256K-DER-SHA256',
        signature: 'sig',
      };
      const signV2Spy = jest
        .spyOn(SignatureService, 'signRecordV2')
        .mockResolvedValue(signedEnvelope);
      jest.spyOn(SignatureService, 'generateChallenge').mockResolvedValue('cred-rkey-1');
      const sweepSpy = jest.spyOn(oxy, 'clearCacheByPrefix').mockReturnValue(0);
      // 1st makeRequest = chain head; 2nd = POST result.
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: 'rec-3', seq: 3, recordCount: 4 })
        .mockResolvedValueOnce({ accepted: true, credential: credentialResponse });

      const result = await oxy.issueCredential({
        holderDid: 'did:web:oxy.so:u:holder-1',
        types: ['EmploymentCredential'],
        claims: { role: 'Engineer' },
      });

      // Fetched the caller's chain head first (uncached).
      expect(makeRequestSpy).toHaveBeenNthCalledWith(
        1,
        'GET',
        '/identity/records/user-123/chain/head',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      // Signed a self-issued v2 record: about=holderDid, base type PREPENDED,
      // claims verbatim, seq=head+1, prev=head id, collection app.oxy.credential,
      // rkey=fresh nonce.
      expect(signV2Spy).toHaveBeenCalledWith(
        'credential',
        'did:web:oxy.so:u:user-123',
        {
          about: 'did:web:oxy.so:u:holder-1',
          types: ['VerifiableCredential', 'EmploymentCredential'],
          claims: { role: 'Engineer' },
        },
        { seq: 4, prev: 'rec-3', collection: 'app.oxy.credential', rkey: 'cred-rkey-1' },
      );
      // POSTed the signed envelope to /civic/credentials.
      expect(makeRequestSpy).toHaveBeenNthCalledWith(
        2,
        'POST',
        '/civic/credentials',
        signedEnvelope,
        expect.objectContaining({ cache: false }),
      );
      // Swept the credential GET caches.
      expect(sweepSpy).toHaveBeenCalledWith('GET:/civic/credentials/');
      expect(result).toEqual({ accepted: true, credential: credentialResponse });
    });

    it('does NOT duplicate the base type when the caller already includes it', async () => {
      const signV2Spy = jest
        .spyOn(SignatureService, 'signRecordV2')
        .mockResolvedValue({} as SignedRecordEnvelope);
      jest.spyOn(SignatureService, 'generateChallenge').mockResolvedValue('rk');
      jest.spyOn(oxy, 'clearCacheByPrefix').mockReturnValue(0);
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: null, seq: -1, recordCount: 0 })
        .mockResolvedValueOnce({ accepted: true, credential: credentialResponse });

      await oxy.issueCredential({
        holderDid: 'did:web:oxy.so:u:holder-1',
        types: ['VerifiableCredential', 'CourseCredential'],
        claims: {},
      });

      // Genesis chain coords + the types passed through unchanged (no duplicate base).
      expect(signV2Spy).toHaveBeenCalledWith(
        'credential',
        'did:web:oxy.so:u:user-123',
        {
          about: 'did:web:oxy.so:u:holder-1',
          types: ['VerifiableCredential', 'CourseCredential'],
          claims: {},
        },
        { seq: 0, prev: null, collection: 'app.oxy.credential', rkey: 'rk' },
      );
    });

    it('converts an ISO expiresAt to epoch ms in the signed record', async () => {
      const signV2Spy = jest
        .spyOn(SignatureService, 'signRecordV2')
        .mockResolvedValue({} as SignedRecordEnvelope);
      jest.spyOn(SignatureService, 'generateChallenge').mockResolvedValue('rk');
      jest.spyOn(oxy, 'clearCacheByPrefix').mockReturnValue(0);
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: null, seq: -1, recordCount: 0 })
        .mockResolvedValueOnce({ accepted: true, credential: credentialResponse });

      await oxy.issueCredential({
        holderDid: 'did:web:oxy.so:u:holder-1',
        types: ['EmploymentCredential'],
        claims: { role: 'Engineer' },
        expiresAt: '2030-01-01T00:00:00.000Z',
      });

      expect(signV2Spy).toHaveBeenCalledWith(
        'credential',
        'did:web:oxy.so:u:user-123',
        {
          about: 'did:web:oxy.so:u:holder-1',
          types: ['VerifiableCredential', 'EmploymentCredential'],
          claims: { role: 'Engineer' },
          expiresAt: Date.parse('2030-01-01T00:00:00.000Z'),
        },
        { seq: 0, prev: null, collection: 'app.oxy.credential', rkey: 'rk' },
      );
    });

    it('throws on an unparseable expiresAt (before any signing or network)', async () => {
      const signV2Spy = jest.spyOn(SignatureService, 'signRecordV2');
      jest.spyOn(SignatureService, 'generateChallenge').mockResolvedValue('rk');

      await expect(
        oxy.issueCredential({
          holderDid: 'did:web:oxy.so:u:holder-1',
          types: ['EmploymentCredential'],
          claims: {},
          expiresAt: 'not-a-date',
        }),
      ).rejects.toThrow(/Invalid expiresAt/);
      expect(signV2Spy).not.toHaveBeenCalled();
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });

    it('does NOT sweep caches when the POST fails', async () => {
      jest.spyOn(SignatureService, 'signRecordV2').mockResolvedValue({} as SignedRecordEnvelope);
      jest.spyOn(SignatureService, 'generateChallenge').mockResolvedValue('rk');
      const sweepSpy = jest.spyOn(oxy, 'clearCacheByPrefix').mockReturnValue(0);
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: null, seq: -1, recordCount: 0 })
        .mockRejectedValueOnce(new Error('self_credential'));

      await expect(
        oxy.issueCredential({ holderDid: 'did:web:oxy.so:u:holder-1', types: ['X'], claims: {} }),
      ).rejects.toThrow();
      expect(sweepSpy).not.toHaveBeenCalled();
    });

    it('throws when no user is authenticated (before any network)', async () => {
      jest.spyOn(oxy, 'getCurrentUserId').mockReturnValue(null);
      jest.spyOn(SignatureService, 'generateChallenge').mockResolvedValue('rk');
      await expect(
        oxy.issueCredential({ holderDid: 'did:web:oxy.so:u:holder-1', types: ['X'], claims: {} }),
      ).rejects.toThrow(/No authenticated user/);
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });
  });

  describe('listCredentials', () => {
    const listResult = { credentials: [] };

    it('GETs /civic/credentials/:holderUserId (cached) with no status filter', async () => {
      makeRequestSpy.mockResolvedValue(listResult);

      const result = await oxy.listCredentials('holder-1');

      expect(result).toEqual(listResult);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/civic/credentials/holder-1',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('appends the ?status= filter when provided', async () => {
      makeRequestSpy.mockResolvedValue(listResult);

      await oxy.listCredentials('holder-1', { status: 'revoked' });

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/civic/credentials/holder-1?status=revoked',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('URL-encodes the holderUserId path segment', async () => {
      makeRequestSpy.mockResolvedValue(listResult);
      await oxy.listCredentials('a/b');
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/civic/credentials/a%2Fb',
        undefined,
        expect.anything(),
      );
    });
  });

  describe('listMyCredentials', () => {
    it('lists the current user id, forwarding the status filter', async () => {
      makeRequestSpy.mockResolvedValue({ credentials: [] });

      await oxy.listMyCredentials({ status: 'active' });

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/civic/credentials/user-123?status=active',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('throws when no user is authenticated (before any network)', async () => {
      jest.spyOn(oxy, 'getCurrentUserId').mockReturnValue(null);
      await expect(oxy.listMyCredentials()).rejects.toThrow(/No authenticated user/);
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });
  });

  describe('verifyCredential', () => {
    it('GETs the by-record verify endpoint (cached) and returns the verdict', async () => {
      const verdict = { valid: true, credential: null };
      makeRequestSpy.mockResolvedValue(verdict);

      const result = await oxy.verifyCredential('rec-4');

      expect(result).toEqual(verdict);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/civic/credentials/by-record/rec-4/verify',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('URL-encodes the recordId path segment', async () => {
      makeRequestSpy.mockResolvedValue({ valid: false, reason: 'not_found', credential: null });
      await oxy.verifyCredential('a/b');
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/civic/credentials/by-record/a%2Fb/verify',
        undefined,
        expect.anything(),
      );
    });
  });

  describe('revokeCredential', () => {
    const credentialResponse: VerifiableCredentialResponse = {
      id: 'cred-1',
      recordId: 'rec-4',
      holderUserId: 'holder-1',
      holderDid: 'did:web:oxy.so:u:holder-1',
      issuerUserId: 'user-123',
      issuerDid: 'did:web:oxy.so:u:user-123',
      types: ['VerifiableCredential', 'EmploymentCredential'],
      claims: {},
      status: 'revoked',
      issuedAt: 1700000000000,
      revokedAt: 1700000600000,
    };

    it('POSTs /civic/credentials/:id/revoke and sweeps caches', async () => {
      const sweepSpy = jest.spyOn(oxy, 'clearCacheByPrefix').mockReturnValue(0);
      makeRequestSpy.mockResolvedValue({ revoked: true, credential: credentialResponse });

      const result = await oxy.revokeCredential('cred-1');

      expect(result).toEqual({ revoked: true, credential: credentialResponse });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/civic/credentials/cred-1/revoke',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(sweepSpy).toHaveBeenCalledWith('GET:/civic/credentials/');
    });

    it('URL-encodes the id path segment', async () => {
      jest.spyOn(oxy, 'clearCacheByPrefix').mockReturnValue(0);
      makeRequestSpy.mockResolvedValue({ revoked: true, credential: credentialResponse });
      await oxy.revokeCredential('a/b');
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/civic/credentials/a%2Fb/revoke',
        undefined,
        expect.anything(),
      );
    });

    it('does NOT sweep caches when the POST fails', async () => {
      const sweepSpy = jest.spyOn(oxy, 'clearCacheByPrefix').mockReturnValue(0);
      makeRequestSpy.mockRejectedValue(new Error('not_issuer'));

      await expect(oxy.revokeCredential('cred-1')).rejects.toThrow();
      expect(sweepSpy).not.toHaveBeenCalled();
    });
  });
});
