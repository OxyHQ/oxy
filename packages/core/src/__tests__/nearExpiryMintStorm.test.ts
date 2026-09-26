/**
 * The near-expiry mint storm that signed a busy app out (OxyHQ/Mention#1140).
 *
 * What the server does: `POST /session/device/token` answers with the session's
 * STORED access token for as long as that token has not expired, and mints a
 * new one only once it is past `exp`. The mint is budgeted at 30/min per device.
 *
 * What the client did with that: the scheduler and the request-time preflight
 * both re-mint 60s before `exp`. The server handed the same token back, which
 * counted as a success (no cooldown), so the scheduler re-armed at its 1s floor
 * and every request re-ran the preflight: ~30 mints in the token's last minute,
 * then a 429, whose 60s cooldown straddled the real expiry. The next request
 * carried no bearer, drew a 401, found the refresh cooling down, and the
 * HttpService cleared the token — which the provider reads as a sign-out.
 *
 * Production logs for the device showed exactly this: a burst of ~30 mints at
 * ~1.4s intervals every ~16 minutes, a single mint ~78s later (the scheduler's
 * 5+10+20+40s backoff through the 60s rate-limit cooldown), and a sign-out on
 * the one cycle where the app was in active use across the expiry.
 *
 * This suite simulates that server against the real HttpService, refresh
 * scheduler and 401 lane.
 */
import { OxyServices } from '../OxyServices';
import { startTokenRefreshScheduler } from '../session/refresh';

const TOKEN_TTL_SECONDS = 15 * 60;
const MINT_BUDGET_PER_MINUTE = 30;

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

function expOf(token: string): number {
  const [, payload] = token.split('.');
  return (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp: number }).exp;
}

/**
 * The device mint as the server implements it, including its rate limiter.
 *
 * `rotateWithinSeconds` is how close to `exp` the stored token may be before the
 * server rotates instead of handing it back: `0` is the server as it was (it
 * rotated only a token already past `exp`), a positive value is the fixed one.
 */
function createMintServer(rotateWithinSeconds: number): {
  mint: () => { status: 200; token: string } | { status: 429 };
  storedToken: () => string;
  mints: number[];
  rateLimited: number;
} {
  let serial = 0;
  const issue = (): string => {
    serial += 1;
    return createJwt({ userId: 'u', jti: `t${serial}`, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS });
  };
  let stored = issue();
  const mints: number[] = [];
  const state = { rateLimited: 0 };
  return {
    mint: () => {
      const now = Date.now();
      if (mints.filter((at) => now - at < 60_000).length >= MINT_BUDGET_PER_MINUTE) {
        state.rateLimited += 1;
        return { status: 429 };
      }
      mints.push(now);
      // `getAccessToken`: hand back the stored token unless it has expired.
      if (expOf(stored) - Math.floor(now / 1000) < (rotateWithinSeconds > 0 ? rotateWithinSeconds : 0)) {
        stored = issue();
      }
      return { status: 200, token: stored };
    },
    storedToken: () => stored,
    mints,
    get rateLimited() {
      return state.rateLimited;
    },
  };
}

describe('a busy app across an access token expiry', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
  });

  async function runBusyApp(rotateWithinSeconds: number): Promise<{
    tokenEvents: Array<string | null>;
    finalToken: string | null;
    server: ReturnType<typeof createMintServer>;
  }> {
    jest.useFakeTimers({ now: new Date('2026-09-25T13:48:00Z') });
    const server = createMintServer(rotateWithinSeconds);

    // The app's own API: 401 without a live bearer, as any resource server does.
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const bearer = headers.Authorization ?? headers.authorization;
      const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : null;
      if (!token || expOf(token) <= Math.floor(Date.now() / 1000)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const oxy = new OxyServices({ baseURL: 'https://api.mention.earth', enableCache: false, enableRetry: false });
    oxy.session.setAccessToken(server.storedToken());
    oxy.http.setAuthRefreshHandler(async (reason) => {
      const answer = server.mint();
      if (answer.status === 429) {
        // What `refreshDeviceSecretArm` does with a 429.
        oxy.http.noteRefreshRateLimited();
        return null;
      }
      oxy.session.setAccessToken(answer.token);
      return answer.token;
    });

    const tokenEvents: Array<string | null> = [];
    oxy.session.onChange((token) => tokenEvents.push(token));
    const scheduler = startTokenRefreshScheduler(oxy);

    // Twenty minutes of an app in use: a request every 700ms, straight across
    // the first token's expiry at 14:03:00.
    for (let elapsed = 0; elapsed < 20 * 60_000; elapsed += 700) {
      await oxy.http.get('/feed').catch(() => undefined);
      await jest.advanceTimersByTimeAsync(700);
    }
    scheduler.dispose();
    return { tokenEvents, finalToken: oxy.session.accessToken, server };
  }

  it('against the server that hands back an unexpired token: never cleared, never rate limited', async () => {
    const { tokenEvents, finalToken, server } = await runBusyApp(0);

    // Before the fix: ~30 mints of the same token, a 429, then the token was
    // cleared (a run of `null` events) and the app was signed out.
    expect(tokenEvents).not.toContain(null);
    expect(finalToken).not.toBeNull();
    expect(server.rateLimited).toBe(0);
    // One rotation. The server still hands the expired token back for the
    // second it expires in (it compares `exp < now`), which costs a few mints in
    // that one second — nowhere near the budget.
    expect(server.mints.length).toBeLessThan(MINT_BUDGET_PER_MINUTE / 3);
  });

  it('against the server that rotates a token near expiry: one mint per rotation', async () => {
    const { tokenEvents, finalToken, server } = await runBusyApp(120);

    expect(tokenEvents).not.toContain(null);
    expect(finalToken).not.toBeNull();
    expect(server.rateLimited).toBe(0);
    expect(server.mints).toHaveLength(1);
  });
});
