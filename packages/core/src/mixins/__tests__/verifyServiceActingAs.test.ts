/**
 * `verifyServiceActingAs` — the SDK half of the delegation check.
 *
 * `serviceAuth.test.ts` covers what the MIDDLEWARE does with this method's
 * answer, and it does so by stubbing the method out. So nothing there exercises
 * the method itself: how it authenticates, what it sends, and what it does when
 * the answer is no or never arrives. That is this file.
 *
 * The property under test throughout is fail-closed. `null` is the only value
 * this method may return when it is not certain, because the middleware turns
 * `null` into a 403 and anything else into an attached `req.userId`.
 */

import { OxyServices } from '../../OxyServices';
import type { RequestOptions } from '../../types';

const APP = 'delegating-app';
const USER = 'subject-user';

interface CapturedCall {
  method: string;
  url: string;
  data: unknown;
  options: RequestOptions | undefined;
}

/**
 * Stub `makeRequest` and record what it was handed.
 *
 * Deliberately not a network mock: the assertion that matters is the exact
 * request the SDK composes — an unauthenticated one now gets a 403 from the API
 * rather than an answer, so the Authorization header is part of the contract and
 * not an implementation detail.
 */
function captureRequests(oxy: OxyServices, result: unknown) {
  const calls: CapturedCall[] = [];
  jest
    .spyOn(oxy, 'makeRequest')
    .mockImplementation(async (method, url, data, options) => {
      calls.push({ method, url, data, options });
      if (result instanceof Error) throw result;
      return result as never;
    });
  return calls;
}

describe('verifyServiceActingAs', () => {
  let oxy: OxyServices;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    jest.spyOn(oxy, 'getServiceToken').mockResolvedValue('verifier-service-token');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("authenticates with the VERIFIER's own service token", async () => {
    const calls = captureRequests(oxy, { authorized: true, scopes: ['podcasts:write'] });

    await oxy.verifyServiceActingAs(APP, USER);

    expect(calls).toHaveLength(1);
    expect(calls[0].options?.headers).toEqual({
      Authorization: 'Bearer verifier-service-token',
    });
  });

  it('sends the pair as query params, with retries off and a bounded timeout', async () => {
    // This runs inside request-handling middleware. A retry loop here multiplies
    // the latency of every delegated request by the number of attempts, and a
    // cached GET would serve a revoked grant.
    const calls = captureRequests(oxy, { authorized: true, scopes: [] });

    await oxy.verifyServiceActingAs(APP, USER);

    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('/internal/service-acting-as/verify');
    expect(calls[0].data).toEqual({ appId: APP, userId: USER });
    expect(calls[0].options).toMatchObject({ cache: false, retry: false, timeout: 5000 });
  });

  it('returns the grant when the API authorizes, carrying the scopes through', async () => {
    captureRequests(oxy, { authorized: true, scopes: ['acting-as:offline', 'podcasts:write'] });

    const grant = await oxy.verifyServiceActingAs(APP, USER);

    expect(grant).toEqual({
      authorized: true,
      scopes: ['acting-as:offline', 'podcasts:write'],
    });
  });

  it('returns null when the API answers authorized:false', async () => {
    captureRequests(oxy, { authorized: false, scopes: [] });

    await expect(oxy.verifyServiceActingAs(APP, USER)).resolves.toBeNull();
  });

  it('returns null when the API answers with scopes but NO authorized flag', async () => {
    // A truthy `scopes` array must never stand in for authorization: a caller
    // reading the array and skipping the boolean is the mistake, and the SDK
    // refuses to produce a value that would reward it.
    captureRequests(oxy, { scopes: ['podcasts:write'] });

    await expect(oxy.verifyServiceActingAs(APP, USER)).resolves.toBeNull();
  });

  it('returns null when the endpoint is UNREACHABLE — there is no fail-open path', async () => {
    captureRequests(oxy, new Error('ECONNREFUSED'));

    await expect(oxy.verifyServiceActingAs(APP, USER)).resolves.toBeNull();
  });

  it('returns null, and never calls the endpoint, when the verifier has no service credentials', async () => {
    // A host that cannot prove who it is has no business being told which users
    // delegated to which applications. `getServiceToken()` throws, and that is
    // the whole outcome.
    jest
      .spyOn(oxy, 'getServiceToken')
      .mockRejectedValue(new Error('Service credentials not provided.'));
    const calls = captureRequests(oxy, { authorized: true, scopes: ['podcasts:write'] });

    await expect(oxy.verifyServiceActingAs(APP, USER)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  describe('caching', () => {
    it('serves a positive grant from cache rather than re-asking', async () => {
      const calls = captureRequests(oxy, { authorized: true, scopes: ['podcasts:write'] });

      await oxy.verifyServiceActingAs(APP, USER);
      await oxy.verifyServiceActingAs(APP, USER);

      expect(calls).toHaveLength(1);
    });

    it('caches a REFUSAL too, so a misconfigured caller cannot hammer the endpoint', async () => {
      const calls = captureRequests(oxy, { authorized: false, scopes: [] });

      await expect(oxy.verifyServiceActingAs(APP, USER)).resolves.toBeNull();
      await expect(oxy.verifyServiceActingAs(APP, USER)).resolves.toBeNull();

      expect(calls).toHaveLength(1);
    });

    it('keys the cache on BOTH app and user — one grant never answers for another', async () => {
      // The cache key is the whole security boundary of this method. Keyed on
      // the user alone, one application's grant would authorize every other
      // application for that user; keyed on the app alone, one user's grant
      // would authorize acting as everybody.
      const calls = captureRequests(oxy, { authorized: true, scopes: ['podcasts:write'] });

      await oxy.verifyServiceActingAs(APP, USER);
      await oxy.verifyServiceActingAs('other-app', USER);
      await oxy.verifyServiceActingAs(APP, 'other-user');

      expect(calls).toHaveLength(3);
      expect(calls.map((c) => c.data)).toEqual([
        { appId: APP, userId: USER },
        { appId: 'other-app', userId: USER },
        { appId: APP, userId: 'other-user' },
      ]);
    });
  });
});
