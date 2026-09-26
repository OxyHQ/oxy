/**
 * Identity Mixin tests.
 *
 * Stubs `makeRequest` so the tests run with no network. We assert request shape
 * (method, URL, body, cache options), response unwrapping, the DID derivation,
 * and the cache sweep on every mutation.
 */

import type { AuthMethodsResponse, DidDocument, VerifiedDomain } from '@oxy.so/contracts';
import { OxyServices } from '../../OxyServices';

/** Route `invalidateCache` into per-key / per-prefix mocks (one pair per client). */
const cacheSpyMap = new WeakMap<OxyServices, { keys: jest.Mock; prefixes: jest.Mock }>();
function cacheSpies(client: OxyServices): { keys: jest.Mock; prefixes: jest.Mock } {
  let spies = cacheSpyMap.get(client);
  if (!spies) {
    const created = { keys: jest.fn(), prefixes: jest.fn() };
    jest.spyOn(client.http, 'invalidateCache').mockImplementation(({ keys = [], prefixes = [] }) => {
      for (const key of keys) created.keys(key);
      for (const prefix of prefixes) created.prefixes(prefix);
      return 0;
    });
    cacheSpyMap.set(client, created);
    spies = created;
  }
  return spies;
}

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

const domainFixture: VerifiedDomain = {
  domain: 'nate.com',
  verifiedAt: '2026-06-26T00:00:00.000Z',
  method: 'dns-txt',
};

describe('oxy.identity', () => {
  let oxy: OxyServices;
  let makeRequestSpy: jest.SpyInstance;
  let clearPrefixSpy: jest.SpyInstance;
  let clearEntrySpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequestSpy = jest.spyOn(oxy, 'request');
    clearPrefixSpy = cacheSpies(oxy).prefixes;
    clearEntrySpy = cacheSpies(oxy).keys;
    jest.spyOn(oxy.session, 'userId', 'get').mockReturnValue('user-123');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('resolveDid', () => {
    it('GETs the DID document and caches the read', async () => {
      makeRequestSpy.mockResolvedValue(didDocFixture);

      const result = await oxy.identity.resolveDid('user-123');

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
      await oxy.identity.resolveDid('a/b');
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/u/a%2Fb/did.json',
        undefined,
        expect.anything(),
      );
    });
  });

  describe('did', () => {
    it('derives the current user DID', () => {
      expect(oxy.identity.did).toBe('did:web:oxy.so:u:user-123');
    });

    it('throws when no user is authenticated', () => {
      jest.spyOn(oxy.session, 'userId', 'get').mockReturnValue(null);
      expect(() => oxy.identity.did).toThrow(/No authenticated user/);
    });
  });

  describe('listAuthMethods', () => {
    it('GETs /auth/methods', async () => {
      makeRequestSpy.mockResolvedValue(authMethodsFixture);
      const result = await oxy.identity.authMethods();
      expect(result).toEqual(authMethodsFixture);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/auth/methods',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });
  });

  describe('exportMyData', () => {
    it('GETs /users/me/export without caching', async () => {
      const bundle = { $schema: 'x', did: 'did:web:oxy.so:u:user-123' };
      makeRequestSpy.mockResolvedValue(bundle);
      const result = await oxy.identity.export();
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

      const result = await oxy.identity.domains.requestVerification('nate.com');

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

      await oxy.identity.domains.verify('nate.com');

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
      const result = await oxy.identity.domains.list();
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
      await expect(oxy.identity.domains.list()).resolves.toEqual([]);
    });

    it('removeDomain DELETEs and sweeps cache', async () => {
      makeRequestSpy.mockResolvedValue({ success: true });

      await oxy.identity.domains.remove('nate.com');

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
