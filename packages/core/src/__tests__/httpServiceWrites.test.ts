import { HttpService } from '../HttpService';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
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

/**
 * Writes carry exactly one credential: the bearer, when there is one. Oxy's API
 * has no CSRF layer (issue #1044) and the SDK neither fetches `/csrf-token` nor
 * sends `X-CSRF-Token` / `X-Native-App`, for its own API or a linked one.
 */
describe('HttpService writes', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function recordFetches(respond: (url: string) => Response = () => jsonResponse({ ok: true })): FetchCall[] {
    const calls: FetchCall[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      return respond(url);
    };
    return calls;
  }

  it('sends a bearer-authenticated write as a single request', async () => {
    const calls = recordFetches();

    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    const accessToken = createJwt({
      userId: 'user_1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    http.setTokens(accessToken);

    await http.post('/posts', { text: 'hello' });

    expect(calls.map((call) => call.url)).toEqual(['https://api.mention.earth/posts']);
    const headers = readHeaders(calls[0].init);
    expect(headers.Authorization).toBe(`Bearer ${accessToken}`);
    expect(headers['X-CSRF-Token']).toBeUndefined();
    expect(headers['X-Native-App']).toBeUndefined();
  });

  it('sends a write without a bearer as a single request with no CSRF preflight', async () => {
    const calls = recordFetches();

    const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });

    await http.post('/users/by-ids', { ids: ['user_1'] });

    // POSITIVE CONTROL: the write itself went out, so the absence below is not
    // the absence of any request at all.
    expect(calls.map((call) => call.url)).toEqual(['https://api.oxy.so/users/by-ids']);
    const headers = readHeaders(calls[0].init);
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-CSRF-Token']).toBeUndefined();
    expect(headers['X-Native-App']).toBeUndefined();
  });

  it('keeps a valid near-expiry bearer token when preflight refresh cannot refresh', async () => {
    const calls = recordFetches();

    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    const accessToken = createJwt({
      userId: 'user_1',
      exp: Math.floor(Date.now() / 1000) + 30,
    });
    let refreshAttempts = 0;
    http.setTokens(accessToken);
    http.setAuthRefreshHandler(async () => {
      refreshAttempts += 1;
      return null;
    });

    await http.post('/posts', { text: 'hello' });

    expect(refreshAttempts).toBe(1);
    expect(calls.map((call) => call.url)).toEqual(['https://api.mention.earth/posts']);
    expect(readHeaders(calls[0].init).Authorization).toBe(`Bearer ${accessToken}`);
  });

  it('does not use an expired bearer token when preflight refresh cannot refresh', async () => {
    const calls = recordFetches();

    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    const accessToken = createJwt({
      userId: 'user_1',
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    let refreshAttempts = 0;
    http.setTokens(accessToken);
    http.setAuthRefreshHandler(async () => {
      refreshAttempts += 1;
      return null;
    });

    await http.post('/posts', { text: 'hello' });

    expect(refreshAttempts).toBe(1);
    expect(calls.map((call) => call.url)).toEqual(['https://api.mention.earth/posts']);
    expect(readHeaders(calls[0].init).Authorization).toBeUndefined();
  });

  it('does not retry a 403, whatever its code says', async () => {
    const calls = recordFetches(
      () =>
        new Response(JSON.stringify({ code: 'CSRF_TOKEN_INVALID' }), {
          status: 403,
          statusText: 'Forbidden',
          headers: { 'content-type': 'application/json' },
        }),
    );

    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });

    await expect(http.post('/posts', { text: 'hello' })).rejects.toBeDefined();
    expect(calls.map((call) => call.url)).toEqual(['https://api.mention.earth/posts']);
  });

  it('includes credentials for configured API origin requests', async () => {
    const calls = recordFetches();

    const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });

    await http.get('/users/me');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.oxy.so/users/me');
    expect(calls[0].init?.credentials).toBe('include');
  });

  it('omits credentials for caller-supplied absolute URLs outside the configured API origin', async () => {
    const calls = recordFetches();

    const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });

    await http.get('https://attacker.oxy.so/collect');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://attacker.oxy.so/collect');
    expect(calls[0].init?.credentials).toBe('omit');
  });
});
