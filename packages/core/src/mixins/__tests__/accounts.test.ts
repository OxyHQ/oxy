/**
 * Accounts Mixin Tests (unified account graph)
 *
 * Exercises the typed helpers around `/accounts/...`. We stub `makeRequest` so
 * the tests run without a network or a database — what we care about here is
 * request shape (method, URL, query string, body, cache options), response
 * envelope unwrapping (`{ accounts }` / `{ account }` / `{ members }` /
 * `{ member }` / `{ credentials }` / `{ application }` / `{ applications }`),
 * default fallbacks on missing fields, path-segment URL-encoding, and cache
 * invalidation on writes (the `clearCacheEntry` / `clearCacheByPrefix`
 * discipline), covering both the account graph and the applications owned
 * within it.
 */

import { OxyServices } from '../../OxyServices';
import type { User } from '../../models/interfaces';
import type {
  AccountNode,
  AccountMember,
  AccountCredential,
  AccountCredentialWithSecret,
  RotateAccountCredentialResult,
  Application,
  ApplicationCredential,
  ApplicationCredentialWithSecret,
  RotateApplicationCredentialResult,
  ApplicationUsageStats,
  SwitchAccountResult,
} from '../OxyServices.accounts';

const setAccessTokenForTest = (oxy: OxyServices): void => {
  oxy.httpService.setTokens('test-token');
};

const userFixture: User = {
  id: 'acc1',
  publicKey: 'pk-acc1',
  username: 'oxy-org',
  name: { displayName: 'Oxy Org' },
};

const memberFixture: AccountMember = {
  _id: 'm1',
  accountId: 'acc1',
  memberUserId: 'u2',
  role: 'editor',
  permissions: ['account:read', 'apps:read'],
  inherit: true,
  status: 'active',
  source: 'direct',
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
};

const accountNodeFixture: AccountNode = {
  accountId: 'acc1',
  kind: 'organization',
  parentAccountId: 'root1',
  account: userFixture,
  relationship: 'owner',
  callerMembership: { ...memberFixture, role: 'owner', source: 'direct' },
  childCount: 2,
};

const credentialFixture: AccountCredential = {
  _id: 'cred1',
  accountId: 'acc1',
  name: 'bot-prod',
  publicKey: 'oxy_dk_abc',
  type: 'service',
  environment: 'production',
  scopes: ['user:read'],
  status: 'active',
  createdByUserId: 'u1',
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
};

const appFixture: Application = {
  _id: 'app1',
  name: 'Mention',
  type: 'first_party',
  status: 'active',
  isOfficial: true,
  isInternal: false,
  capabilities: [],
  redirectUris: ['https://mention.earth/oauth/callback'],
  scopes: ['profile'],
  createdByUserId: 'u1',
  ownerAccountId: 'acc1',
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
  callerMembership: { ...memberFixture, role: 'admin', source: 'inherited' },
};

const appCredentialFixture: ApplicationCredential = {
  _id: 'appcred1',
  applicationId: 'app1',
  name: 'prod-client',
  publicKey: 'oxy_dk_app',
  type: 'confidential',
  environment: 'production',
  scopes: ['profile'],
  status: 'active',
  createdByUserId: 'u1',
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
};

