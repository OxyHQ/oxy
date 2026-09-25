/**
 * Discovery error-handling tests (C3).
 *
 * `resolveProfile` and `getProfileRecommendations` are best-effort discovery
 * reads. Previously they swallowed every failure identically (`catch { return
 * null }`), making a 404 "handle not found" indistinguishable from a 5xx /
 * network failure in the field. These tests pin down the hardened behavior:
 *
 *  - `resolveProfile` STILL returns `null` on any failure (contract unchanged),
 *    but emits a `debug` log that flags whether it was a not-found vs a failure.
 *  - `getProfileRecommendations` STILL rethrows (contract unchanged), but emits
 *    a `debug` log first for observability.
 */

import { OxyServices } from '../../OxyServices';
import { logger } from '../../logger';

/** A JSON success `Response` mimicking the API's `{ data: ... }` envelope. */
function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Build a non-verified JWT whose payload decodes to the given claims.
 * `jwtDecode` only base64url-decodes the middle segment (no signature check).
 * Used to put the SDK in an authenticated state so a state-changing POST
 * carries a bearer header.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const fullPayload = { exp: Math.floor(Date.now() / 1000) + 3600, ...payload };
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(fullPayload)}.sig`;
}

/** A JSON error `Response` with the given HTTP status. */
function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('discovery error handling', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  let debugSpy: jest.SpyInstance;
  let oxy: OxyServices;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => {});
    // Disable retry so a single error response surfaces immediately.
    oxy = new OxyServices({ baseURL: 'http://test.invalid', enableRetry: false });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    debugSpy.mockRestore();
    jest.clearAllMocks();
  });

  describe('resolveProfile', () => {
    it('returns the normalized user when discovery succeeds', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'u1', username: 'remote' }));
      const result = await oxy.resolveProfile('remote@mastodon.social');
      expect(result?.id).toBe('u1');
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it('returns null AND logs a not-found debug entry on 404', async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(404, 'not found'));
      const result = await oxy.resolveProfile('ghost@nowhere.example');
      expect(result).toBeNull();
      expect(debugSpy).toHaveBeenCalledTimes(1);
      const [message, context] = debugSpy.mock.calls[0];
      expect(message).toContain('not found');
      expect(context).toMatchObject({
        method: 'resolveProfile',
        handle: 'ghost@nowhere.example',
        status: 404,
        notFound: true,
      });
    });

    it('returns null AND logs a failure (not not-found) debug entry on 5xx', async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(503, 'upstream down'));
      const result = await oxy.resolveProfile('remote@down.example');
      expect(result).toBeNull();
      expect(debugSpy).toHaveBeenCalledTimes(1);
      const [message, context] = debugSpy.mock.calls[0];
      expect(message).toContain('discovery failed');
      expect(context).toMatchObject({
        method: 'resolveProfile',
        status: 503,
        notFound: false,
      });
    });

    it('returns null on a network failure (no status)', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const result = await oxy.resolveProfile('remote@offline.example');
      expect(result).toBeNull();
      expect(debugSpy).toHaveBeenCalledTimes(1);
      const [, context] = debugSpy.mock.calls[0];
      expect(context).toMatchObject({ notFound: false });
    });
  });

  describe('getProfileRecommendations', () => {
    it('returns the list on success without logging', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'r1', username: 'rec' }]));
      const result = await oxy.getProfileRecommendations();
      expect(result).toHaveLength(1);
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it('rethrows on failure AND logs a debug entry first (contract unchanged)', async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(500, 'boom'));
      await expect(oxy.getProfileRecommendations()).rejects.toThrow();
      expect(debugSpy).toHaveBeenCalledTimes(1);
      const [message, context] = debugSpy.mock.calls[0];
      expect(message).toContain('discovery read failed');
      expect(context).toMatchObject({
        method: 'getProfileRecommendations',
        status: 500,
      });
    });
  });

  /**
   * GET-vs-POST routing for the recommendation contract (Wave 2).
   *
   * The simple/back-compat case (no options, or only `excludeTypes`/`limit`)
   * keeps using the cached `GET /profiles/recommendations`. The scored (v2)
   * fields (`clientId`/`offset`/`excludeIds`/`boosts`/`signalWeights`) switch to
   * `POST /profiles/recommendations` with the validated request body.
   */
  describe('getProfileRecommendations routing (GET vs POST)', () => {
    // Authenticate so the state-changing POST carries a bearer header. A bearer
    // token does not affect GET routing or the request body, so the
    // GET-path assertions below are unaffected.
    beforeEach(() => {
      oxy.httpService.setTokens(makeJwt({ userId: 'me' }));
    });

    /** The `(url, init)` pair of the single recorded fetch call. */
    function lastCall(): { url: string; init: RequestInit | undefined } {
      const [input, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
      return { url: String(input), init };
    }

    it('uses GET (no body) when called with no options', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'r1' }]));
      await oxy.getProfileRecommendations();
      const { url, init } = lastCall();
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(url).toContain('/profiles/recommendations');
      expect(url).not.toContain('excludeTypes');
    });

    it('uses GET with excludeTypes as a comma-joined query param (legacy shape)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'r1' }]));
      await oxy.getProfileRecommendations({ excludeTypes: ['federated', 'agent'] });
      const { url, init } = lastCall();
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      // Comma is URL-encoded as %2C in the query string.
      expect(decodeURIComponent(url)).toContain('excludeTypes=federated,agent');
    });

    it('uses GET with limit as a query param', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'r1' }]));
      await oxy.getProfileRecommendations({ limit: 5 });
      const { url, init } = lastCall();
      expect(init?.method).toBe('GET');
      expect(url).toContain('limit=5');
    });

    it('uses POST with the validated body when clientId is present', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'r1' }]));
      await oxy.getProfileRecommendations({ clientId: 'app-123', limit: 10 });
      const { url, init } = lastCall();
      expect(init?.method).toBe('POST');
      expect(url).toContain('/profiles/recommendations');
      expect(url).not.toContain('?');
      expect(JSON.parse(String(init?.body))).toMatchObject({ clientId: 'app-123', limit: 10 });
    });

    it('uses POST when boosts are present', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'r1' }]));
      await oxy.getProfileRecommendations({
        boosts: [{ userIds: ['u1', 'u2'], weight: 2, reason: 'editorial' }],
      });
      const { init } = lastCall();
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body)).boosts[0]).toMatchObject({
        userIds: ['u1', 'u2'],
        weight: 2,
      });
    });

    it('uses POST when excludeIds are present', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'r1' }]));
      await oxy.getProfileRecommendations({ excludeIds: ['x1', 'x2'] });
      const { init } = lastCall();
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body)).excludeIds).toEqual(['x1', 'x2']);
    });

    it('uses POST when signalWeights are present', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'r1' }]));
      await oxy.getProfileRecommendations({ signalWeights: { graph: 3 } });
      const { init } = lastCall();
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body)).signalWeights).toEqual({ graph: 3 });
    });

    it('uses POST when offset is present', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'r1' }]));
      await oxy.getProfileRecommendations({ offset: 20, limit: 10 });
      const { init } = lastCall();
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({ offset: 20, limit: 10 });
    });

    it('validates the POST body against the contract and rejects bad input', async () => {
      // weight is clamped to [-5, 5] by the schema; 99 must be rejected
      // client-side BEFORE any network call.
      await expect(
        oxy.getProfileRecommendations({ boosts: [{ userIds: ['u1'], weight: 99 }] }),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns the scored items (score/matchedSignals) from the POST path', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'r1',
            name: { displayName: 'Rec One' },
            mutualCount: 3,
            score: 0.87,
            matchedSignals: ['graph', 'verified'],
            _count: { followers: 10, following: 5 },
          },
        ]),
      );
      const result = await oxy.getProfileRecommendations({ clientId: 'app-1' });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'r1',
        score: 0.87,
        matchedSignals: ['graph', 'verified'],
        mutualCount: 3,
      });
    });
  });
});
