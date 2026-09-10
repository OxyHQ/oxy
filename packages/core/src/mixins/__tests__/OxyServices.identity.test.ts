/**
 * Identity Mixin tests.
 *
 * Stubs `makeRequest` so the tests run with no network. We assert request shape
 * (method, URL, body, cache options), response unwrapping, the DID derivation,
 * the EXACT signed payload `linkIdentityKey` produces (it must match the
 * server's `JSON.stringify({ action, userId, timestamp })` reconstruction
 * byte-for-byte), and the cache sweep on every mutation.
 */

import type { AuthMethodsResponse, DidDocument, SignedRecordEnvelope, VerifiedDomain } from '@oxy.so/contracts';
import { OxyServices } from '../../OxyServices';
import { KeyManager } from '../../crypto/keyManager';
import { SignatureService } from '../../crypto/signatureService';

const didDocFixture: DidDocument = {
  '@context': ['https://www.w3.org/ns/did/v1'],
  id: 'did:web:oxy.so:u:user-123',
  controller: ['did:web:oxy.so:u:user-123', 'did:web:oxy.so'],
  verificationMethod: [],
  authentication: [],
  assertionMethod: [],
  alsoKnownAs: ['acct:nate@oxy.so'],
  service: [],
};

const authMethodsFixture: AuthMethodsResponse = {
  did: 'did:web:oxy.so:u:user-123',
  methods: [{ type: 'identity', linkedAt: '2026-06-26T00:00:00.000Z', verificationMethodId: '#key-1' }],
};

const recordFixture: SignedRecordEnvelope = {
  version: 1,
  type: 'profile',
  subject: 'did:web:oxy.so:u:user-123',
  issuer: 'did:web:oxy.so:u:user-123',
  record: { displayName: 'Nate' },
  issuedAt: 1700000000000,
  publicKey: 'pub-hex',
  alg: 'ES256K-DER-SHA256',
  signature: 'sig-hex',
};

const domainFixture: VerifiedDomain = {
  domain: 'nate.com',
  verifiedAt: '2026-06-26T00:00:00.000Z',
  method: 'dns-txt',
};

