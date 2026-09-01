/**
 * Identity-cache invalidation for the profile WRITERS, against the REAL
 * response cache.
 *
 * An account IS a user, and a profile screen never reads `/accounts/<id>` — it
 * reads `GET /users/<id>` and `GET /profiles/username/<handle>`, both cached for
 * five minutes in the caller's own process. `updateAccount` used to bust only
 * the account-graph keys, so for up to five minutes after an edit a refetch
 * handed back the PRE-EDIT profile from the client's own cache, with a
 * perfectly healthy server ("I changed my channel's picture and it doesn't
 * update until I reload the page").
 *
 * These tests drive the real `HttpService` cache over a mocked `fetch` rather
 * than spying on `clearCacheEntry` / `clearCacheByPrefix`, because a spy proves
 * only that SOME string was passed — not that the entry a read actually lands
 * under was evicted. The load-bearing case is the RENAME: an implementation
 * that busts the exact key for the handle in the write RESPONSE passes every
 * assertion about the new handle while leaving the OLD handle's entry serving
 * the pre-rename profile until its TTL. Both handles are warmed here so the two
 * implementations disagree.
 *
 * `updateProfile` is covered here too, because it carried a SECOND, drifted
 * hand-written copy of the same key list — it swept four of the six keys,
 * missing `GET:/auth/lookup/` and `GET:/profiles/resolve`. Both writers now
 * share one enumeration (`utils/identityCacheSweep`), and this is where that is
 * asserted from the outside.
 */

import { OxyServices } from '../../OxyServices';
import type { AccountNode } from '../OxyServices.accounts';

/**
 * A non-verified JWT whose payload decodes to the given claims — enough for the
 * cache's identity tag and the bearer preflight (`jwtDecode` never checks a
 * signature).
 */
