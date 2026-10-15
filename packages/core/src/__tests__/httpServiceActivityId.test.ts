import { HttpService } from '../HttpService';

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

function browserRuntime(): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {} });
}

describe('HttpService browser activity identifier', () => {
  const originalFetch = globalThis.fetch;
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
    if (originalDocumentDescriptor) {
      Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
    jest.restoreAllMocks();
  });

  it('adds the runtime identifier after caller headers', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {},
    });
    const fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });
    await http.get('/session/status', {
      headers: { 'X-Oxy-Activity-Id': 'caller-controlled' },
    });

    const requestHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(requestHeaders['X-Oxy-Activity-Id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(requestHeaders['X-Oxy-Activity-Id']).not.toBe('caller-controlled');
  });

  describe('never turns a simple cross-origin request into a preflighted one', () => {
    function mockFetch(): jest.Mock {
      const fetchMock = jest.fn(
        async () =>
          new Response(JSON.stringify({ data: { ok: true } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      return fetchMock;
    }

    function sentHeaders(fetchMock: jest.Mock): Record<string, string> {
      return (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    }

    it('an anonymous GET carries only safelisted headers: no Content-Type, no telemetry', async () => {
      browserRuntime();
      const fetchMock = mockFetch();
      const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });

      await http.get('/auth/oauth/client/oxy_dk_public', { skipAuth: true });

      expect(sentHeaders(fetchMock)).toEqual({ Accept: 'application/json' });
    });

    it('an authenticated GET (preflighted anyway) still carries the activity id', async () => {
      browserRuntime();
      const fetchMock = mockFetch();
      const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });
      http.setTokens(createJwt({ userId: 'u', exp: Math.floor(Date.now() / 1000) + 3600 }));

      await http.get('/users/me');

      const headers = sentHeaders(fetchMock);
      expect(headers.Authorization).toMatch(/^Bearer /);
      expect(headers['Content-Type']).toBeUndefined();
      expect(headers['X-Oxy-Activity-Id']).toEqual(expect.any(String));
    });

    it('a JSON write keeps its Content-Type and carries the activity id', async () => {
      browserRuntime();
      const fetchMock = mockFetch();
      const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });

      await http.post('/users/by-ids', { ids: ['a'] });

      const headers = sentHeaders(fetchMock);
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-Oxy-Activity-Id']).toEqual(expect.any(String));
    });

    it('requestResponse: an anonymous GET stays simple; a custom header brings telemetry back', async () => {
      browserRuntime();
      const fetchMock = mockFetch();
      const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });

      await http.requestResponse({ method: 'GET', url: '/public/feed', fetch: fetchMock });
      const simple = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
      expect([...simple.keys()]).toEqual(['accept']);

      await http.requestResponse({
        method: 'GET',
        url: '/public/feed',
        headers: { 'X-Custom': '1' },
        fetch: fetchMock,
      });
      const preflighted = new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers);
      expect(preflighted.get('x-oxy-activity-id')).toEqual(expect.any(String));
    });
  });
});
