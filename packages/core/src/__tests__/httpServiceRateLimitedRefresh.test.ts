/**
 * The post-429 refresh cooldown.
 *
 * `POST /session/device/token` is budgeted at 30 mints/minute
 * (`packages/api/src/routes/sessionDevice.ts`). Once the access token is
 * EXPIRED, the request-driven refresh lanes — the request-time preflight in
 * `getAuthHeader` and the 401 retry — reattempt on
 * `EXPIRED_TOKEN_REFRESH_COOLDOWN_MS`, i.e. one mint per second, 60/min. That
 * is correct against an unreachable server (recover the instant it returns) and
 * exactly wrong against a rationing one: the retries spend the very budget they
 * are waiting on, so the limiter stays tripped for as long as the app keeps
 * issuing requests and the session can never heal itself.
 *
 * These tests pin the discrimination: a 429 lengthens the NEXT cooldown to the
 * limiter's own window, every other failure keeps the token-state cooldowns, and
 * a success clears it.
 *
 * `Date.now` is stubbed rather than using fake timers: the cooldown is a pure
 * comparison against a stored epoch, so moving the clock is the whole
 * experiment, and real microtasks keep the refresh promises resolving normally.
 */
import { HttpService } from '../HttpService';

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

/** The server's mint budget window — the interval the fix must wait out. */
const LIMITER_WINDOW_MS = 60_000;

/** Comfortably past the expired-token cooldown (1s) but inside the 429 window. */
const BETWEEN_COOLDOWNS_MS = 30_000;

describe('HttpService — refresh cooldown after a rate-limited mint', () => {
  let clock = 1_700_000_000_000;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A client whose CURRENT access token is already past `exp`. */
  function expiredTokenClient(): HttpService {
    const http = new HttpService({ baseURL: 'https://api.oxy.so', enableRetry: false });
    http.setTokens(createJwt({ userId: 'u', exp: Math.floor(clock / 1000) - 60 }));
    return http;
  }

  it('retries an expired token ~1s after an ORDINARY failure (the unreachable-server lane is untouched)', async () => {
    const http = expiredTokenClient();
    const handler = jest.fn(async () => null);
    http.setAuthRefreshHandler(handler);

    expect(await http.refreshAccessToken('preflight')).toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);

    clock += 1_001;
    expect(await http.refreshAccessToken('preflight')).toBeNull();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('suppresses the retry for the limiter window after a 429, instead of hammering once a second', async () => {
    const http = expiredTokenClient();
    const handler = jest.fn(async () => {
      // What `refreshDeviceSecretArm` does when the mint answers 429.
      http.noteRefreshRateLimited();
      return null;
    });
    http.setAuthRefreshHandler(handler);

    expect(await http.refreshAccessToken('preflight')).toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);

    // Past the expired-token cooldown. Without the 429 discrimination this is
    // where the client resumes one mint per second and holds the limiter down.
    clock += BETWEEN_COOLDOWNS_MS;
    expect(await http.refreshAccessToken('preflight')).toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);

    // Once the limiter's window has drained, exactly one probe goes out.
    clock += LIMITER_WINDOW_MS;
    expect(await http.refreshAccessToken('preflight')).toBeNull();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('holds a rate-limited client under the mint budget while requests keep arriving', async () => {
    const http = expiredTokenClient();
    const handler = jest.fn(async () => {
      http.noteRefreshRateLimited();
      return null;
    });
    http.setAuthRefreshHandler(handler);

    // One simulated minute of a busy app: a request every 250ms, each one
    // driving the preflight/401 refresh lane.
    for (let elapsed = 0; elapsed < 60_000; elapsed += 250) {
      await http.refreshAccessToken('preflight');
      clock += 250;
    }

    // The server's budget is 30/min. The unfixed client issues 60.
    expect(handler.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('clears the lengthened cooldown once a refresh succeeds', async () => {
    const http = expiredTokenClient();
    const fresh = createJwt({ userId: 'u', exp: Math.floor(clock / 1000) + 900 });
    const handler = jest
      .fn<Promise<string | null>, []>()
      .mockImplementationOnce(async () => {
        http.noteRefreshRateLimited();
        return null;
      })
      .mockImplementationOnce(async () => fresh)
      // A later ordinary failure must be back on the short cooldown, proving the
      // 429 state did not become sticky.
      .mockImplementation(async () => null);
    http.setAuthRefreshHandler(handler);

    await http.refreshAccessToken('preflight');
    clock += LIMITER_WINDOW_MS + 1;
    expect(await http.refreshAccessToken('preflight')).toBe(fresh);

    // The planted token is fresh, so this is the still-valid (15s) cooldown.
    clock += 16_000;
    await http.refreshAccessToken('preflight');
    expect(handler).toHaveBeenCalledTimes(3);

    clock += 16_000;
    await http.refreshAccessToken('preflight');
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it('returns to the short cooldown when a later failure is NOT a 429', async () => {
    const http = expiredTokenClient();
    const handler = jest
      .fn<Promise<string | null>, []>()
      .mockImplementationOnce(async () => {
        http.noteRefreshRateLimited();
        return null;
      })
      // The limiter window passed and the endpoint is merely erroring now.
      .mockImplementation(async () => null);
    http.setAuthRefreshHandler(handler);

    await http.refreshAccessToken('preflight');
    clock += LIMITER_WINDOW_MS + 1;
    await http.refreshAccessToken('preflight');
    expect(handler).toHaveBeenCalledTimes(2);

    clock += 1_001;
    await http.refreshAccessToken('preflight');
    expect(handler).toHaveBeenCalledTimes(3);
  });
});