describe('OxyServices.accounts', () => {
  let oxy: OxyServices;
  let makeRequestSpy: jest.SpyInstance;
  let clearEntrySpy: jest.SpyInstance;
  let clearPrefixSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    setAccessTokenForTest(oxy);
    makeRequestSpy = jest.spyOn(oxy, 'makeRequest');
    clearEntrySpy = jest.spyOn(oxy, 'clearCacheEntry');
    clearPrefixSpy = jest.spyOn(oxy, 'clearCacheByPrefix');
  });

  afterEach(() => {
    makeRequestSpy.mockRestore();
    clearEntrySpy.mockRestore();
    clearPrefixSpy.mockRestore();
  });

  describe('listAccounts', () => {
    it('unwraps the `accounts` array and caches the flat read', async () => {
      makeRequestSpy.mockResolvedValue({ accounts: [accountNodeFixture] });

      const result = await oxy.listAccounts();

      expect(result).toEqual([accountNodeFixture]);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/accounts',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('requests the tree variant as a distinct cache-keyed path', async () => {
      makeRequestSpy.mockResolvedValue({ accounts: [accountNodeFixture] });
      await oxy.listAccounts({ tree: true });
      expect(makeRequestSpy.mock.calls[0][1]).toBe('/accounts?tree=true');
    });

    it('returns an empty array when `accounts` is absent', async () => {
      makeRequestSpy.mockResolvedValue({});
      expect(await oxy.listAccounts()).toEqual([]);
    });
  });

  describe('getAccount', () => {
    it('unwraps the `account` object and caches the read', async () => {
      makeRequestSpy.mockResolvedValue({ account: accountNodeFixture });

      const result = await oxy.getAccount('acc1');

      expect(result).toEqual(accountNodeFixture);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/accounts/acc1',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('URL-encodes the accountId path segment', async () => {
      makeRequestSpy.mockResolvedValue({ account: accountNodeFixture });
      await oxy.getAccount('a b/c');
      expect(makeRequestSpy.mock.calls[0][1]).toBe('/accounts/a%20b%2Fc');
    });
  });

  describe('switchToAccount', () => {
    // Device-first: the switch route registers the switched session in the
    // server-side DeviceSession set directly and returns the fresh access token
    // + the resolved `authuser`. There is NO follow-up POST /auth/session.
    const switchResponse: SwitchAccountResult = {
      sessionId: 'sess_switch',
      deviceId: 'dev_switch',
      expiresAt: '2026-06-30T01:00:00.000Z',
      accessToken: 'access_switch',
      authuser: 1,
      user: { id: 'acc1', username: 'oxy-org', name: { displayName: 'Oxy Org' } },
    };

    const routeByPath = (response = switchResponse) =>
      makeRequestSpy.mockResolvedValue(response);

    it('posts to /:id/switch, plants the token, carries the response authuser, and sweeps the cache', async () => {
      const setTokensSpy = jest.spyOn(oxy, 'setTokens');
      const clearCacheSpy = jest.spyOn(oxy, 'clearCache');
      routeByPath();

      const result = await oxy.switchToAccount('acc1');

      // Switch request shape: POST, exact path, no body, cache disabled.
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/accounts/acc1/switch',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      // No secondary /auth/session establishment — the switch registers the
      // session server-side on its own.
      expect(makeRequestSpy).toHaveBeenCalledTimes(1);

      // The switch token is planted; the cache is swept AFTER planting.
      expect(setTokensSpy).toHaveBeenCalledWith('access_switch');
      expect(oxy.getAccessToken()).toBe('access_switch');
      expect(oxy.hasValidToken()).toBe(true);
      expect(clearCacheSpy).toHaveBeenCalledTimes(1);
      expect(setTokensSpy.mock.invocationCallOrder[0]).toBeLessThan(
        clearCacheSpy.mock.invocationCallOrder[0],
      );

      // The returned session carries the target account (id-normalised) + slot.
      expect(result.sessionId).toBe('sess_switch');
      expect(result.user).toEqual({ id: 'acc1', username: 'oxy-org', name: { displayName: 'Oxy Org' } });
      expect(result.authuser).toBe(1);

      setTokensSpy.mockRestore();
      clearCacheSpy.mockRestore();
    });

    it('URL-encodes the accountId path segment', async () => {
      routeByPath();
      await oxy.switchToAccount('a b/c');
      expect(makeRequestSpy.mock.calls[0][1]).toBe('/accounts/a%20b%2Fc/switch');
    });

    it('omits authuser from the result when the switch response has none', async () => {
      const { authuser, ...noAuthuser } = switchResponse;
      routeByPath(noAuthuser as SwitchAccountResult);

      const result = await oxy.switchToAccount('acc1');

      expect(oxy.getAccessToken()).toBe('access_switch');
      expect(result.authuser).toBeUndefined();
    });

    it('does NOT plant or sweep when the operator is not authorized (403 surfaces via handleError)', async () => {
      const setTokensSpy = jest.spyOn(oxy, 'setTokens');
      const clearCacheSpy = jest.spyOn(oxy, 'clearCache');
      makeRequestSpy.mockRejectedValue(
        Object.assign(new Error('forbidden'), { response: { status: 403 } }),
      );

      await expect(oxy.switchToAccount('acc1')).rejects.toThrow();
      // A failed switch must NOT mutate session state, and must NOT attempt the
      // /auth/session establishment.
      expect(setTokensSpy).not.toHaveBeenCalled();
      expect(clearCacheSpy).not.toHaveBeenCalled();
      expect(makeRequestSpy).not.toHaveBeenCalledWith(
        'POST',
        '/auth/session',
        undefined,
        expect.anything(),
      );

      setTokensSpy.mockRestore();
      clearCacheSpy.mockRestore();
    });
  });

  describe('createAccount', () => {
    it('posts the payload, unwraps `account`, and busts every list', async () => {
      makeRequestSpy.mockResolvedValue({ account: accountNodeFixture });

      const result = await oxy.createAccount({ kind: 'organization', username: 'oxy-org' });

      expect(result).toEqual(accountNodeFixture);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/accounts',
        { kind: 'organization', username: 'oxy-org' },
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts');
      expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/accounts?');
    });
  });

  describe('updateAccount', () => {
    it('patches, unwraps `account`, and busts the detail + lists', async () => {
      makeRequestSpy.mockResolvedValue({ account: accountNodeFixture });

      const result = await oxy.updateAccount('acc1', { bio: 'hello' });

      expect(result).toEqual(accountNodeFixture);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'PATCH',
        '/accounts/acc1',
        { bio: 'hello' },
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts/acc1');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts');
      expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/accounts?');
    });
  });

  describe('archiveAccount', () => {
    it('deletes and busts the detail, members, credentials, and lists', async () => {
      makeRequestSpy.mockResolvedValue({ success: true });

      const result = await oxy.archiveAccount('acc1');

      expect(result).toEqual({ success: true });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'DELETE',
        '/accounts/acc1',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts/acc1');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts/acc1/members');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts/acc1/credentials');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts');
      expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/accounts?');
    });
  });

  describe('listChildAccounts', () => {
    it('unwraps the `accounts` array and caches the read', async () => {
      makeRequestSpy.mockResolvedValue({ accounts: [accountNodeFixture] });

      const result = await oxy.listChildAccounts('acc1');

      expect(result).toEqual([accountNodeFixture]);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/accounts/acc1/children',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('returns an empty array when `accounts` is absent', async () => {
      makeRequestSpy.mockResolvedValue({});
      expect(await oxy.listChildAccounts('acc1')).toEqual([]);
    });
  });

  describe('listAccountMembers', () => {
    it('unwraps the `members` array and caches the read', async () => {
      makeRequestSpy.mockResolvedValue({ members: [memberFixture] });

      const result = await oxy.listAccountMembers('acc1');

      expect(result).toEqual([memberFixture]);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/accounts/acc1/members',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('returns an empty array when `members` is absent', async () => {
      makeRequestSpy.mockResolvedValue({});
      expect(await oxy.listAccountMembers('acc1')).toEqual([]);
    });
  });

  describe('inviteAccountMember', () => {
    it('posts the invite, unwraps `member`, and busts the membership cache', async () => {
      makeRequestSpy.mockResolvedValue({ member: memberFixture });

      const result = await oxy.inviteAccountMember('acc1', {
        usernameOrEmail: 'alice',
        role: 'editor',
      });

      expect(result).toEqual(memberFixture);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/accounts/acc1/members',
        { usernameOrEmail: 'alice', role: 'editor' },
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts/acc1/members');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts/acc1');
      expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/accounts/');
    });
  });

  describe('updateAccountMember', () => {
    it('patches the member, unwraps `member`, encodes ids, and busts membership', async () => {
      makeRequestSpy.mockResolvedValue({ member: memberFixture });

      const result = await oxy.updateAccountMember('acc1', 'm 1', { role: 'admin' });

      expect(result).toEqual(memberFixture);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'PATCH',
        '/accounts/acc1/members/m%201',
        { role: 'admin' },
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts/acc1/members');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts/acc1');
      expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/accounts/');
    });
  });

  describe('removeAccountMember', () => {
    it('deletes the member and busts the membership cache', async () => {
      makeRequestSpy.mockResolvedValue({ success: true });

      const result = await oxy.removeAccountMember('acc1', 'm1');

      expect(result).toEqual({ success: true });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'DELETE',
        '/accounts/acc1/members/m1',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts/acc1/members');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts/acc1');
      expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/accounts/');
    });
  });

  describe('transferAccountOwnership', () => {
    it('posts the transfer and busts both membership and the lists', async () => {
      makeRequestSpy.mockResolvedValue({ success: true });

      const result = await oxy.transferAccountOwnership('acc1', { userId: 'u2' });

      expect(result).toEqual({ success: true });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/accounts/acc1/transfer-ownership',
        { userId: 'u2' },
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts/acc1/members');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts/acc1');
      expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/accounts/');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts');
      expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/accounts?');
    });
  });

  describe('listAccountApps', () => {
    it('queries /applications by ownerAccountId and unwraps `applications`', async () => {
      makeRequestSpy.mockResolvedValue({ applications: [appFixture] });

      const result = await oxy.listAccountApps('acc1');

      expect(result).toEqual([appFixture]);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/applications?ownerAccountId=acc1',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('URL-encodes the ownerAccountId query value', async () => {
      makeRequestSpy.mockResolvedValue({ applications: [] });
      await oxy.listAccountApps('a b/c');
      expect(makeRequestSpy.mock.calls[0][1]).toBe('/applications?ownerAccountId=a%20b%2Fc');
    });

    it('returns an empty array when `applications` is absent', async () => {
      makeRequestSpy.mockResolvedValue({});
      expect(await oxy.listAccountApps('acc1')).toEqual([]);
    });
  });

  describe('listAccountCredentials', () => {
    it('unwraps the `credentials` array and caches the read', async () => {
      makeRequestSpy.mockResolvedValue({ credentials: [credentialFixture] });

      const result = await oxy.listAccountCredentials('acc1');

      expect(result).toEqual([credentialFixture]);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/accounts/acc1/credentials',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('returns an empty array when `credentials` is absent', async () => {
      makeRequestSpy.mockResolvedValue({});
      expect(await oxy.listAccountCredentials('acc1')).toEqual([]);
    });
  });

  describe('createAccountCredential', () => {
    it('posts the config, returns the secret result, and busts the credentials cache', async () => {
      const created: AccountCredentialWithSecret = {
        credential: credentialFixture,
        secret: 'sk_once',
      };
      makeRequestSpy.mockResolvedValue(created);

      const result = await oxy.createAccountCredential('acc1', {
        name: 'bot-prod',
        environment: 'production',
      });

      expect(result).toEqual(created);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/accounts/acc1/credentials',
        { name: 'bot-prod', environment: 'production' },
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts/acc1/credentials');
    });
  });

  describe('rotateAccountCredential', () => {
    it('posts to /rotate, encodes ids, returns the audit result, and busts credentials', async () => {
      const rotated: RotateAccountCredentialResult = {
        credential: { ...credentialFixture, _id: 'cred2' },
        secret: 'sk_new',
        rotatedFrom: 'cred1',
        graceExpiresAt: '2026-07-06T00:00:00.000Z',
      };
      makeRequestSpy.mockResolvedValue(rotated);

      const result = await oxy.rotateAccountCredential('acc1', 'cred 1');

      expect(result).toEqual(rotated);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/accounts/acc1/credentials/cred%201/rotate',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts/acc1/credentials');
    });
  });

  describe('revokeAccountCredential', () => {
    it('deletes the credential and busts the credentials cache', async () => {
      makeRequestSpy.mockResolvedValue({ success: true });

      const result = await oxy.revokeAccountCredential('acc1', 'cred1');

      expect(result).toEqual({ success: true });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'DELETE',
        '/accounts/acc1/credentials/cred1',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/accounts/acc1/credentials');
    });
  });

  describe('createApp', () => {
    it('posts the payload, unwraps `application`, and busts every app list', async () => {
      makeRequestSpy.mockResolvedValue({ application: appFixture });

      const result = await oxy.createApp({ name: 'Mention', ownerAccountId: 'acc1' });

      expect(result).toEqual(appFixture);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/applications',
        { name: 'Mention', ownerAccountId: 'acc1' },
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/applications');
      expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/applications?');
    });
  });

  describe('getApp', () => {
    it('unwraps `application`, encodes the id, and caches the read', async () => {
      makeRequestSpy.mockResolvedValue({ application: appFixture });

      const result = await oxy.getApp('app 1');

      expect(result).toEqual(appFixture);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/applications/app%201',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });
  });

  describe('updateApp', () => {
    it('patches, unwraps `application`, and busts the detail + app lists', async () => {
      makeRequestSpy.mockResolvedValue({ application: appFixture });

      const result = await oxy.updateApp('app1', { description: 'Social' });

      expect(result).toEqual(appFixture);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'PATCH',
        '/applications/app1',
        { description: 'Social' },
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/applications/app1');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/applications');
      expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/applications?');
    });
  });

  describe('deleteApp', () => {
    it('deletes and busts the detail, credentials, and app lists', async () => {
      makeRequestSpy.mockResolvedValue({ success: true });

      const result = await oxy.deleteApp('app1');

      expect(result).toEqual({ success: true });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'DELETE',
        '/applications/app1',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/applications/app1');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/applications/app1/credentials');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/applications');
      expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/applications?');
    });
  });

  describe('listAppCredentials', () => {
    it('unwraps the `credentials` array and caches the read', async () => {
      makeRequestSpy.mockResolvedValue({ credentials: [appCredentialFixture] });

      const result = await oxy.listAppCredentials('app1');

      expect(result).toEqual([appCredentialFixture]);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/applications/app1/credentials',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('returns an empty array when `credentials` is absent', async () => {
      makeRequestSpy.mockResolvedValue({});
      expect(await oxy.listAppCredentials('app1')).toEqual([]);
    });
  });

  describe('createAppCredential', () => {
    it('posts the config, returns the secret result, and busts the credentials cache', async () => {
      const created: ApplicationCredentialWithSecret = {
        credential: appCredentialFixture,
        secret: 'sk_app_once',
      };
      makeRequestSpy.mockResolvedValue(created);

      const result = await oxy.createAppCredential('app1', {
        name: 'prod-client',
        type: 'confidential',
        environment: 'production',
      });

      expect(result).toEqual(created);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/applications/app1/credentials',
        { name: 'prod-client', type: 'confidential', environment: 'production' },
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/applications/app1/credentials');
    });

    it("forwards a machine credential's expiresInSeconds and its one-time token", async () => {
      // A `machine` credential's material arrives in `token`, never `secret` —
      // a surface rendering "the secret" must not silently print an API key.
      const created: ApplicationCredentialWithSecret = {
        credential: { ...appCredentialFixture, type: 'machine', tokenPrefix: 'oxy_sk_0123456789abcdef' },
        secret: null,
        token: 'oxy_sk_0123456789abcdef_' + 'a'.repeat(64),
      };
      makeRequestSpy.mockResolvedValue(created);

      const result = await oxy.createAppCredential('app1', {
        name: 'ci-runner',
        type: 'machine',
        environment: 'production',
        scopes: ['inference:invoke'],
        expiresInSeconds: 86_400,
      });

      expect(result.token).toBe(created.token);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/applications/app1/credentials',
        {
          name: 'ci-runner',
          type: 'machine',
          environment: 'production',
          scopes: ['inference:invoke'],
          expiresInSeconds: 86_400,
        },
        expect.objectContaining({ cache: false }),
      );
    });
  });

  describe('rotateAppCredential', () => {
    it('posts to /rotate, encodes ids, returns the audit result, and busts credentials', async () => {
      const rotated: RotateApplicationCredentialResult = {
        credential: { ...appCredentialFixture, _id: 'appcred2' },
        secret: 'sk_app_new',
        rotatedFrom: 'appcred1',
        graceExpiresAt: '2026-07-06T00:00:00.000Z',
      };
      makeRequestSpy.mockResolvedValue(rotated);

      const result = await oxy.rotateAppCredential('app1', 'appcred 1');

      expect(result).toEqual(rotated);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/applications/app1/credentials/appcred%201/rotate',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/applications/app1/credentials');
    });

    it('forwards an opt-in rotation grace window', async () => {
      // Omitting it (the case above) sends `undefined`, and the server then
      // revokes the superseded machine token immediately. Sending it must reach
      // the body, or a caller asking for zero-downtime rotation would silently
      // get the instant-revoke behaviour instead.
      const rotated: RotateApplicationCredentialResult = {
        credential: { ...appCredentialFixture, _id: 'appcred2', type: 'machine' },
        secret: null,
        token: 'oxy_sk_fedcba9876543210_' + 'b'.repeat(64),
        rotatedFrom: 'appcred1',
        graceExpiresAt: '2026-08-17T00:00:00.000Z',
      };
      makeRequestSpy.mockResolvedValue(rotated);

      await oxy.rotateAppCredential('app1', 'appcred1', { graceSeconds: 3600 });

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/applications/app1/credentials/appcred1/rotate',
        { graceSeconds: 3600 },
        expect.objectContaining({ cache: false }),
      );
    });
  });

  describe('revokeAppCredential', () => {
    it('deletes the credential and busts the credentials cache', async () => {
      makeRequestSpy.mockResolvedValue({ success: true });

      const result = await oxy.revokeAppCredential('app1', 'appcred1');

      expect(result).toEqual({ success: true });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'DELETE',
        '/applications/app1/credentials/appcred1',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/applications/app1/credentials');
    });
  });

  describe('getAppUsage', () => {
    it('passes the period query and caches the read', async () => {
      const usage: ApplicationUsageStats = {
        summary: {
          totalRequests: 10,
          totalTokens: 0,
          totalCredits: 0,
          avgResponseTime: 5,
          successfulRequests: 10,
          errorRequests: 0,
        },
        byDay: [],
        byEndpoint: [],
      };
      makeRequestSpy.mockResolvedValue(usage);

      const result = await oxy.getAppUsage('app1', '7d');

      expect(result).toEqual(usage);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/applications/app1/usage',
        { period: '7d' },
        expect.objectContaining({ cache: true }),
      );
    });

    it('omits the period query when not provided', async () => {
      makeRequestSpy.mockResolvedValue({ summary: {}, byDay: [], byEndpoint: [] });
      await oxy.getAppUsage('app1');
      expect(makeRequestSpy.mock.calls[0][2]).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('surfaces API errors via handleError', async () => {
      makeRequestSpy.mockRejectedValue(
        Object.assign(new Error('boom'), { response: { status: 500 } }),
      );
      await expect(oxy.listAccounts()).rejects.toThrow();
    });
  });
});
