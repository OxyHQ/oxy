import { OxyServices } from '../OxyServices';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function createServices(): OxyServices {
  return new OxyServices({ baseURL: 'https://api.oxy.so' });
}

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function readHeaders(init: RequestInit | undefined): Record<string, string> {
  const headers = init?.headers;
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers as Record<string, string>;
}

describe('OxyServices.createLinkedClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('mirrors token changes from the session owner', () => {
    const oxy = createServices();
    const linked = oxy.createLinkedClient({ baseURL: 'https://api.syra.fm' });

    expect(linked.client.getAccessToken()).toBeNull();

    oxy.setTokens('access_1');
    expect(linked.client.getAccessToken()).toBe('access_1');

    oxy.setTokens('access_2');
    expect(linked.client.getAccessToken()).toBe('access_2');

    oxy.clearTokens();
    expect(linked.client.getAccessToken()).toBeNull();

    linked.dispose();
  });

  it('copies the current token when created after sign-in', () => {
    const oxy = createServices();
    oxy.setTokens('existing_access');

    const linked = oxy.createLinkedClient({ baseURL: 'https://api.syra.fm' });

    expect(linked.client.getAccessToken()).toBe('existing_access');

    linked.dispose();
  });

  it('delegates token refresh to the session owner', async () => {
    const oxy = createServices();
    const linked = oxy.createLinkedClient({ baseURL: 'https://api.syra.fm' });

    oxy.getClient().setAuthRefreshHandler(async () => 'refreshed_access');

    const refreshed = await linked.client.refreshAccessToken('preflight');

    expect(refreshed).toBe('refreshed_access');
    expect(oxy.getAccessToken()).toBe('refreshed_access');
    expect(linked.client.getAccessToken()).toBe('refreshed_access');

    linked.dispose();
  });

  it('returns an unread authenticated streaming response', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response('data: {"delta":"hello"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const oxy = createServices();
    const accessToken = createJwt({
      userId: 'user_1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    oxy.setTokens(accessToken);
    const linked = oxy.createLinkedClient({ baseURL: 'https://api.alia.onl/' });

    const response = await linked.client.requestAuthenticatedResponse({
      method: 'POST',
      url: '/alia/chat',
      body: JSON.stringify({ message: 'hello' }),
      headers: {
        Authorization: 'Bearer caller_supplied_token',
        'Content-Type': 'application/json',
      },
    });

    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe('data: {"delta":"hello"}\n\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.alia.onl/alia/chat');
    expect(readHeaders(calls[0]?.init).authorization).toBe(`Bearer ${accessToken}`);

    linked.dispose();
  });

  it('refreshes once after a streaming response 401 and keeps the final body unread', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        return new Response('expired', { status: 401 });
      }
      return new Response('data: done\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const oxy = createServices();
    const oldToken = createJwt({
      userId: 'user_1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const refreshedToken = createJwt({
      userId: 'user_1',
      exp: Math.floor(Date.now() / 1000) + 7200,
    });
    oxy.setTokens(oldToken);
    oxy.getClient().setAuthRefreshHandler(async () => refreshedToken);
    const linked = oxy.createLinkedClient({ baseURL: 'https://api.alia.onl' });

    const response = await linked.client.requestAuthenticatedResponse({
      method: 'POST',
      url: '/alia/chat',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(calls).toHaveLength(2);
    expect(readHeaders(calls[0]?.init).authorization).toBe(`Bearer ${oldToken}`);
    expect(readHeaders(calls[1]?.init).authorization).toBe(`Bearer ${refreshedToken}`);
    expect(oxy.getAccessToken()).toBe(refreshedToken);
    expect(linked.client.getAccessToken()).toBe(refreshedToken);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe('data: done\n\n');

    linked.dispose();
  });

  it('rejects an authenticated streaming request before fetch without a session', async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const oxy = createServices();
    const linked = oxy.createLinkedClient({ baseURL: 'https://api.alia.onl' });

    await expect(linked.client.requestAuthenticatedResponse({
      method: 'POST',
      url: '/alia/chat',
      body: '{}',
    })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      status: 401,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    linked.dispose();
  });

  it('keeps the session owner intact when a linked response 401 cannot refresh', async () => {
    const oxy = createServices();
    oxy.setTokens('stale_access');
    const linked = oxy.createLinkedClient({ baseURL: 'https://api.syra.fm' });

    const refreshed = await linked.client.refreshAccessToken('response-401');

    expect(refreshed).toBeNull();
    expect(oxy.getAccessToken()).toBe('stale_access');
    expect(linked.client.getAccessToken()).toBe('stale_access');

    linked.dispose();
  });

  it('resynchronizes from the session owner after a linked app 401 clears the local token', async () => {
    const calls: FetchCall[] = [];
    let queueWriteAttempts = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.endsWith('/csrf-token')) {
        return new Response(JSON.stringify({ csrfToken: 'csrf_1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/api/queue/current')) {
        queueWriteAttempts += 1;
        if (queueWriteAttempts === 1) {
          return new Response(JSON.stringify({ error: 'MISSING_TOKEN' }), {
            status: 401,
            statusText: 'Unauthorized',
            headers: { 'content-type': 'application/json' },
          });
        }
      }

      return jsonResponse({ ok: true });
    };

    const oxy = createServices();
    const accessToken = createJwt({
      userId: 'user_1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    oxy.setTokens(accessToken);
    oxy.getClient().setAuthRefreshHandler(async () => null);
    const linked = oxy.createLinkedClient({ baseURL: 'https://api.syra.fm' });

    await expect(linked.client.put('/api/queue/current', { trackId: 'track_1' }, { retry: false })).rejects.toMatchObject({
      message: 'MISSING_TOKEN',
      status: 401,
    });

    expect(oxy.getAccessToken()).toBe(accessToken);
    expect(linked.client.getAccessToken()).toBeNull();

    await linked.client.put('/api/queue/current', { trackId: 'track_2' });

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.syra.fm/api/queue/current',
      'https://api.syra.fm/api/queue/current',
    ]);
    expect(linked.client.getAccessToken()).toBe(accessToken);

    const firstHeaders = readHeaders(calls[0]?.init);
    expect(firstHeaders.Authorization).toBe(`Bearer ${accessToken}`);
    expect(firstHeaders['X-CSRF-Token']).toBeUndefined();

    const secondHeaders = readHeaders(calls[1]?.init);
    expect(secondHeaders.Authorization).toBe(`Bearer ${accessToken}`);
    expect(secondHeaders['X-CSRF-Token']).toBeUndefined();

    linked.dispose();
  });

  it('keeps the session owner intact when linked preflight refresh cannot refresh', async () => {
    const oxy = createServices();
    oxy.setTokens('existing_access');
    const linked = oxy.createLinkedClient({ baseURL: 'https://api.syra.fm' });

    const refreshed = await linked.client.refreshAccessToken('preflight');

    expect(refreshed).toBeNull();
    expect(oxy.getAccessToken()).toBe('existing_access');
    expect(linked.client.getAccessToken()).toBe('existing_access');

    linked.dispose();
  });

  it('stops mirroring after dispose', () => {
    const oxy = createServices();
    const linked = oxy.createLinkedClient({ baseURL: 'https://api.syra.fm' });

    oxy.setTokens('before_dispose');
    expect(linked.client.getAccessToken()).toBe('before_dispose');

    linked.dispose();
    oxy.setTokens('after_dispose');

    expect(linked.client.getAccessToken()).toBeNull();
  });

  it('joins linked base URLs with relative paths that omit the leading slash', async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const oxy = createServices();
    const linked = oxy.createLinkedClient({ baseURL: 'https://api.mention.earth' });

    await linked.client.get('profile/settings/me');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.mention.earth/profile/settings/me');

    linked.dispose();
  });

  /**
   * GET response caching is OFF by default for linked clients: the SDK cannot
   * invalidate the consumer backend's resources, so a cached GET there would
   * serve stale data after the app mutates its own data. The consumer's own
   * layer (React Query / stores) owns caching. An explicit `enableCache: true`
   * opts back in.
   */
  describe('linked client GET cache default', () => {
    it('does NOT cache GETs by default — every read hits the network', async () => {
      const fetchMock = jest.fn();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const oxy = createServices();
      const accessToken = createJwt({
        userId: 'user_1',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      oxy.setTokens(accessToken);
      const linked = oxy.createLinkedClient({ baseURL: 'https://api.mention.earth' });

      // Two identical GETs with cache:true — both MUST hit the network because
      // the linked client's cache is disabled by default.
      fetchMock.mockResolvedValueOnce(jsonResponse({ v: 1 }));
      const first = await linked.client.get<{ v: number }>('/feed/mtn', { cache: true });
      fetchMock.mockResolvedValueOnce(jsonResponse({ v: 2 }));
      const second = await linked.client.get<{ v: number }>('/feed/mtn', { cache: true });

      expect(first.v).toBe(1);
      expect(second.v).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      linked.dispose();
    });

    it('caches GETs when the caller explicitly opts in with enableCache: true', async () => {
      const fetchMock = jest.fn();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const oxy = createServices();
      const accessToken = createJwt({
        userId: 'user_1',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      oxy.setTokens(accessToken);
      const linked = oxy.createLinkedClient({
        baseURL: 'https://api.mention.earth',
        enableCache: true,
      });

      // Second identical GET is a warm cache hit — only one network call.
      fetchMock.mockResolvedValueOnce(jsonResponse({ v: 1 }));
      const first = await linked.client.get<{ v: number }>('/feed/mtn', { cache: true });
      const second = await linked.client.get<{ v: number }>('/feed/mtn', { cache: true });

      expect(first).toEqual(second);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      linked.dispose();
    });
  });
});
