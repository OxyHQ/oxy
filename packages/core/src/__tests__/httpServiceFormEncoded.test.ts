/**
 * `application/x-www-form-urlencoded` request bodies.
 *
 * Needed because a few endpoints are defined by a standard that fixes their
 * request encoding instead of by our JSON conventions — `POST /auth/oauth/token`
 * (RFC 6749 §4.1.3) is the first. Before this path existed, a `URLSearchParams`
 * payload fell through to `JSON.stringify`, which serialises it to `"{}"`: the
 * request left with an empty body and a JSON content type, and the server saw
 * no parameters at all. That silent failure is what these tests prevent.
 */

import { HttpService } from '../HttpService';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
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

describe('HttpService form-urlencoded bodies', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  /**
   * POST a form body and return the token-endpoint call. Selected by URL
   * because an unauthenticated write is preceded by a `GET /csrf-token`.
   */
  async function postForm(body: URLSearchParams): Promise<FetchCall> {
    const calls: FetchCall[] = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ ok: true });
    };

    const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });
    await http.post('/auth/oauth/token', body, { skipAuth: true, cache: false });

    const tokenCalls = calls.filter((call) => call.url.endsWith('/auth/oauth/token'));
    expect(tokenCalls).toHaveLength(1);
    return tokenCalls[0];
  }

  it('serialises URLSearchParams into the request body', async () => {
    const call = await postForm(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'code-1',
        redirect_uri: 'https://app.example/callback',
      }),
    );

    // Not `"{}"` — the actual encoded parameters.
    expect(call.init?.body).toBe(
      'grant_type=authorization_code&code=code-1&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback',
    );
  });

  it('declares the form content type instead of application/json', async () => {
    const call = await postForm(new URLSearchParams({ grant_type: 'authorization_code' }));

    expect(readHeaders(call.init)['Content-Type']).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    );
  });

  it('percent-encodes values that would otherwise break the encoding', async () => {
    const call = await postForm(new URLSearchParams({ code: 'a+b c&d=e' }));

    expect(call.init?.body).toBe('code=a%2Bb+c%26d%3De');
  });

  it('still sends plain objects as JSON', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ ok: true });
    };

    const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });
    await http.post('/auth/session/claim', { sessionToken: 'abc' }, { skipAuth: true });

    const claimCall = calls.find((call) => call.url.endsWith('/auth/session/claim'));
    expect(claimCall?.init?.body).toBe(JSON.stringify({ sessionToken: 'abc' }));
    expect(readHeaders(claimCall?.init)['Content-Type']).toBe('application/json');
  });

  it('prefers OAuth error_description over the bare error code', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/csrf-token')) {
        return jsonResponse({ csrfToken: 'csrf-test' });
      }
      return new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'The authorization code has expired.',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    };

    const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });
    let caught: unknown;
    try {
      await http.post(
        '/auth/oauth/token',
        new URLSearchParams({ grant_type: 'authorization_code', code: 'expired' }),
        { skipAuth: true, cache: false, deduplicate: false, retry: false },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(String((caught as { message?: string })?.message ?? caught)).toContain(
      'The authorization code has expired.',
    );
  });
});
