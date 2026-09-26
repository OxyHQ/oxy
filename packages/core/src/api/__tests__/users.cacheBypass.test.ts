/**
 * Per-call cache-bypass tests for `users.get` / `users.byUsername`.
 *
 * Both mixin methods cache their GET response for 5 minutes via
 * `HttpService`'s identity-scoped TTL cache. A consumer that just wrote a
 * setting readable through one of these endpoints (e.g. Mention's federation
 * consent flag) needs a way to force a registry-fresh read instead of
 * silently getting served the pre-write snapshot for up to 5 minutes.
 *
 * These tests pin down that:
 *  - default behavior is UNCHANGED: a second call within the TTL is served
 *    from cache (no second network call),
 *  - `{ cache: false }` always hits the network, even immediately after a
 *    cached call, and never overwrites the still-live cached entry — a
 *    subsequent default-cache call keeps serving the ORIGINAL cached value.
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

describe('users.get / users.byUsername cache bypass', () => {
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

  describe('users.get', () => {
    it('default call: a second read within the TTL is served from cache', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'user-1', username: 'alice' }));
      const first = await oxy.users.get('user-1');
      expect(first.username).toBe('alice');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const second = await oxy.users.get('user-1');
      expect(second.username).toBe('alice');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('{ cache: false } always hits the network, even right after a cached call', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'user-1', username: 'alice' }));
      await oxy.users.get('user-1');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'user-1', username: 'alice-renamed' }));
      const fresh = await oxy.users.get('user-1', { cache: false });
      expect(fresh.username).toBe('alice-renamed');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('{ cache: false } does not overwrite the still-live cached entry', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'user-1', username: 'alice' }));
      await oxy.users.get('user-1');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Bypass read observes server-side truth that has since changed...
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'user-1', username: 'alice-renamed' }));
      await oxy.users.get('user-1', { cache: false });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // ...but a plain cached read afterward still serves the ORIGINAL cached
      // value — the bypass call never wrote to the cache slot.
      const cached = await oxy.users.get('user-1');
      expect(cached.username).toBe('alice');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('users.byUsername', () => {
    it('default call: a second read within the TTL is served from cache', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'user-2', username: 'bob' }));
      const first = await oxy.users.byUsername('bob');
      expect(first.id).toBe('user-2');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const second = await oxy.users.byUsername('bob');
      expect(second.id).toBe('user-2');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('{ cache: false } always hits the network, even right after a cached call', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'user-2', username: 'bob', bio: 'old' }));
      await oxy.users.byUsername('bob');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'user-2', username: 'bob', bio: 'new' }));
      const fresh = await oxy.users.byUsername('bob', { cache: false });
      expect((fresh as unknown as { bio: string }).bio).toBe('new');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('URL-encodes the username in the request path', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'fed-1', username: 'alice@mastodon.social' }));
      await oxy.users.byUsername('alice@mastodon.social');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain('/profiles/username/alice%40mastodon.social');
    });
  });
});
