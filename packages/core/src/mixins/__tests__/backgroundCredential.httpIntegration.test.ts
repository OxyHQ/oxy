import type { DeviceBackgroundCredentialResponse } from '@oxyhq/contracts';
import { OxyServices } from '../../OxyServices';

/**
 * Real-stack integration test for `provisionBackgroundCredential`: a genuine
 * `HttpService` (via `OxyServices`) with `global.fetch` stubbed to return the
 * EXACT wire bodies oxy-api sends, rather than a `makeRequest` spy.
 *
 * The unit suite (`OxyServices.deviceBoot.test.ts`) stubs `makeRequest`, so by
 * construction it cannot see either of the two things this file pins:
 *
 *  1. **The `{ data }` envelope.** The route answers
 *     `{ data: { deviceId, secret, accountId, expiresAt } }`, and
 *     `HttpService.unwrapResponse` strips that outer envelope — so the mixin
 *     must validate the FLAT credential and must not read `.data` a second
 *     time. A spy returning the flat shape asserts that assumption instead of
 *     testing it; the same blind spot produced a P0 in `SessionClient` (see
 *     `SessionClient.httpIntegration.test.ts`).
 *  2. **The 404 degrade against the REAL error object.** The `404 → null` path
 *     is what keeps a client on a newer SDK than the server from breaking, and
 *     it keys on the status surviving whatever `HttpService` throws. A
 *     hand-built `Object.assign(new Error(), { status: 404 })` proves only that
 *     the branch reads the shape the test itself invented.
 *
 * The stub is URL-aware because a state-changing request through the real stack
 * fetches `GET /csrf-token` FIRST. A blanket stub answers that call too, which
 * both shifts the request under test out of `calls[0]` and (on a non-200 stub)
 * makes the CSRF fetch burn its own retries — so a naive call-count assertion
 * measures CSRF attempts rather than the route.
 */
const ROUTE = '/session/device/background-credential';

const CREDENTIAL: DeviceBackgroundCredentialResponse = {
  deviceId: 'device-real',
  secret: 'bg-secret-from-the-wire',
  accountId: 'acct-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
};

/** The route's success body: the credential under this API's `data` envelope. */
const ROUTE_BODY = { data: CREDENTIAL };

/** oxy-api's 404 body for an unmatched path (server.ts's terminal handler). */
const NOT_FOUND_BODY = { error: 'NOT_FOUND', message: 'Resource not found' };

const jsonResponse = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * A syntactically real, far-future access token. It must be a decodable JWT:
 * `HttpService.getAuthHeader` runs `jwtDecode` and sends NO bearer at all when
 * that throws, so an opaque placeholder would silently turn this into an
 * anonymous request and make the bearer assertion below untestable.
 */
const ACCESS_TOKEN = (() => {
  const segment = (payload: object) => Buffer.from(JSON.stringify(payload)).toString('base64url');
  return [
    segment({ alg: 'none', typ: 'JWT' }),
    segment({ sub: 'acct-1', exp: 4_102_444_800 }), // 2100-01-01
    'signature-not-verified-client-side',
  ].join('.');
})();

describe('provisionBackgroundCredential over a real HttpService', () => {
  const originalFetch = global.fetch;

  /** Answers the CSRF preflight properly; answers the route under test with `body`/`status`. */
  const stubFetch = (body: unknown, status: number) => {
    const fetchMock = jest.fn(async (input: unknown) => {
      if (String(input).includes('/csrf-token')) {
        return jsonResponse({ csrfToken: 'csrf-test-token' }, 200);
      }
      return jsonResponse(body, status);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  };

  /** Every stubbed call whose URL is the route under test (i.e. not the CSRF preflight). */
  const routeCalls = (fetchMock: jest.Mock) =>
    fetchMock.mock.calls.filter(([input]) => String(input).includes(ROUTE));

  const client = () => {
    const oxy = new OxyServices({ baseURL: 'http://api.test.invalid' });
    // Bearer required: the server derives both the deviceId and the account
    // from it, and this call (unlike the device-secret mint) does not skipAuth.
    oxy.setTokens(ACCESS_TOKEN);
    return oxy;
  };

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('unwraps the { data } envelope and returns the flat credential', async () => {
    stubFetch(ROUTE_BODY, 200);

    const result = await client().provisionBackgroundCredential();

    // Would be `{ data: {...} }` if the envelope were not unwrapped, and would
    // throw (contract validation failure) if `.data` were read twice.
    expect(result).toEqual(CREDENTIAL);
    expect(result?.secret).toBe('bg-secret-from-the-wire');
  });

  it('sends a POST to the route with NO body and a bearer', async () => {
    const fetchMock = stubFetch(ROUTE_BODY, 200);

    await client().provisionBackgroundCredential();

    const calls = routeCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const [, init] = calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    // No body at all — not `'undefined'`, not `'{}'`. The server derives the
    // deviceId and the account from the bearer; anything sent here would be
    // ignored at best and mass-assignment surface at worst.
    expect(init.body ?? null).toBeNull();
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('returns null on the real 404 response, without retrying the route', async () => {
    const fetchMock = stubFetch(NOT_FOUND_BODY, 404);

    await expect(client().provisionBackgroundCredential()).resolves.toBeNull();

    // 4xx is not retried (`retryAsync`'s default shouldRetry), so an absent
    // endpoint costs exactly one request to the route — the degrade must not
    // burn a backoff loop on every provision attempt.
    expect(routeCalls(fetchMock)).toHaveLength(1);
  });
});