describe('OxyServices.identity', () => {
  let oxy: OxyServices;
  let makeRequestSpy: jest.SpyInstance;
  let clearPrefixSpy: jest.SpyInstance;
  let clearEntrySpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequestSpy = jest.spyOn(oxy, 'makeRequest');
    clearPrefixSpy = jest.spyOn(oxy, 'clearCacheByPrefix').mockReturnValue(0);
    clearEntrySpy = jest.spyOn(oxy, 'clearCacheEntry').mockReturnValue(undefined);
    jest.spyOn(oxy, 'getCurrentUserId').mockReturnValue('user-123');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('resolveDid', () => {
    it('GETs the DID document and caches the read', async () => {
      makeRequestSpy.mockResolvedValue(didDocFixture);

      const result = await oxy.resolveDid('user-123');

      expect(result).toEqual(didDocFixture);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/u/user-123/did.json',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('URL-encodes the userId path segment', async () => {
      makeRequestSpy.mockResolvedValue(didDocFixture);
      await oxy.resolveDid('a/b');
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/u/a%2Fb/did.json',
        undefined,
        expect.anything(),
      );
    });
  });

  describe('getMyDid / getMyDidDocument', () => {
    it('derives the current user DID', () => {
      expect(oxy.getMyDid()).toBe('did:web:oxy.so:u:user-123');
    });

    it('throws when no user is authenticated', () => {
      jest.spyOn(oxy, 'getCurrentUserId').mockReturnValue(null);
      expect(() => oxy.getMyDid()).toThrow(/No authenticated user/);
    });

    it('resolves the current user DID document', async () => {
      makeRequestSpy.mockResolvedValue(didDocFixture);
      const result = await oxy.getMyDidDocument();
      expect(result).toEqual(didDocFixture);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/u/user-123/did.json',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });
  });

  describe('listAuthMethods', () => {
    it('GETs /auth/methods', async () => {
      makeRequestSpy.mockResolvedValue(authMethodsFixture);
      const result = await oxy.listAuthMethods();
      expect(result).toEqual(authMethodsFixture);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/auth/methods',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });
  });

  describe('linkIdentityKey', () => {
    it('signs the exact server-expected payload and POSTs /auth/link', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue('pub-hex');
      const signSpy = jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
      makeRequestSpy.mockResolvedValue({ success: true, message: 'Identity linked successfully' });

      const result = await oxy.linkIdentityKey();

      // The signed message MUST match the server's reconstruction byte-for-byte:
      // JSON.stringify({ action, userId, timestamp }) in that key order.
      const expectedMessage = JSON.stringify({
        action: 'link_identity',
        userId: 'user-123',
        timestamp: 1700000000000,
      });
      expect(signSpy).toHaveBeenCalledWith(expectedMessage);
      expect(expectedMessage).toBe(
        '{"action":"link_identity","userId":"user-123","timestamp":1700000000000}',
      );

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/auth/link',
        { type: 'identity', publicKey: 'pub-hex', signature: 'sig-hex', timestamp: 1700000000000 },
        expect.objectContaining({ cache: false }),
      );
      expect(result).toEqual({ success: true, message: 'Identity linked successfully' });
    });

    it('sweeps /users/me, auth methods, domains and the DID cache after linking', async () => {
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue('pub-hex');
      jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
      makeRequestSpy.mockResolvedValue({ success: true, message: 'ok' });

      await oxy.linkIdentityKey();

      expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/users/me');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/auth/methods');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/identity/domains');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/u/user-123/did.json');
    });

    it('throws (no network) when the device has no identity', async () => {
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(null);
      await expect(oxy.linkIdentityKey()).rejects.toThrow(/No identity found/);
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });

    it('throws when no user is authenticated', async () => {
      jest.spyOn(oxy, 'getCurrentUserId').mockReturnValue(null);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue('pub-hex');
      await expect(oxy.linkIdentityKey()).rejects.toThrow(/No authenticated user/);
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });
  });

  describe('unlinkAuthMethod', () => {
    it('DELETEs /auth/link/:type and sweeps cache', async () => {
      makeRequestSpy.mockResolvedValue({ success: true, message: 'identity auth unlinked successfully' });

      await oxy.unlinkAuthMethod('identity');

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'DELETE',
        '/auth/link/identity',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/u/user-123/did.json');
    });
  });

  describe('removePasskey', () => {
    it('DELETEs /auth/link/webauthn/:credentialID and sweeps cache', async () => {
      makeRequestSpy.mockResolvedValue({ success: true, message: 'Passkey unlinked successfully' });

      await oxy.removePasskey('cred-abc');

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'DELETE',
        '/auth/link/webauthn/cred-abc',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/u/user-123/did.json');
    });

    it('URL-encodes the credential id', async () => {
      makeRequestSpy.mockResolvedValue({ success: true, message: 'Passkey unlinked successfully' });

      await oxy.removePasskey('a/b+c=');

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'DELETE',
        '/auth/link/webauthn/a%2Fb%2Bc%3D',
        undefined,
        expect.objectContaining({ cache: false }),
      );
    });
  });

  describe('signRecord (client-only)', () => {
    it('signs with the current user DID as subject and does not hit the network', async () => {
      const signRecordSpy = jest
        .spyOn(SignatureService, 'signRecord')
        .mockResolvedValue(recordFixture);

      const result = await oxy.signRecord('profile', { displayName: 'Nate' });

      expect(signRecordSpy).toHaveBeenCalledWith('profile', 'did:web:oxy.so:u:user-123', {
        displayName: 'Nate',
      });
      expect(result).toEqual(recordFixture);
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });
  });

  describe('publishRecord', () => {
    it('signs then POSTs the envelope to /identity/records', async () => {
      jest.spyOn(SignatureService, 'signRecord').mockResolvedValue(recordFixture);
      makeRequestSpy.mockResolvedValue({ envelope: recordFixture, verified: true });

      const result = await oxy.publishRecord('profile', { displayName: 'Nate' });

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/identity/records',
        recordFixture,
        expect.objectContaining({ cache: false }),
      );
      expect(result).toEqual({ envelope: recordFixture, verified: true });
    });
  });

  describe('getRecord / verifyRecord', () => {
    it('GETs and unwraps the record', async () => {
      makeRequestSpy.mockResolvedValue({ record: recordFixture });
      const result = await oxy.getRecord('user-123', 'profile');
      expect(result).toEqual(recordFixture);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/identity/records/user-123/profile',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('GETs the verify verdict', async () => {
      makeRequestSpy.mockResolvedValue({ verified: true });
      const result = await oxy.verifyRecord('user-123', 'identity');
      expect(result).toEqual({ verified: true });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/identity/records/user-123/identity/verify',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });
  });

  describe('exportMyData', () => {
    it('GETs /users/me/export without caching', async () => {
      const bundle = { $schema: 'x', did: 'did:web:oxy.so:u:user-123' };
      makeRequestSpy.mockResolvedValue(bundle);
      const result = await oxy.exportMyData();
      expect(result).toEqual(bundle);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/users/me/export',
        undefined,
        expect.objectContaining({ cache: false }),
      );
    });
  });

  describe('domains', () => {
    it('requestDomainVerification POSTs the domain', async () => {
      const instructions = {
        domain: 'nate.com',
        token: 'tok',
        dns: { name: '_oxy-identity.nate.com', value: 'oxy-domain-verification=tok' },
        wellKnown: { url: 'https://nate.com/.well-known/oxy-domain', body: 'tok' },
      };
      makeRequestSpy.mockResolvedValue(instructions);

      const result = await oxy.requestDomainVerification('nate.com');

      expect(result).toEqual(instructions);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/identity/domains',
        { domain: 'nate.com' },
        expect.objectContaining({ cache: false }),
      );
    });

    it('verifyDomain POSTs to the verify path and sweeps cache', async () => {
      makeRequestSpy.mockResolvedValue({ verified: true, domain: domainFixture });

      await oxy.verifyDomain('nate.com');

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/identity/domains/nate.com/verify',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/users/me');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/u/user-123/did.json');
    });

    it('listDomains GETs and unwraps domains', async () => {
      makeRequestSpy.mockResolvedValue({ domains: [domainFixture] });
      const result = await oxy.listDomains();
      expect(result).toEqual([domainFixture]);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/identity/domains',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('listDomains defaults to an empty array when domains is absent', async () => {
      makeRequestSpy.mockResolvedValue({});
      await expect(oxy.listDomains()).resolves.toEqual([]);
    });

    it('removeDomain DELETEs and sweeps cache', async () => {
      makeRequestSpy.mockResolvedValue({ success: true });

      await oxy.removeDomain('nate.com');

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'DELETE',
        '/identity/domains/nate.com',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/users/me');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/u/user-123/did.json');
    });
  });
});
