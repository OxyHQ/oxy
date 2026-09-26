/**
 * Follow-status cache invalidation tests.
 *
 * Regression coverage for the "follow resets after navigating away and back"
 * bug. `follows.status(userId)` caches `GET /users/<id>/follow-status` for
 * ~1 minute (identity-scoped). A follow/unfollow write must INVALIDATE that
 * cached entry, otherwise a `FollowButton` that remounts within the TTL window
 * re-reads the STALE pre-write status and reverts the optimistic UI.
 *
 * These tests pin down that:
 *  - a cached `follow-status` is NOT served after `follows.follow` /
 *    `follows.unfollow` / `follows.followMany` / `follows.unfollowMany` — the next read
 *    re-fetches and observes the new server truth,
 *  - each mutation invalidates the exact logical key(s) for the affected ids.
 */

import { OxyServices } from '../../OxyServices';

/**
 * Build a non-verified JWT whose payload decodes to the given claims.
 * `jwtDecode` only base64url-decodes the middle segment (no signature check).
 */
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

describe('follow-status cache invalidation', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  let oxy: OxyServices;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    oxy.http.setTokens(makeJwt({ userId: 'me' }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('does NOT serve a stale cached follow-status after follows.follow', async () => {
    // 1) Warm the cache: not following yet.
    fetchMock.mockResolvedValueOnce(jsonResponse({ isFollowing: false }));
    const before = await oxy.follows.status('target-1');
    expect(before.isFollowing).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A second read within the TTL is a cache hit (no extra network call).
    await oxy.follows.status('target-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 2) Follow — write succeeds and must bust the cached follow-status.
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, message: 'ok' }));
    await oxy.follows.follow('target-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 3) Remount-style re-read MUST re-fetch and observe the fresh truth.
    fetchMock.mockResolvedValueOnce(jsonResponse({ isFollowing: true }));
    const after = await oxy.follows.status('target-1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(after.isFollowing).toBe(true);
  });

  it('does NOT serve a stale cached follow-status after follows.unfollow', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ isFollowing: true }));
    const before = await oxy.follows.status('target-2');
    expect(before.isFollowing).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, message: 'ok' }));
    await oxy.follows.unfollow('target-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(jsonResponse({ isFollowing: false }));
    const after = await oxy.follows.status('target-2');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(after.isFollowing).toBe(false);
  });

  it('busts cached follow-status for every id after follows.followMany (bulk)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ isFollowing: false }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ isFollowing: false }));
    await oxy.follows.status('a');
    await oxy.follows.status('b');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          { userId: 'a', success: true, alreadyFollowing: false },
          { userId: 'b', success: true, alreadyFollowing: false },
        ],
        followedCount: 2,
      }),
    );
    await oxy.follows.followMany(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Both ids must re-fetch.
    fetchMock.mockResolvedValueOnce(jsonResponse({ isFollowing: true }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ isFollowing: true }));
    expect((await oxy.follows.status('a')).isFollowing).toBe(true);
    expect((await oxy.follows.status('b')).isFollowing).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('busts cached follow-status for every id after follows.unfollowMany (bulk)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ isFollowing: true }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ isFollowing: true }));
    await oxy.follows.status('a');
    await oxy.follows.status('b');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          { userId: 'a', success: true, wasFollowing: true },
          { userId: 'b', success: true, wasFollowing: true },
        ],
        unfollowedCount: 2,
      }),
    );
    await oxy.follows.unfollowMany(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockResolvedValueOnce(jsonResponse({ isFollowing: false }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ isFollowing: false }));
    expect((await oxy.follows.status('a')).isFollowing).toBe(false);
    expect((await oxy.follows.status('b')).isFollowing).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('invalidates the exact logical follow-status key on a single follow, in ONE pass', async () => {
    const invalidateSpy = jest.spyOn(oxy.http, 'invalidateCache');
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, message: 'ok' }));

    await oxy.follows.follow('target-3');

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    const [spec] = invalidateSpy.mock.calls[0];
    expect(spec.keys).toEqual(
      expect.arrayContaining(['GET:/users/target-3/follow-status', 'GET:/users/target-3', 'GET:/users/me/graph']),
    );
    expect(spec.prefixes).toEqual(expect.arrayContaining(['GET:/profiles/username/', 'GET:/profiles/resolve']));
    invalidateSpy.mockRestore();
  });

  it('does not invalidate or call the network when bulk follow gets an empty list', async () => {
    const invalidateSpy = jest.spyOn(oxy.http, 'invalidateCache');

    const result = await oxy.follows.followMany([]);

    expect(result).toEqual({ results: [], followedCount: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
    invalidateSpy.mockRestore();
  });
});
