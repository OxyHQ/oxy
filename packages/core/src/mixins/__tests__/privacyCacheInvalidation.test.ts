/**
 * Privacy / list cache-invalidation tests.
 *
 * The privacy reads cache their GET responses (identity-scoped):
 *  - `getBlockedUsers()`     → `GET:/privacy/blocked`        (~1 min TTL)
 *  - `getRestrictedUsers()`  → `GET:/privacy/restricted`     (~1 min TTL)
 *  - `getPrivacySettings(id)`→ `GET:/privacy/<id>/privacy`   (~2 min TTL)
 *
 * Each corresponding write MUST invalidate the matching cached GET, otherwise a
 * consumer that re-reads within the TTL window observes the STALE pre-write
 * value (mirrors the follow/unfollow follow-status invalidation contract).
 */

import { OxyServices } from '../../OxyServices';

/** Build a non-verified JWT whose payload decodes to the given claims. */
function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const fullPayload = { exp: Math.floor(Date.now() / 1000) + 3600, ...payload };
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(fullPayload)}.sig`;
}

/** A JSON `Response` mimicking the API's `{ data: ... }` success envelope. */
function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('privacy cache invalidation', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  let oxy: OxyServices;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    oxy.httpService.setTokens(makeJwt({ userId: 'me' }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('busts the cached blocked list after blockUser', async () => {
    // 1) Warm the cache: empty blocked list.
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    expect(await oxy.getBlockedUsers()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A second read within the TTL is a cache hit (no extra network call).
    await oxy.getBlockedUsers();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 2) Block a user — must invalidate the cached list.
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'ok' }));
    await oxy.blockUser('target-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 3) Re-read MUST re-fetch and observe the new entry.
    fetchMock.mockResolvedValueOnce(jsonResponse([{ blockedId: 'target-1' }]));
    const after = await oxy.getBlockedUsers();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(after).toEqual([{ blockedId: 'target-1' }]);
  });

  it('busts the cached blocked list after unblockUser', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ blockedId: 'target-1' }]));
    await oxy.getBlockedUsers();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'ok' }));
    await oxy.unblockUser('target-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    expect(await oxy.getBlockedUsers()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('busts the cached restricted list after restrictUser / unrestrictUser', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await oxy.getRestrictedUsers();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'ok' }));
    await oxy.restrictUser('target-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(jsonResponse([{ restrictedId: 'target-2' }]));
    expect(await oxy.getRestrictedUsers()).toEqual([{ restrictedId: 'target-2' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'ok' }));
    await oxy.unrestrictUser('target-2');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    expect(await oxy.getRestrictedUsers()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('busts the cached privacy settings (same id) after updatePrivacySettings', async () => {
    // Warm the settings cache for an explicit id (avoids a getCurrentUser call).
    fetchMock.mockResolvedValueOnce(jsonResponse({ isPrivateAccount: false }));
    expect(await oxy.getPrivacySettings('me')).toEqual({ isPrivateAccount: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Cache hit on the second read.
    await oxy.getPrivacySettings('me');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Update — must invalidate `GET:/privacy/me/privacy`.
    fetchMock.mockResolvedValueOnce(jsonResponse({ isPrivateAccount: true }));
    await oxy.updatePrivacySettings({ isPrivateAccount: true }, 'me');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Re-read MUST re-fetch and observe the new value.
    fetchMock.mockResolvedValueOnce(jsonResponse({ isPrivateAccount: true }));
    const after = await oxy.getPrivacySettings('me');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(after).toEqual({ isPrivateAccount: true });
  });

  it('invalidates the exact logical keys on block/restrict/settings writes', async () => {
    const clearSpy = jest.spyOn(oxy, 'clearCacheEntry');
    const clearPrefixSpy = jest.spyOn(oxy, 'clearCacheByPrefix');

    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'ok' }));
    await oxy.blockUser('u1');
    expect(clearSpy).toHaveBeenCalledWith('GET:/privacy/blocked');
    expect(clearSpy).toHaveBeenCalledWith('GET:/users/me/graph');

    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'ok' }));
    await oxy.restrictUser('u2');
    expect(clearSpy).toHaveBeenCalledWith('GET:/privacy/restricted');
    expect(clearSpy).toHaveBeenCalledWith('GET:/users/me/graph');

    fetchMock.mockResolvedValueOnce(jsonResponse({ isPrivateAccount: true }));
    await oxy.updatePrivacySettings({ isPrivateAccount: true }, 'me');
    expect(clearSpy).toHaveBeenCalledWith('GET:/privacy/me/privacy');
    expect(clearSpy).toHaveBeenCalledWith('GET:/users/me');
    expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/session/user/');
    expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/users/me');
    expect(clearPrefixSpy).toHaveBeenCalledWith('GET:/profiles/username/');

    clearSpy.mockRestore();
    clearPrefixSpy.mockRestore();
  });
});
