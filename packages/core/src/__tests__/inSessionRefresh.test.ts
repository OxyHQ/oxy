/**
 * In-session access-token refresh plumbing.
 *
 * These guard the HttpService surface that `@oxyhq/services`' OxyContext now
 * drives via `setAuthRefreshHandler`: a 401 re-mints through the handler and
 * retries the ORIGINAL request with the fresh token; an unrecoverable refresh
 * clears tokens and notifies listeners (the reconcile signal that flips the RN
 * provider out of its zombie logged-in state); concurrent refreshes coalesce and
 * a failed refresh is cooldown-guarded (no refresh storm). Plus the new
 * `OxyServices.getAccessTokenExpiry()` helper the proactive scheduler reads.
 */
import { HttpService } from '../HttpService';
import { OxyServices } from '../OxyServices';

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

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'token expired' }), {
    status: 401,
    statusText: 'Unauthorized',
    headers: { 'content-type': 'application/json' },
  });
}

function readHeaders(init: RequestInit | undefined): Record<string, string> {
  const headers = init?.headers;
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}

const farFutureExp = (): number => Math.floor(Date.now() / 1000) + 3600;

describe('HttpService in-session refresh handler', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('refreshes via the handler on a 401 and retries the original request with the fresh token', async () => {
    const oldToken = createJwt({ userId: 'u', exp: farFutureExp(), jti: 'old' });
    const newToken = createJwt({ userId: 'u', exp: farFutureExp(), jti: 'new' });
    const calls: FetchCall[] = [];
    let feedAttempts = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/feed')) {
        feedAttempts += 1;
        if (feedAttempts === 1) return unauthorized();
      }
      return jsonResponse({ ok: true });
    };

    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    http.setTokens(oldToken);

    let handlerCalls = 0;
    const reasons: string[] = [];
    http.setAuthRefreshHandler(async (reason) => {
      handlerCalls += 1;
      reasons.push(reason);
      // Simulate a silent arm planting the rotated token internally.
      http.setTokens(newToken);
      return newToken;
    });

    const result = await http.post('/feed', { cursor: 0 }, { retry: false });

    expect(result).toEqual({ ok: true });
    expect(handlerCalls).toBe(1);
    expect(reasons).toEqual(['response-401']);

    const feedCalls = calls.filter((call) => call.url.endsWith('/feed'));
    expect(feedCalls).toHaveLength(2);
    // The original request is retried carrying the FRESH bearer.
    expect(readHeaders(feedCalls[1].init).Authorization).toBe(`Bearer ${newToken}`);
    expect(http.getAccessToken()).toBe(newToken);
  });

  it('clears tokens and notifies listeners when the handler cannot refresh on a 401 (reconcile signal)', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/feed')) return unauthorized();
      return jsonResponse({ ok: true });
    };

    const oxy = new OxyServices({ baseURL: 'https://api.mention.earth' });
    oxy.setTokens(createJwt({ userId: 'u', exp: farFutureExp() }));

    const tokenEvents: Array<string | null> = [];
    oxy.onTokensChanged((token) => tokenEvents.push(token));

    oxy.getClient().setAuthRefreshHandler(async () => null);

    await expect(oxy.getClient().post('/feed', {}, { retry: false })).rejects.toBeDefined();

    // The dead session reconciles: token cleared + a null change emitted (which
    // OxyContext's `handleTokenChange(null)` turns into a local sign-out).
    expect(oxy.getAccessToken()).toBeNull();
    expect(tokenEvents).toContain(null);
  });

  it('coalesces concurrent refreshes into a single handler invocation', async () => {
    globalThis.fetch = async () => jsonResponse({ ok: true });
    const newToken = createJwt({ userId: 'u', exp: farFutureExp(), jti: 'fresh' });

    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    http.setTokens(createJwt({ userId: 'u', exp: farFutureExp() }));

    let handlerCalls = 0;
    http.setAuthRefreshHandler(async () => {
      handlerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      http.setTokens(newToken);
      return newToken;
    });

    const [a, b, c] = await Promise.all([
      http.refreshAccessToken('preflight'),
      http.refreshAccessToken('preflight'),
      http.refreshAccessToken('preflight'),
    ]);

    expect(handlerCalls).toBe(1);
    expect([a, b, c]).toEqual([newToken, newToken, newToken]);
  });

  it('cooldown-guards a failed refresh so it does not storm the handler', async () => {
    globalThis.fetch = async () => jsonResponse({ ok: true });

    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    http.setTokens(createJwt({ userId: 'u', exp: farFutureExp() }));

    let handlerCalls = 0;
    http.setAuthRefreshHandler(async () => {
      handlerCalls += 1;
      return null;
    });

    const first = await http.refreshAccessToken('preflight');
    const second = await http.refreshAccessToken('preflight');

    expect(first).toBeNull();
    expect(second).toBeNull();
    // The second call is inside the post-failure cooldown → handler not re-run.
    expect(handlerCalls).toBe(1);
  });

  it('lets an EXPIRED token re-mint promptly instead of waiting out the long proactive cooldown', async () => {
    // Regression: an ECS rolling-deploy blip briefly fails a mint; the 15s
    // proactive cooldown then left the client forwarding/omitting a now-expired
    // bearer for up to 15s after the endpoint recovered (Mention /privacy 401s).
    // An already-expired token must recover on the short cooldown instead.
    globalThis.fetch = async () => jsonResponse({ ok: true });
    const nowSpy = jest.spyOn(Date, 'now');
    const T0 = 1_000_000_000_000;
    nowSpy.mockReturnValue(T0);

    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    // Current token is already 10s past exp (exp is in SECONDS).
    http.setTokens(createJwt({ userId: 'u', exp: Math.floor(T0 / 1000) - 10 }));

    let handlerCalls = 0;
    http.setAuthRefreshHandler(async () => {
      handlerCalls += 1;
      return null;
    });

    // First attempt fails → records the failure timestamp.
    await http.refreshAccessToken('preflight');
    expect(handlerCalls).toBe(1);

    // 500ms later: still inside the SHORT expired cooldown → NOT re-run. This is
    // the storm guard — an expired token does not fully bypass the cooldown.
    nowSpy.mockReturnValue(T0 + 500);
    await http.refreshAccessToken('preflight');
    expect(handlerCalls).toBe(1);

    // 1.5s later: past the short expired cooldown but WELL inside the 15s
    // proactive cooldown → the expired token re-mints promptly.
    nowSpy.mockReturnValue(T0 + 1500);
    await http.refreshAccessToken('preflight');
    expect(handlerCalls).toBe(2);

    nowSpy.mockRestore();
  });

  it('keeps the full 15s cooldown for a still-valid (proactive) near-expiry refresh', async () => {
    globalThis.fetch = async () => jsonResponse({ ok: true });
    const nowSpy = jest.spyOn(Date, 'now');
    const T0 = 1_000_000_000_000;
    nowSpy.mockReturnValue(T0);

    const http = new HttpService({ baseURL: 'https://api.mention.earth', enableRetry: false });
    // Token is still valid for another hour — a proactive refresh, not expired.
    http.setTokens(createJwt({ userId: 'u', exp: Math.floor(T0 / 1000) + 3600 }));

    let handlerCalls = 0;
    http.setAuthRefreshHandler(async () => {
      handlerCalls += 1;
      return null;
    });

    await http.refreshAccessToken('preflight');
    expect(handlerCalls).toBe(1);

    // 1.5s later: past the short expired cooldown, but the token is NOT expired,
    // so the full proactive cooldown still applies → no re-run (no storm).
    nowSpy.mockReturnValue(T0 + 1500);
    await http.refreshAccessToken('preflight');
    expect(handlerCalls).toBe(1);

    nowSpy.mockRestore();
  });
});

describe('OxyServices.getAccessTokenExpiry', () => {
  it('returns the JWT exp (seconds) of the current access token', () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    const exp = Math.floor(Date.now() / 1000) + 1234;
    oxy.setTokens(createJwt({ userId: 'u', exp }));
    expect(oxy.getAccessTokenExpiry()).toBe(exp);
  });

  it('returns null when there is no access token', () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    expect(oxy.getAccessTokenExpiry()).toBeNull();
  });

  it('returns null for an opaque / non-JWT token', () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    oxy.setTokens('opaque-not-a-jwt');
    expect(oxy.getAccessTokenExpiry()).toBeNull();
  });

  it('returns null for a JWT with no numeric exp claim', () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    oxy.setTokens(createJwt({ userId: 'u' }));
    expect(oxy.getAccessTokenExpiry()).toBeNull();
  });
});