function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...payload,
  })}.sig`;
}

/** A JSON `Response` in the API's `{ data: ... }` success envelope. */
function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const ACCOUNT_ID = 'acc1';
const PARENT_ID = 'root1';
const OLD_USERNAME = 'oldhandle';
const NEW_USERNAME = 'newhandle';

/** The write response: the account after a rename + a new picture. */
const renamedNode: AccountNode = {
  accountId: ACCOUNT_ID,
  kind: 'channel',
  parentAccountId: PARENT_ID,
  account: {
    id: ACCOUNT_ID,
    publicKey: 'pk-acc1',
    username: NEW_USERNAME,
    name: { displayName: 'Renamed Channel' },
    avatar: 'file_new',
  },
  relationship: 'owner',
  callerMembership: null,
};

describe('updateAccount identity-cache invalidation (real cache)', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  let oxy: OxyServices;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    oxy = new OxyServices({
      baseURL: 'http://test.invalid',
      enableRetry: false,
      requestTimeout: 1000,
    });
    oxy.httpService.setTokens(makeJwt({ userId: 'operator-1' }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.clearAllMocks();
  });

  /**
   * Warm every cache entry an account can be served under, plus one unrelated
   * entry that must SURVIVE. Returns the number of network calls made, so each
   * assertion below can be expressed as "did this read hit the network again".
   */
  async function warmCaches(): Promise<number> {
    // The profile screen's two reads, under the handle it had BEFORE the edit
    // and under the id.
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: ACCOUNT_ID, username: OLD_USERNAME }));
    await oxy.getProfileByUsername(OLD_USERNAME);
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: ACCOUNT_ID, username: OLD_USERNAME }));
    await oxy.getUserById(ACCOUNT_ID);

    // The handle the account is ABOUT to be renamed to may already be warm (a
    // 404-shaped read, a previous holder, a same-session preview). Warming it
    // is what makes the old-handle assertion below non-vacuous: an
    // implementation that busts only the response's handle passes for this one.
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: ACCOUNT_ID, username: NEW_USERNAME }));
    await oxy.getProfileByUsername(NEW_USERNAME);

    // The pre-session login lookup (carries avatar + display name) and handle
    // resolution — two keys the SDK's own profile-write sweep had drifted away
    // from, and which no test previously covered from a write.
    fetchMock.mockResolvedValueOnce(jsonResponse({ exists: true, username: OLD_USERNAME }));
    await oxy.lookupUsername(OLD_USERNAME);
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: ACCOUNT_ID, username: OLD_USERNAME }));
    await oxy.resolveProfile(`@${OLD_USERNAME}@test.invalid`);

    // The account-graph reads.
    fetchMock.mockResolvedValueOnce(jsonResponse({ account: renamedNode }));
    await oxy.getAccount(ACCOUNT_ID);
    fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [renamedNode] }));
    await oxy.listAccounts();
    fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [renamedNode] }));
    await oxy.listChildAccounts(PARENT_ID);

    // An unrelated cached read. It must survive — the vacuity floor that tells
    // a targeted sweep from a blanket `clearCache()`.
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 3 }));
    await oxy.httpService.get('/notifications/unread-count', { cache: true });

    return fetchMock.mock.calls.length;
  }

  /** Perform the rename + picture change. */
  async function performUpdate(): Promise<void> {
    fetchMock.mockResolvedValueOnce(jsonResponse({ account: renamedNode }));
    await oxy.updateAccount(ACCOUNT_ID, {
      username: NEW_USERNAME,
      avatar: 'file_new',
    });
  }

  it('warms every read it later asserts on (control: all are cache hits before the write)', async () => {
    const warmed = await warmCaches();

    // Re-issue every read with no queued response. A cache MISS would call
    // `fetch`, which now resolves `undefined` and throws — so a green run here
    // is proof that each entry really is resident, and that the assertions
    // below are measuring eviction rather than a cache that was never warm.
    await oxy.getProfileByUsername(OLD_USERNAME);
    await oxy.getProfileByUsername(NEW_USERNAME);
    await oxy.getUserById(ACCOUNT_ID);
    await oxy.lookupUsername(OLD_USERNAME);
    await oxy.resolveProfile(`@${OLD_USERNAME}@test.invalid`);
    await oxy.getAccount(ACCOUNT_ID);
    await oxy.listAccounts();
    await oxy.listChildAccounts(PARENT_ID);
    await oxy.httpService.get('/notifications/unread-count', { cache: true });

    expect(fetchMock).toHaveBeenCalledTimes(warmed);
  });

  it('evicts the OLD handle, not just the handle in the write response', async () => {
    await warmCaches();
    await performUpdate();
    const afterWrite = fetchMock.mock.calls.length;

    // THE assertion. `updateAccount` cannot know the pre-rename handle — it is
    // in neither the request nor the response — so only a PREFIX sweep of
    // `GET:/profiles/username/` reaches it. A targeted `clearCacheEntry` for
    // the response's handle leaves this entry serving the pre-rename profile.
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: ACCOUNT_ID, username: NEW_USERNAME }));
    const refetched = await oxy.getProfileByUsername(OLD_USERNAME);

    expect(fetchMock).toHaveBeenCalledTimes(afterWrite + 1);
    expect(refetched.username).toBe(NEW_USERNAME);
  });

  it('evicts the by-id profile read the account detail page uses', async () => {
    await warmCaches();
    await performUpdate();
    const afterWrite = fetchMock.mock.calls.length;

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: ACCOUNT_ID, avatar: 'file_new' }));
    const refetched = await oxy.getUserById(ACCOUNT_ID);

    expect(fetchMock).toHaveBeenCalledTimes(afterWrite + 1);
    expect(refetched.avatar).toBe('file_new');
  });

  it('evicts the new handle, the login lookup, and handle resolution', async () => {
    await warmCaches();
    await performUpdate();
    let calls = fetchMock.mock.calls.length;

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: ACCOUNT_ID, username: NEW_USERNAME }));
    await oxy.getProfileByUsername(NEW_USERNAME);
    expect(fetchMock).toHaveBeenCalledTimes(++calls);

    fetchMock.mockResolvedValueOnce(jsonResponse({ exists: false, username: OLD_USERNAME }));
    await oxy.lookupUsername(OLD_USERNAME);
    expect(fetchMock).toHaveBeenCalledTimes(++calls);

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: ACCOUNT_ID, username: NEW_USERNAME }));
    await oxy.resolveProfile(`@${OLD_USERNAME}@test.invalid`);
    expect(fetchMock).toHaveBeenCalledTimes(++calls);
  });

  it('evicts the account detail, the account lists, and the PARENT children list', async () => {
    await warmCaches();
    await performUpdate();
    let calls = fetchMock.mock.calls.length;

    fetchMock.mockResolvedValueOnce(jsonResponse({ account: renamedNode }));
    await oxy.getAccount(ACCOUNT_ID);
    expect(fetchMock).toHaveBeenCalledTimes(++calls);

    fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [renamedNode] }));
    await oxy.listAccounts();
    expect(fetchMock).toHaveBeenCalledTimes(++calls);

    // Keyed by the PARENT id, which is reachable only from the response node —
    // the child's own id does not build this key.
    fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [renamedNode] }));
    await oxy.listChildAccounts(PARENT_ID);
    expect(fetchMock).toHaveBeenCalledTimes(++calls);
  });

  it('leaves unrelated cached reads alone (it is a sweep, not a cache wipe)', async () => {
    await warmCaches();
    await performUpdate();
    const afterWrite = fetchMock.mock.calls.length;

    // No queued response: a miss would call `fetch` and throw.
    const cached = await oxy.httpService.get<{ count: number }>(
      '/notifications/unread-count',
      { cache: true },
    );

    expect(fetchMock).toHaveBeenCalledTimes(afterWrite);
    expect(cached.count).toBe(3);
  });

  it('does not sweep when the write fails', async () => {
    await warmCaches();
    const warmed = fetchMock.mock.calls.length;

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      oxy.updateAccount(ACCOUNT_ID, { avatar: 'file_new' }),
    ).rejects.toThrow();

    // The failed PATCH is one call; every read below must still be a cache hit.
    await oxy.getProfileByUsername(OLD_USERNAME);
    await oxy.getUserById(ACCOUNT_ID);
    await oxy.getAccount(ACCOUNT_ID);

    expect(fetchMock).toHaveBeenCalledTimes(warmed + 1);
  });

  it('still sweeps the identity keys when the response carries no parent', async () => {
    await warmCaches();
    const rootNode: AccountNode = { ...renamedNode, parentAccountId: null };
    fetchMock.mockResolvedValueOnce(jsonResponse({ account: rootNode }));
    await oxy.updateAccount(ACCOUNT_ID, { avatar: 'file_new' });
    const afterWrite = fetchMock.mock.calls.length;

    // A root account has no children list to bust, but its identity keys go
    // stale exactly the same way — the `parentAccountId` guard must not gate
    // the identity sweep.
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: ACCOUNT_ID, avatar: 'file_new' }));
    await oxy.getUserById(ACCOUNT_ID);

    expect(fetchMock).toHaveBeenCalledTimes(afterWrite + 1);
  });
});

describe('updateProfile identity-cache invalidation (real cache)', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  let oxy: OxyServices;

  const SELF_ID = 'me-1';

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    oxy = new OxyServices({
      baseURL: 'http://test.invalid',
      enableRetry: false,
      requestTimeout: 1000,
    });
    oxy.httpService.setTokens(makeJwt({ userId: SELF_ID }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.clearAllMocks();
  });

  /**
   * The two keys `updateProfile`'s own hand-written sweep MISSED. They are the
   * whole point of this block — a test that only re-checked `GET:/users/me` and
   * `GET:/profiles/username/` would have passed against the drifted version.
   */
  it('evicts the login lookup and handle resolution, not just the keys it used to know', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ exists: true, username: 'alice', avatar: 'old' }));
    await oxy.lookupUsername('alice');
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: SELF_ID, avatar: 'old' }));
    await oxy.resolveProfile('@alice@test.invalid');

    // Control: both are warm (a miss would call the un-queued mock and throw).
    await oxy.lookupUsername('alice');
    await oxy.resolveProfile('@alice@test.invalid');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: SELF_ID, avatar: 'new' }));
    await oxy.updateProfile({ avatar: 'new' });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockResolvedValueOnce(jsonResponse({ exists: true, username: 'alice', avatar: 'new' }));
    await oxy.lookupUsername('alice');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: SELF_ID, avatar: 'new' }));
    await oxy.resolveProfile('@alice@test.invalid');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('still evicts the self, by-id and handle reads it always did', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: SELF_ID, avatar: 'old' }));
    await oxy.getCurrentUser();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: SELF_ID, avatar: 'old' }));
    await oxy.getUserById(SELF_ID);
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: SELF_ID, avatar: 'old' }));
    await oxy.getProfileByUsername('alice');
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: SELF_ID, avatar: 'old' }));
    await oxy.getUserBySession('sess-1');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: SELF_ID, avatar: 'new' }));
    await oxy.updateProfile({ avatar: 'new' });

    let calls = 5;
    for (const read of [
      () => oxy.getCurrentUser(),
      () => oxy.getUserById(SELF_ID),
      () => oxy.getProfileByUsername('alice'),
      () => oxy.getUserBySession('sess-1'),
    ]) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: SELF_ID, avatar: 'new' }));
      await read();
      expect(fetchMock).toHaveBeenCalledTimes(++calls);
    }
  });

  it('evicts the account forest list and detail after a self-profile edit', async () => {
    const selfNode: AccountNode = {
      accountId: SELF_ID,
      kind: 'personal',
      parentAccountId: null,
      account: {
        id: SELF_ID,
        publicKey: 'pk-me',
        username: 'alice',
        name: { displayName: 'Alice' },
        avatar: 'old',
      },
      relationship: 'self',
      callerMembership: null,
    };

    fetchMock.mockResolvedValueOnce(jsonResponse([selfNode]));
    await oxy.listAccounts();
    fetchMock.mockResolvedValueOnce(jsonResponse({ account: selfNode }));
    await oxy.getAccount(SELF_ID);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: SELF_ID, avatar: 'new' }));
    await oxy.updateProfile({ avatar: 'new' });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockResolvedValueOnce(jsonResponse([{ ...selfNode, account: { ...selfNode.account!, avatar: 'new' } }]));
    await oxy.listAccounts();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ account: { ...selfNode, account: { ...selfNode.account!, avatar: 'new' } } }),
    );
    await oxy.getAccount(SELF_ID);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
