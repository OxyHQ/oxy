/**
 * Linked-accounts SDK surface: the paths, methods and bodies it sends, and the
 * `{ data }` unwrapping. The flow itself is exercised in the API's route tests.
 */

import { OxyServices } from '../../OxyServices';

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const fullPayload = { exp: Math.floor(Date.now() / 1000) + 3600, ...payload };
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(fullPayload)}.sig`;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const LINK = {
  id: 'link-1',
  network: 'activitypub' as const,
  accountKey: 'nate@mastodon.social',
  actorUri: 'https://mastodon.social/users/nate',
  handle: '@nate@mastodon.social',
  host: 'mastodon.social',
  proofMethod: 'oauth' as const,
  verifiedAt: '2026-09-25T00:00:00.000Z',
  createdAt: '2026-09-25T00:00:00.000Z',
};

describe('linked accounts', () => {
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

  it('starts a link with POST /linked-accounts/:network/start and returns the authorize URL', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ authorizeUrl: 'https://mastodon.social/oauth/authorize?x=1', expiresAt: '2026-09-25T00:10:00.000Z' }),
    );
    const started = await oxy.startLinkedAccount('activitypub', {
      instance: 'mastodon.social',
      clientId: 'oxy_dk_move',
      returnTo: 'https://move.oxy.so/linked',
    });
    expect(started.authorizeUrl).toBe('https://mastodon.social/oauth/authorize?x=1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://test.invalid/linked-accounts/activitypub/start');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      instance: 'mastodon.social',
      clientId: 'oxy_dk_move',
      returnTo: 'https://move.oxy.so/linked',
    });
  });

  it('completes a link with POST /linked-accounts/complete and returns the link', async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith('/linked-accounts/complete') ? jsonResponse({ linkedAccount: LINK }) : jsonResponse({ csrfToken: 't'.repeat(32) }),
    );
    expect(await oxy.completeLinkedAccount('one-time-code')).toEqual(LINK);
    const completion = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/linked-accounts/complete'));
    expect(completion?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(completion?.[1]?.body))).toEqual({ code: 'one-time-code' });
  });

  it('lists the live links, unwrapping the envelope, without caching', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ linkedAccounts: [LINK] }));
    expect(await oxy.listLinkedAccounts()).toEqual([LINK]);
    await oxy.listLinkedAccounts();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://test.invalid/linked-accounts');
  });

  it('revokes with DELETE /linked-accounts/:id', async () => {
    // A state-changing request may first fetch a CSRF token; answer anything.
    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse({ csrfToken: 't'.repeat(32) }),
    );
    await oxy.revokeLinkedAccount('link-1');
    const deletion = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(String(deletion?.[0])).toBe('http://test.invalid/linked-accounts/link-1');
  });

  it('reads a user\'s links on the service lane with a service token', async () => {
    const service = new OxyServices({ baseURL: 'http://test.invalid' });
    jest.spyOn(service, 'getServiceToken').mockResolvedValue('service-token');
    fetchMock.mockResolvedValueOnce(jsonResponse({ userId: 'u1', linkedAccounts: [{ ...LINK, federatedUserId: null }] }));
    const result = await service.getLinkedAccountsForUser('u1');
    expect(result.linkedAccounts[0].federatedUserId).toBeNull();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://test.invalid/linked-accounts/by-user/u1');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer service-token');
  });
});
