/**
 * `oxy.accounts` — request shape (method, path, encoding, body), envelope
 * unwrapping, and cache discipline, checked by behaviour: a read is served from
 * cache until a write that should invalidate it, then re-fetched.
 */
import { OxyServices } from '../../OxyServices';
import type { AccountMember, AccountNode, SwitchAccountResult } from '../accounts';
import type { User } from '../../models/interfaces';

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload })}.sig`;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(status >= 400 ? { error: { code: 'FORBIDDEN', message: 'nope' } } : { data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const user: User = { id: 'acc1', publicKey: 'pk-acc1', username: 'oxy-org', name: { displayName: 'Oxy Org' } };

const member: AccountMember = {
  _id: 'm1',
  accountId: 'acc1',
  memberUserId: 'u2',
  role: 'editor',
  permissions: ['account:read'],
  inherit: true,
  status: 'active',
  source: 'direct',
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
};

const node: AccountNode = {
  accountId: 'acc1',
  kind: 'organization',
  parentAccountId: 'root1',
  account: user,
  relationship: 'owner',
  callerMembership: { ...member, role: 'owner' },
  childCount: 2,
};

describe('oxy.accounts', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  let oxy: OxyServices;

  const call = (i: number) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    oxy.session.setAccessToken(makeJwt({ userId: 'me' }));
  });

  afterEach(() => {
    oxy.dispose();
    globalThis.fetch = originalFetch;
  });

  describe('list / get', () => {
    it('unwraps `accounts` and caches the flat read', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [node] }));
      await expect(oxy.accounts.list()).resolves.toEqual([node]);
      await expect(oxy.accounts.list()).resolves.toEqual([node]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(call(0)).toMatchObject({ url: 'http://test.invalid/accounts', method: 'GET' });
    });

    it('requests the tree as its own path and defaults to []', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}));
      await expect(oxy.accounts.list({ tree: true })).resolves.toEqual([]);
      expect(call(0).url).toBe('http://test.invalid/accounts?tree=true');
    });

    it('unwraps `account` and URL-encodes the id', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ account: node }));
      await expect(oxy.accounts.get('a/b')).resolves.toEqual(node);
      expect(call(0).url).toBe('http://test.invalid/accounts/a%2Fb');
    });
  });

  describe('actAs', () => {
    const switched: SwitchAccountResult = {
      sessionId: 's2',
      deviceId: 'd1',
      expiresAt: '2026-07-01T00:00:00.000Z',
      accessToken: makeJwt({ userId: 'acc1' }),
      user: { ...user, id: undefined as unknown as string, _id: 'acc1' } as User,
      authuser: 1,
    };

    it('plants the new token, clears the whole cache and normalises the user', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [node] }));
      await oxy.accounts.list();

      fetchMock.mockResolvedValueOnce(jsonResponse(switched));
      const result = await oxy.accounts.actAs('acc1');

      expect(call(1)).toMatchObject({ url: 'http://test.invalid/accounts/acc1/switch', method: 'POST' });
      expect(oxy.session.accessToken).toBe(switched.accessToken);
      expect(result.authuser).toBe(1);
      expect(result.user.id).toBe('acc1');
      expect(oxy.cache.stats().size).toBe(0);
    });

    it('does not plant or sweep when the switch is refused', async () => {
      const before = oxy.session.accessToken;
      fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [node] }));
      await oxy.accounts.list();

      fetchMock.mockResolvedValueOnce(jsonResponse(null, 403));
      await expect(oxy.accounts.actAs('acc1')).rejects.toMatchObject({ status: 403 });
      expect(oxy.session.accessToken).toBe(before);
      expect(oxy.cache.stats().size).toBe(1);
    });
  });

  describe('writes invalidate what they change', () => {
    it('create busts every list', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [] }));
      await oxy.accounts.list();
      fetchMock.mockResolvedValueOnce(jsonResponse({ account: node }));
      await expect(oxy.accounts.create({ kind: 'organization', username: 'org' })).resolves.toEqual(node);
      expect(call(1)).toMatchObject({ method: 'POST', body: { kind: 'organization', username: 'org' } });

      fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [node] }));
      await expect(oxy.accounts.list()).resolves.toEqual([node]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('update busts the detail and the identity reads of that account', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ account: node }));
      await oxy.accounts.get('acc1');
      fetchMock.mockResolvedValueOnce(jsonResponse({ account: node }));
      await oxy.accounts.update('acc1', { bio: 'x' });
      expect(call(1)).toMatchObject({ url: 'http://test.invalid/accounts/acc1', method: 'PATCH', body: { bio: 'x' } });

      fetchMock.mockResolvedValueOnce(jsonResponse({ account: node }));
      await oxy.accounts.get('acc1');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('archive deletes and busts the detail', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ account: node }));
      await oxy.accounts.get('acc1');
      fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
      await expect(oxy.accounts.archive('acc1')).resolves.toEqual({ success: true });
      expect(call(1).method).toBe('DELETE');
      fetchMock.mockResolvedValueOnce(jsonResponse({ account: node }));
      await oxy.accounts.get('acc1');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('transferOwnership posts the target and busts lists and members', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ members: [member] }));
      await oxy.accounts.members.list('acc1');
      fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
      await oxy.accounts.transferOwnership('acc1', { userId: 'u2' });
      expect(call(1)).toMatchObject({
        url: 'http://test.invalid/accounts/acc1/transfer-ownership',
        method: 'POST',
        body: { userId: 'u2' },
      });
      fetchMock.mockResolvedValueOnce(jsonResponse({ members: [] }));
      await expect(oxy.accounts.members.list('acc1')).resolves.toEqual([]);
    });
  });

  describe('members', () => {
    it('lists, caching, and defaults to []', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}));
      await expect(oxy.accounts.members.list('acc1')).resolves.toEqual([]);
      expect(call(0).url).toBe('http://test.invalid/accounts/acc1/members');
    });

    it('invite / update / remove hit their routes and bust every roster (inherited rows)', async () => {
      // A DESCENDANT's roster carries rows inherited from acc1 — it must go too.
      fetchMock.mockResolvedValueOnce(jsonResponse({ members: [member] }));
      await oxy.accounts.members.list('child1');

      fetchMock.mockResolvedValueOnce(jsonResponse({ member }));
      await expect(oxy.accounts.members.invite('acc1', { usernameOrEmail: 'bob', role: 'viewer' })).resolves.toEqual(member);
      fetchMock.mockResolvedValueOnce(jsonResponse({ member }));
      await oxy.accounts.members.update('acc1', 'm/1', { role: 'admin' });
      fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
      await oxy.accounts.members.remove('acc1', 'm1');

      expect(call(1)).toMatchObject({ url: 'http://test.invalid/accounts/acc1/members', method: 'POST' });
      expect(call(2)).toMatchObject({ url: 'http://test.invalid/accounts/acc1/members/m%2F1', method: 'PATCH' });
      expect(call(3)).toMatchObject({ url: 'http://test.invalid/accounts/acc1/members/m1', method: 'DELETE' });

      fetchMock.mockResolvedValueOnce(jsonResponse({ members: [] }));
      await expect(oxy.accounts.members.list('child1')).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });
  });

  it('rejects with OxyApiError carrying the status and code', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(null, 403));
    await expect(oxy.accounts.get('acc1')).rejects.toMatchObject({ name: 'OxyApiError', status: 403, code: 'FORBIDDEN' });
  });
});
