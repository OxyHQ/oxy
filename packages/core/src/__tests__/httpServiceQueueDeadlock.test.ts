/**
 * RequestQueue deadlock regression.
 *
 * The auth preflight (`getAuthHeader` → single-flight `refreshAccessToken` → the
 * device-secret mint) used to run INSIDE a RequestQueue slot, and the mint itself
 * went through the queue. When `maxConcurrentRequests` requests all parked in
 * slots awaiting that same mint, the mint could never acquire a slot to run —
 * a systemic deadlock in which NOTHING settles (observed on a real device: the
 * running count climbs to the pool size with zero settled requests, including a
 * public GET /health). The fix: (1) `bypassQueue` runs control-plane calls (the
 * mint) directly, and (2) the preflight is resolved OUTSIDE the slot, so an
 * auth-blocked request never holds a slot while the shared mint runs.
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

describe('HttpService RequestQueue deadlock', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('runs a bypassQueue control-plane request even when every slot is held', async () => {
    const releases: Array<() => void> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/slow')) {
        // Occupy the slot indefinitely until explicitly released.
        await new Promise<void>((resolve) => releases.push(resolve));
        return jsonResponse({ slow: true });
      }
      return jsonResponse({ minted: true });
    }) as typeof fetch;

    const http = new HttpService({
      baseURL: 'https://api.oxy.so',
      maxConcurrentRequests: 2,
      enableRetry: false,
    });

    // Saturate both slots with requests whose fetch never settles.
    const slowA = http.get('/slow/a', { skipAuth: true });
    const slowB = http.get('/slow/b', { skipAuth: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The device-secret mint (bypassQueue) must still run despite full saturation.
    const mint = http.post(
      '/session/device/token',
      { deviceId: 'd', deviceSecret: 's' },
      { skipAuth: true, bypassQueue: true, retry: false },
    );

    expect(await settlesWithin(mint, 500)).toBe(true);

    for (const release of releases) release();
    await Promise.all([slowA, slowB]);
  });

  it('does not deadlock when a boot burst larger than the pool all trigger the same preflight mint', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Within the 60s refresh lead window → every request's preflight refreshes.
    const nearExpiry = createJwt({ userId: 'u', exp: now + 30 });
    const fresh = createJwt({ userId: 'u', exp: now + 3600, jti: 'fresh' });

    let mintCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/session/device/token')) {
        mintCalls += 1;
        return jsonResponse({ minted: true });
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const http = new HttpService({
      baseURL: 'https://api.oxy.so',
      maxConcurrentRequests: 2,
      enableRetry: false,
    });
    http.setTokens(nearExpiry);

    http.setAuthRefreshHandler(async () => {
      // Mirror refreshDeviceSecretArm: mint via a bypassQueue request through the
      // SAME instance, then plant + return the fresh token.
      await http.post(
        '/session/device/token',
        { deviceId: 'd', deviceSecret: 's' },
        { skipAuth: true, bypassQueue: true, retry: false },
      );
      http.setTokens(fresh);
      return fresh;
    });

    // A boot burst of 4 against a pool of 2, all in the near-expiry window.
    const burst = Promise.all([http.get('/a'), http.get('/b'), http.get('/c'), http.get('/d')]);

    expect(await settlesWithin(burst, 800)).toBe(true);
    // The single-flight refresh coalesces the whole burst into ONE mint.
    expect(mintCalls).toBe(1);
  });
});
