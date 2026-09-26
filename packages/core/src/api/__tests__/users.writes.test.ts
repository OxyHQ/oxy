/**
 * `users` writes and pre-session reads.
 *
 * - `updateMe` must make every identity read and the account forest stale in
 *   ONE pass over the cache, and a 401 with no token held must surface as the
 *   offline-session marker.
 * - `deleteMe` sends the reauth proof as-is.
 * - `byPublicKey` is a pre-session lookup: no bearer, no preflight.
 * - `bySessions` sorts and dedupes ids so the POST body is a stable key.
 */
import { OxyServices } from '../../OxyServices';
import { OxyApiError } from '../../OxyServices.errors';

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload })}.sig`;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(status < 400 ? { data } : data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('users writes', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  let oxy: OxyServices;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    oxy = new OxyServices({ baseURL: 'http://test.invalid', enableRetry: false });
    oxy.session.setAccessToken(makeJwt({ userId: 'me' }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('updateMe busts identity reads and the account forest in one pass', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'me', username: 'me', name: { displayName: 'Me' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'me', username: 'me', name: { displayName: 'Me' } }));
    await oxy.users.get('me');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const invalidate = jest.spyOn(oxy.http, 'invalidateCache');
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'me', username: 'me', name: { displayName: 'New' } }));
    await oxy.users.updateMe({ bio: 'hi' });

    expect(invalidate).toHaveBeenCalledTimes(1);
    const [spec] = invalidate.mock.calls[0];
    expect(spec.keys).toEqual(expect.arrayContaining(['GET:/users/me', 'GET:/accounts', 'GET:/accounts/me']));
    expect(spec.prefixes).toEqual(expect.arrayContaining(['GET:/users/me', 'GET:/profiles/username/', 'GET:/accounts?']));

    // The cached `get` is gone: the next read hits the network.
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'me', username: 'me', name: { displayName: 'New' } }));
    const fresh = await oxy.users.get('me');
    expect(fresh.name.displayName).toBe('New');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('updateMe turns a 401 with no token into the offline-session marker', async () => {
    oxy.session.clear();
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Authentication required' }, 401));
    await expect(oxy.users.updateMe({ bio: 'x' })).rejects.toThrow(/^AUTH_REQUIRED_OFFLINE_SESSION/);
  });

  it('updateMe rejects with OxyApiError on any other failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'nope', code: 'VALIDATION_ERROR' }, 400));
    const error = await oxy.users.updateMe({ bio: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OxyApiError);
    expect(error).toMatchObject({ status: 400 });
  });

  it('deleteMe sends the email reauth proof', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'deleted' }));
    const reauth = { emailCode: { verificationId: 'v', code: '123456' } };
    await oxy.users.deleteMe('me', { reauth });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://test.invalid/users/me');
    expect(init?.method).toBe('DELETE');
    expect(JSON.parse(String(init?.body))).toEqual({ confirmText: 'me', reauth });
  });

  it('byPublicKey sends no bearer', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'u1', username: 'u1', name: { displayName: 'U' } }));
    await oxy.users.byPublicKey('02abc');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://test.invalid/auth/user/02abc');
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('bySessions sends sorted unique ids and normalises null users', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { sessionId: 'a', user: { id: 'u', username: 'u', name: { displayName: 'U' } } },
        { sessionId: 'b', user: null },
      ]),
    );
    const result = await oxy.users.bySessions(['b', 'a', 'b']);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ sessionIds: ['a', 'b'] });
    expect(result[1].user).toBeNull();
    await expect(oxy.users.bySessions([])).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
