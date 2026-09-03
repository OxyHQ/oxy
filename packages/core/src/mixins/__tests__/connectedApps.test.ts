/**
 * Connected-apps (OAuth grants) SDK tests.
 *
 * `listConnectedApps()` reads the user's authorized applications from
 * `GET /auth/grants` and caches the response (identity-scoped). `revokeAppGrant`
 * deletes a grant via `DELETE /auth/grants/:applicationId` and MUST invalidate
 * the cached `GET:/auth/grants` so a re-read observes the removal instead of the
 * STALE pre-revoke list (mirrors the privacy/follow invalidation contract).
 */

import { OxyServices } from '../../OxyServices';
import type { ConnectedApp } from '../OxyServices.connectedApps';

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

const APP_A: ConnectedApp = {
  applicationId: 'app-a',
  name: 'App A',
  logoUrl: 'https://cdn.example/a.png',
  scopes: ['profile', 'email'],
  firstGrantedAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: '2026-06-01T00:00:00.000Z',
};

const APP_B: ConnectedApp = {
  applicationId: 'app-b',
  name: 'App B',
  scopes: ['profile'],
  firstGrantedAt: '2026-02-01T00:00:00.000Z',
  lastUsedAt: '2026-06-02T00:00:00.000Z',
};

describe('connected apps (OAuth grants)', () => {
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

  it('lists connected apps, unwrapping the { data } envelope', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([APP_A, APP_B]));
    const apps = await oxy.listConnectedApps();
    expect(apps).toEqual([APP_A, APP_B]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://test.invalid/auth/grants');
    expect(init?.method).toBe('GET');
  });

  it('caches the list within the TTL (second read is a cache hit)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([APP_A]));
    expect(await oxy.listConnectedApps()).toEqual([APP_A]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second read within the TTL must not hit the network.
    expect(await oxy.listConnectedApps()).toEqual([APP_A]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('revokes a grant via DELETE /auth/grants/:applicationId', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ revoked: true }));
    await expect(oxy.revokeAppGrant('app-a')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://test.invalid/auth/grants/app-a');
    expect(init?.method).toBe('DELETE');
  });

  it('busts the cached list after revokeAppGrant', async () => {
    // 1) Warm the cache.
    fetchMock.mockResolvedValueOnce(jsonResponse([APP_A, APP_B]));
    expect(await oxy.listConnectedApps()).toEqual([APP_A, APP_B]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A second read is a cache hit (no extra network call).
    await oxy.listConnectedApps();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 2) Revoke — must invalidate the cached list.
    fetchMock.mockResolvedValueOnce(jsonResponse({ revoked: true }));
    await oxy.revokeAppGrant('app-a');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 3) Re-read MUST re-fetch and observe the revoked app gone.
    fetchMock.mockResolvedValueOnce(jsonResponse([APP_B]));
    const after = await oxy.listConnectedApps();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(after).toEqual([APP_B]);
  });

  it('invalidates the exact GET:/auth/grants key on revoke', async () => {
    const clearSpy = jest.spyOn(oxy, 'clearCacheEntry');
    fetchMock.mockResolvedValueOnce(jsonResponse({ revoked: true }));
    await oxy.revokeAppGrant('app-a');
    expect(clearSpy).toHaveBeenCalledWith('GET:/auth/grants');
    clearSpy.mockRestore();
  });

  it('lists and revokes resource-bound external MCP clients', async () => {
    const grant = {
      id: 'mcp-grant',
      appSlug: 'noted',
      resource: 'https://mcp.noted.oxy.so',
      scopes: ['notes.read'],
      clientId: 'client-public-id',
      clientName: 'Research client',
      createdAt: '2026-09-03T00:00:00.000Z',
      lastUsedAt: '2026-09-03T01:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ grants: [grant] }))
      .mockResolvedValueOnce(jsonResponse(undefined));

    await expect(oxy.listConnectedMcpClients()).resolves.toEqual([grant]);
    await expect(oxy.revokeConnectedMcpClient('mcp/grant')).resolves.toBeUndefined();

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://test.invalid/auth/mcp/oauth/grants');
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('http://test.invalid/auth/mcp/oauth/grants/mcp%2Fgrant');
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE');
  });
});
