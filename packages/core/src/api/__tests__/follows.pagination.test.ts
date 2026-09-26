/**
 * Follow-graph pagination + ordering tests.
 *
 * Regression coverage for the silent "every page is page one" bug.
 * `buildPaginationParams` used to return a `URLSearchParams`, which it then
 * handed to `makeRequest` as a GET's `params`. `HttpService` reads that object
 * with `Object.keys(...)` in TWO places — `buildURL` (decide whether to append
 * a query string) and `generateBaseCacheKey` (build the cache key) — and
 * `Object.keys(new URLSearchParams({ limit: '20' }))` is `[]`, because a
 * `URLSearchParams` exposes its entries through iterator methods rather than
 * own enumerable properties. The consequences were both invisible from the
 * call site:
 *
 *  - no query string was ever sent, so every caller silently got the server's
 *    DEFAULT page no matter which `limit`/`offset` it asked for, and
 *  - every page collapsed onto ONE cache key, so page 2 was served page 1's
 *    cached body without a network call.
 *
 * These tests assert on the URL `fetch` actually received (not on the helper's
 * return value), so they fail against the old `URLSearchParams` implementation
 * and cannot pass vacuously.
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

/** A paginated `{ data, pagination }` body — passed through by `unwrapResponse`. */
function pageResponse(data: unknown[], total = 100, hasMore = true): Response {
  return new Response(JSON.stringify({ data, pagination: { total, hasMore } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A JSON `{ data: ... }` success envelope. */
function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('follow-graph pagination and ordering', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  let oxy: OxyServices;

  /** The URL string passed to `fetch` on call `n` (0-based). */
  const requestedUrl = (n: number): string => String(fetchMock.mock.calls[n][0]);

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

  describe('the request actually carries the pagination the caller asked for', () => {
    it('sends limit and offset on follows.followers', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([]));
      await oxy.follows.followers('target-1', { limit: 20, offset: 40 });

      const url = new URL(requestedUrl(0));
      expect(url.pathname).toBe('/users/target-1/followers');
      expect(url.searchParams.get('limit')).toBe('20');
      expect(url.searchParams.get('offset')).toBe('40');
    });

    it('sends limit and offset on follows.following', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([]));
      await oxy.follows.following('target-1', { limit: 5, offset: 10 });

      const url = new URL(requestedUrl(0));
      expect(url.pathname).toBe('/users/target-1/following');
      expect(url.searchParams.get('limit')).toBe('5');
      expect(url.searchParams.get('offset')).toBe('10');
    });

    it('sends limit and offset on follows.mutuals', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([]));
      await oxy.follows.mutuals('target-1', { limit: 7, offset: 14 });

      const url = new URL(requestedUrl(0));
      expect(url.pathname).toBe('/users/target-1/mutuals');
      expect(url.searchParams.get('limit')).toBe('7');
      expect(url.searchParams.get('offset')).toBe('14');
    });

    it('sends limit on the id-only graph seeds', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      await oxy.follows.mutualIds({ limit: 33 });
      expect(new URL(requestedUrl(0)).searchParams.get('limit')).toBe('33');

      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      await oxy.follows.followsOfFollowsIds({ limit: 44 });
      expect(new URL(requestedUrl(1)).searchParams.get('limit')).toBe('44');
    });

    it('omits the query string entirely when no pagination is given', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([]));
      await oxy.follows.followers('target-1');

      expect(requestedUrl(0)).toBe('http://test.invalid/users/target-1/followers');
    });
  });

  describe('each page is its own cache entry', () => {
    it('does NOT serve page 1 cached body to a page 2 request', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([{ id: 'a' }]));
      const first = await oxy.follows.followers('target-1', { limit: 1, offset: 0 });
      expect(first.followers).toEqual([{ id: 'a' }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Different offset ⇒ different cache key ⇒ a real second network call.
      fetchMock.mockResolvedValueOnce(pageResponse([{ id: 'b' }]));
      const second = await oxy.follows.followers('target-1', { limit: 1, offset: 1 });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(second.followers).toEqual([{ id: 'b' }]);
      expect(new URL(requestedUrl(1)).searchParams.get('offset')).toBe('1');
    });

    it('still serves a warm cache hit for the SAME page', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([{ id: 'a' }]));
      await oxy.follows.followers('target-1', { limit: 1, offset: 0 });
      await oxy.follows.followers('target-1', { limit: 1, offset: 0 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('sort', () => {
    it('sends sort=oldest and keeps it out of the request when unset', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([]));
      await oxy.follows.followers('target-1', { limit: 10, sort: 'oldest' });
      expect(new URL(requestedUrl(0)).searchParams.get('sort')).toBe('oldest');

      fetchMock.mockResolvedValueOnce(pageResponse([]));
      await oxy.follows.followers('target-1', { limit: 10 });
      expect(new URL(requestedUrl(1)).searchParams.has('sort')).toBe(false);
    });

    it('discriminates the cache key, so flipping sort re-fetches', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([{ id: 'newest' }]));
      const recent = await oxy.follows.followers('target-1', { limit: 2, offset: 0, sort: 'recent' });
      expect(recent.followers).toEqual([{ id: 'newest' }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockResolvedValueOnce(pageResponse([{ id: 'oldest' }]));
      const oldest = await oxy.follows.followers('target-1', { limit: 2, offset: 0, sort: 'oldest' });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(oldest.followers).toEqual([{ id: 'oldest' }]);
    });

    it('threads sort through follows.following and follows.mutuals', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([]));
      await oxy.follows.following('target-1', { sort: 'oldest' });
      expect(new URL(requestedUrl(0)).searchParams.get('sort')).toBe('oldest');

      fetchMock.mockResolvedValueOnce(pageResponse([]));
      await oxy.follows.mutuals('target-1', { sort: 'oldest' });
      expect(new URL(requestedUrl(1)).searchParams.get('sort')).toBe('oldest');
    });
  });

  describe('follow writes invalidate the cached follower/following lists', () => {
    it('re-fetches the followers list after follows.follow', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([{ id: 'a' }], 1, false));
      await oxy.follows.followers('target-1', { limit: 10, offset: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, message: 'ok' }));
      await oxy.follows.follow('target-1');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // The viewer is now a follower — the list must not come from cache.
      fetchMock.mockResolvedValueOnce(pageResponse([{ id: 'a' }, { id: 'me' }], 2, false));
      const after = await oxy.follows.followers('target-1', { limit: 10, offset: 0 });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(after.followers).toHaveLength(2);
    });

    it('re-fetches the viewer own following list after follows.follow', async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([], 0, false));
      await oxy.follows.following('me', { limit: 10, offset: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, message: 'ok' }));
      await oxy.follows.follow('target-1');

      fetchMock.mockResolvedValueOnce(pageResponse([{ id: 'target-1' }], 1, false));
      const after = await oxy.follows.following('me', { limit: 10, offset: 0 });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(after.following).toEqual([{ id: 'target-1' }]);
    });

    it('invalidates every page and sort variant, not just the one that was read', async () => {
      const invalidateSpy = jest.spyOn(oxy.http, 'invalidateCache');
      fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, message: 'ok' }));

      await oxy.follows.follow('target-1');

      // Prefix invalidation is what makes this page/sort agnostic — an exact-key
      // clear would only bust the single variant the caller happened to read.
      expect(invalidateSpy.mock.calls[0][0].prefixes).toEqual(
        expect.arrayContaining(['GET:/users/target-1/followers', 'GET:/users/target-1/mutuals', 'GET:/users/me/following']),
      );
      invalidateSpy.mockRestore();
    });

    it('invalidates the follower lists of every id in a bulk follow', async () => {
      const invalidateSpy = jest.spyOn(oxy.http, 'invalidateCache');
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

      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      expect(invalidateSpy.mock.calls[0][0].prefixes).toEqual(
        expect.arrayContaining(['GET:/users/a/followers', 'GET:/users/b/followers', 'GET:/users/me/following']),
      );
      invalidateSpy.mockRestore();
    });
  });

  describe('users.similar forwards pagination params', () => {
    it('sends limit and offset on users.similar', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      await oxy.users.similar('target-1', { limit: 15, offset: 30 });

      const url = new URL(requestedUrl(0));
      expect(url.pathname).toBe('/profiles/target-1/similar');
      expect(url.searchParams.get('limit')).toBe('15');
      expect(url.searchParams.get('offset')).toBe('30');
    });

    it('still accepts a bare limit number for backward compatibility', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      await oxy.users.similar('target-1', 5);

      const url = new URL(requestedUrl(0));
      expect(url.searchParams.get('limit')).toBe('5');
      expect(url.searchParams.has('offset')).toBe(false);
    });
  });
});
