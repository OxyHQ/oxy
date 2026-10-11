/**
 * HttpService response-cache identity-scoping tests.
 *
 * Regression coverage for the "Who to follow" bug: the GET-response cache used
 * to key on only `method:url[:data]`, so an anonymous response cached during a
 * web cold boot (session still restoring) was served back to the SAME URL once
 * the session landed (now authenticated) — recommending accounts the user
 * already follows. These tests pin down that:
 *
 *  - an anonymous GET response is NOT served to a later authenticated GET of
 *    the same URL (different identity tag -> cache miss -> a fresh network call),
 *  - two different authenticated users never share a cache entry,
 *  - after `clearTokens()` a previously-cached authenticated response is not
 *    served to an anonymous caller,
 *  - the `clearCacheByPrefix` invalidation used by `updateProfile` still works
 *    against identity-scoped keys.
 */

import { HttpService } from '../HttpService';

/**
 * Build a non-verified JWT whose payload decodes to the given claims.
 * `jwtDecode` only base64url-decodes the middle segment (no signature check),
 * so a fixed header + base64url(JSON) payload + dummy signature is enough.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  // Far-future expiry so getAuthHeader() never tries to refresh it.
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

describe('HttpService identity-scoped response cache', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

  const newService = (): HttpService =>
    new HttpService({
      baseURL: 'http://test.invalid',
      enableRetry: false,
      requestTimeout: 1000,
    });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('does NOT serve an anonymous cached GET to a later authenticated caller', async () => {
    const http = newService();

    // 1) Anonymous GET — caches the public response.
    fetchMock.mockResolvedValueOnce(jsonResponse({ profiles: ['popular-1', 'popular-2'] }));
    const anon = await http.get<{ profiles: string[] }>('/profiles/recommendations', {
      cache: true,
    });
    expect(anon.profiles).toEqual(['popular-1', 'popular-2']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 2) Session lands — now authenticated as user-1.
    http.setTokens(makeJwt({ userId: 'user-1' }));

    // 3) Same URL, authenticated: MUST be a cache miss -> a real network call,
    //    returning the personalized list (no already-followed accounts).
    fetchMock.mockResolvedValueOnce(jsonResponse({ profiles: ['suggested-a', 'suggested-b'] }));
    const authed = await http.get<{ profiles: string[] }>('/profiles/recommendations', {
      cache: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authed.profiles).toEqual(['suggested-a', 'suggested-b']);
  });

  it('serves a warm cache hit to the SAME authenticated identity (no extra network call)', async () => {
    const http = newService();
    http.setTokens(makeJwt({ userId: 'user-1' }));

    fetchMock.mockResolvedValueOnce(jsonResponse({ profiles: ['suggested-a'] }));
    const first = await http.get<{ profiles: string[] }>('/profiles/recommendations', {
      cache: true,
    });
    const second = await http.get<{ profiles: string[] }>('/profiles/recommendations', {
      cache: true,
    });

    expect(first).toEqual(second);
    // Only one network call — the second read is a cache hit for the same id.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never shares a cache entry between two different authenticated users', async () => {
    const http = newService();

    http.setTokens(makeJwt({ userId: 'user-1' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ profiles: ['for-user-1'] }));
    const u1 = await http.get<{ profiles: string[] }>('/profiles/recommendations', { cache: true });
    expect(u1.profiles).toEqual(['for-user-1']);

    // Switch identity to a different user (does not clear cache by itself).
    http.setTokens(makeJwt({ userId: 'user-2' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ profiles: ['for-user-2'] }));
    const u2 = await http.get<{ profiles: string[] }>('/profiles/recommendations', { cache: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(u2.profiles).toEqual(['for-user-2']);
  });

  it('does NOT serve an authenticated cached response to an anonymous caller after clearTokens()', async () => {
    const http = newService();
    http.setTokens(makeJwt({ userId: 'user-1' }));

    fetchMock.mockResolvedValueOnce(jsonResponse({ profiles: ['private-suggestion'] }));
    const authed = await http.get<{ profiles: string[] }>('/profiles/recommendations', {
      cache: true,
    });
    expect(authed.profiles).toEqual(['private-suggestion']);

    // Logout clears the response cache (privacy + correct logout semantics).
    http.clearTokens();

    fetchMock.mockResolvedValueOnce(jsonResponse({ profiles: ['popular-public'] }));
    const anon = await http.get<{ profiles: string[] }>('/profiles/recommendations', {
      cache: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(anon.profiles).toEqual(['popular-public']);
  });

  it('still honors clearCacheByPrefix against identity-scoped keys (updateProfile path)', async () => {
    const http = newService();
    http.setTokens(makeJwt({ userId: 'user-1' }));

    // Warm a `GET:/session/user/<id>` entry (as updateProfile's prefix targets).
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'user-1', name: 'old' }));
    await http.get('/session/user/sess-1', { cache: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A cache hit confirms the entry is warm.
    await http.get('/session/user/sess-1', { cache: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Prefix sweep used by updateProfile must match the identity-scoped key.
    const removed = http.clearCacheByPrefix('GET:/session/user/');
    expect(removed).toBe(1);

    // Next read re-fetches (cache was invalidated).
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'user-1', name: 'new' }));
    const after = await http.get<{ id: string; name: string }>('/session/user/sess-1', {
      cache: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(after.name).toBe('new');
  });

  it('clearCacheEntry busts every identity-scoped variant of a base key', async () => {
    const http = newService();

    // Anonymous reads /users/u1.
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'u1', name: 'anon-view' }));
    await http.get('/users/u1', { cache: true });

    // Authenticated user reads the same resource — separate cache entry.
    http.setTokens(makeJwt({ userId: 'user-1' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'u1', name: 'authed-view' }));
    await http.get('/users/u1', { cache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // updateProfile-style exact invalidation must clear BOTH identity variants.
    http.clearCacheEntry('GET:/users/u1');

    // Both identities now re-fetch.
    http.setTokens(makeJwt({ userId: 'user-1' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'u1', name: 'refetched' }));
    await http.get('/users/u1', { cache: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  /**
   * The soft cache-size guard is observability-only: it must warn (once,
   * throttled) when the entry count blows past the soft ceiling, but must NEVER
   * evict a live entry. We synthesize bloat by giving every request a distinct
   * undecodable token, so each write mints a fresh identity tag → a fresh key.
   */
  describe('soft cache-size telemetry guard', () => {
    /** Number of distinct cached entries needed to cross the 500 soft ceiling. */
    const ENTRIES_PAST_LIMIT = 520;

    const newLoggingService = (): HttpService =>
      new HttpService({
        baseURL: 'http://test.invalid',
        enableRetry: false,
        requestTimeout: 1000,
        enableLogging: true,
        logLevel: 'warn',
      });

    let warnSpy: jest.SpyInstance;
    beforeEach(() => {
      // SimpleLogger routes `warn` to console.warn; spy there to assert telemetry.
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('warns (throttled) once the cache exceeds the soft entry limit and never evicts', async () => {
      const http = newLoggingService();

      // Each iteration: a fresh undecodable token → fresh identity tag → fresh
      // key, so the cache grows by one live entry per call.
      for (let i = 0; i < ENTRIES_PAST_LIMIT; i++) {
        http.setTokens(`undecodable-token-${i}`);
        fetchMock.mockResolvedValueOnce(jsonResponse({ i }));
        await http.get('/profiles/recommendations', { cache: true });
      }

      // No eviction: every distinct entry is still resident.
      expect(http.getCacheStats().size).toBe(ENTRIES_PAST_LIMIT);

      // Telemetry fired, and exactly once within the throttle window.
      const cacheWarnings = warnSpy.mock.calls.filter((args) =>
        args.some((a: unknown) => typeof a === 'string' && a.includes('exceeded soft entry limit')),
      );
      expect(cacheWarnings.length).toBe(1);
    });

    it('does not warn while the cache stays under the soft limit', async () => {
      const http = newLoggingService();

      for (let i = 0; i < 10; i++) {
        http.setTokens(`undecodable-token-${i}`);
        fetchMock.mockResolvedValueOnce(jsonResponse({ i }));
        await http.get('/profiles/recommendations', { cache: true });
      }

      const cacheWarnings = warnSpy.mock.calls.filter((args) =>
        args.some((a: unknown) => typeof a === 'string' && a.includes('exceeded soft entry limit')),
      );
      expect(cacheWarnings.length).toBe(0);
    });
  });

  /**
   * `enableCache: false` (or `cacheTTL <= 0`) must fully disable the
   * per-instance GET response cache: every read hits the network, even when the
   * per-request `cache: true` flag is set. This is the lever Mention's linked
   * backend client uses to make React Query the single cache authority and
   * avoid stale-after-write reads from the SDK's own cache. Default behavior
   * (config unset) is unchanged — caching stays ON.
   */
  describe('per-instance cache disable', () => {
    it('never serves a cached GET when enableCache is false', async () => {
      const http = new HttpService({
        baseURL: 'http://test.invalid',
        enableRetry: false,
        requestTimeout: 1000,
        enableCache: false,
      });
      http.setTokens(makeJwt({ userId: 'user-1' }));

      fetchMock.mockResolvedValueOnce(jsonResponse({ v: 1 }));
      const first = await http.get<{ v: number }>('/some/resource', { cache: true });
      expect(first.v).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // A second identical read with cache:true must STILL hit the network,
      // because the instance cache is disabled. Nothing is ever stored.
      fetchMock.mockResolvedValueOnce(jsonResponse({ v: 2 }));
      const second = await http.get<{ v: number }>('/some/resource', { cache: true });
      expect(second.v).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(http.getCacheStats().size).toBe(0);
    });

    it('treats cacheTTL <= 0 as a disabled cache', async () => {
      const http = new HttpService({
        baseURL: 'http://test.invalid',
        enableRetry: false,
        requestTimeout: 1000,
        cacheTTL: 0,
      });
      http.setTokens(makeJwt({ userId: 'user-1' }));

      fetchMock.mockResolvedValueOnce(jsonResponse({ v: 1 }));
      await http.get('/some/resource', { cache: true });
      fetchMock.mockResolvedValueOnce(jsonResponse({ v: 2 }));
      await http.get('/some/resource', { cache: true });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(http.getCacheStats().size).toBe(0);
    });

    it('still caches by default (config unset) — no behavior change', async () => {
      const http = new HttpService({
        baseURL: 'http://test.invalid',
        enableRetry: false,
        requestTimeout: 1000,
      });
      http.setTokens(makeJwt({ userId: 'user-1' }));

      fetchMock.mockResolvedValueOnce(jsonResponse({ v: 1 }));
      const first = await http.get<{ v: number }>('/some/resource', { cache: true });
      // Second read is a warm cache hit — no second network call.
      const second = await http.get<{ v: number }>('/some/resource', { cache: true });

      expect(first).toEqual(second);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
