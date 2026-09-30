/**
 * Auth self-await regression.
 *
 * The refresh handler (arm 2 Commons-identity sign-in) calls PRE-SESSION public
 * endpoints (`/auth/challenge`, `/auth/verify`, the commons-signin surface, …)
 * from INSIDE the single-flight `tokenRefreshPromise`. If any of those carried
 * an auth preflight (no `skipAuth`), its `getAuthHeader` would call
 * `refreshAccessToken`, find the handler's own promise already in flight, and
 * await it — the handler awaiting itself → permanent hang (no deadline on the
 * auto-connect lane makes it visible). `skipAuth` on every pre-session public
 * endpoint is what prevents this; these tests lock the invariant.
 */
import { HttpService } from '../HttpService';

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

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Resolve to `true` if `promise` settles within `ms`, else `false`. Always
 *  clears its timer so no pending timeout leaks into jest's teardown. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('HttpService auth self-await', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('a skipAuth request issued from INSIDE the refresh handler resolves (no self-await)', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/challenge')) return jsonResponse({ challenge: 'c' });
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });
    // Near-expiry → the data request's preflight starts the refresh.
    http.setTokens(createJwt({ userId: 'u', exp: nowSec() + 30 }));

    http.setAuthRefreshHandler(async () => {
      // Mirror arm 2: from inside the handler, hit a pre-session public endpoint.
      // With skipAuth it does NOT re-enter refreshAccessToken; without it, its
      // preflight would await THIS handler's own pending promise → self-await.
      await http.post('/auth/challenge', { publicKey: 'p' }, { skipAuth: true, retry: false });
      const fresh = createJwt({ userId: 'u', exp: nowSec() + 3600, jti: 'fresh' });
      http.setTokens(fresh);
      return fresh;
    });

    expect(await settlesWithin(http.get('/data'), 500)).toBe(true);
  });

  it('a skipAuth public request does NOT await a pending refresh', async () => {
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/challenge')) return jsonResponse({ challenge: 'c' });
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });
    http.setTokens(createJwt({ userId: 'u', exp: nowSec() + 30 }));

    http.setAuthRefreshHandler(async () => {
      await refreshGate; // hold the refresh open
      const fresh = createJwt({ userId: 'u', exp: nowSec() + 3600, jti: 'fresh' });
      http.setTokens(fresh);
      return fresh;
    });

    // A data request whose preflight starts (and blocks on) the held refresh.
    const data = http.get('/data');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A skipAuth public request must settle WITHOUT waiting for the held refresh.
    const pub = http.post('/auth/challenge', { publicKey: 'p' }, { skipAuth: true, retry: false });
    expect(await settlesWithin(pub, 300)).toBe(true);

    releaseRefresh?.();
    await data;
  });
});
