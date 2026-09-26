import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';
import { OxyServices } from '../../OxyServices';
import { createOxyAuthMiddleware } from '../../server/auth';
import {
  createSigningKey,
  mockJwksFetch,
  type ServiceTokenSigningKey,
} from '../../__tests__/fixtures/serviceTokens';

const b64url = (value: string | Uint8Array): string => Buffer.from(value).toString('base64url');

function token(
  privateKey: KeyObject,
  keyId: string,
  claims: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = { alg: 'EdDSA', typ: 'JWT', kid: keyId };
  const payload = {
    type: 'service',
    appId: 'app-exact',
    appName: 'Homiio',
    credentialId: 'credential-exact',
    ownerAccountId: 'account-exact',
    environment: 'production',
    scopes: ['inference:invoke'],
    iss: 'oxy-auth',
    aud: 'oxy-api',
    iat: now,
    exp: now + 3_600,
    ...claims,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(signBytes(null, Buffer.from(signingInput), privateKey))}`;
}

function responseHarness() {
  const response = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return response;
}

async function authenticate(oxy: OxyServices, bearer: string) {
  const request = {
    method: 'POST',
    path: '/v1/chat/completions',
    query: {},
    headers: { authorization: `Bearer ${bearer}` },
  };
  const response = responseHarness();
  const next = jest.fn();
  await oxy.auth()(request as never, response as never, next as never);
  return { request, response, next };
}

async function authenticateThroughExpress(oxy: OxyServices, bearer: string, delegatedUserId: string) {
  const request = {
    method: 'POST',
    path: '/v1/chat/completions',
    query: {},
    headers: {
      authorization: `Bearer ${bearer}`,
      'x-oxy-user-id': delegatedUserId,
    },
  };
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const response = responseHarness();
  const originalJson = response.json.bind(response);
  response.json = (body: unknown) => {
    const result = originalJson(body);
    settle();
    return result;
  };
  const next = jest.fn(() => settle());
  createOxyAuthMiddleware(oxy)(request as never, response as never, next as never);
  await settled;
  return { request, response, next };
}

describe('Ed25519 Oxy service-token verification through JWKS', () => {
  const primary = generateKeyPairSync('ed25519');
  const secondary = generateKeyPairSync('ed25519');
  const primaryJwk = {
    ...primary.publicKey.export({ format: 'jwk' }),
    use: 'sig',
    alg: 'EdDSA',
    kid: 'service-2026-09-a',
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts a real service token without any shared signing secret', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ keys: [primaryJwk] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.test' });
    const result = await authenticate(oxy, token(primary.privateKey, primaryJwk.kid));

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.oxy.test/.well-known/jwks.json',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
    expect(result.next).toHaveBeenCalledTimes(1);
    expect(result.request).toMatchObject({
      serviceApp: {
        appId: 'app-exact',
        credentialId: 'credential-exact',
        ownerAccountId: 'account-exact',
        scopes: ['inference:invoke'],
      },
    });
  });

  it('admits a real delegated service token through createOxyAuthMiddleware', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ keys: [primaryJwk] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.test' });
    jest.spyOn(oxy, 'verifyServiceActingAs').mockResolvedValue({
      authorized: true,
      scopes: ['inference:invoke'],
    });

    const result = await authenticateThroughExpress(
      oxy,
      token(primary.privateKey, primaryJwk.kid),
      'user-exact',
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.next).toHaveBeenCalledTimes(1);
    expect(result.request).toMatchObject({
      userId: 'user-exact',
      serviceActingAs: { userId: 'user-exact', scopes: ['inference:invoke'] },
      serviceApp: { appId: 'app-exact', scopes: ['inference:invoke'] },
    });
  });

  it.each([' user-exact', 'user-exact '])(
    'rejects delegated user id whitespace byte-for-byte: %j',
    async (delegatedUserId) => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
        JSON.stringify({ keys: [primaryJwk] }),
        { status: 200 },
      ));
      const oxy = new OxyServices({ baseURL: 'https://api.oxy.test' });
      const verifyGrant = jest.spyOn(oxy, 'verifyServiceActingAs');
      const result = await authenticateThroughExpress(
        oxy,
        token(primary.privateKey, primaryJwk.kid),
        delegatedUserId,
      );

      expect(result.next).not.toHaveBeenCalled();
      expect(result.response.statusCode).toBe(401);
      expect(verifyGrant).not.toHaveBeenCalled();
    },
  );

  it('caches a key set and rate-limits unknown-kid refresh attempts', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ keys: [primaryJwk] }),
      { status: 200 },
    ));
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.test' });
    expect((await authenticate(oxy, token(primary.privateKey, primaryJwk.kid))).next).toHaveBeenCalled();
    const unknown = token(secondary.privateKey, 'unknown-key');
    expect((await authenticate(oxy, unknown)).response.statusCode).toBe(401);
    expect((await authenticate(oxy, unknown)).response.statusCode).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['wrong issuer', { iss: 'attacker' }],
    ['wrong audience', { aud: 'other-api' }],
    ['expired', { exp: 1 }],
    ['future nbf', { nbf: Math.floor(Date.now() / 1_000) + 600 }],
    ['malformed scopes', { scopes: ['inference:invoke', ' inference:invoke'] }],
    ['missing app name', { appName: undefined }],
    ['application id leading whitespace', { appId: ' app-exact' }],
    ['application id trailing whitespace', { appId: 'app-exact ' }],
    ['credential id leading whitespace', { credentialId: ' credential-exact' }],
    ['credential id trailing whitespace', { credentialId: 'credential-exact ' }],
    ['owner id leading whitespace', { ownerAccountId: ' account-exact' }],
    ['owner id trailing whitespace', { ownerAccountId: 'account-exact ' }],
  ])('fails closed on %s', async (_label, claims) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ keys: [primaryJwk] }),
      { status: 200 },
    ));
    const result = await authenticate(
      new OxyServices({ baseURL: 'https://api.oxy.test' }),
      token(primary.privateKey, primaryJwk.kid, claims),
    );
    expect(result.next).not.toHaveBeenCalled();
    expect(result.response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Key lifecycle (ADR 0012, #877): current key, rotation grace, unknown kid,
// JWKS outages and malformed key sets. `Date.now` is advanced by hand to step
// past the one-per-minute unknown-kid refresh limit and the five-minute cache.
// ---------------------------------------------------------------------------

describe('service-token key lifecycle against the published JWKS', () => {
  const KEY_A = createSigningKey('service-2026-09-a');
  const KEY_B = createSigningKey('service-2026-10-b');
  const KEY_C = createSigningKey('service-never-published');
  const UNKNOWN_KID_REFRESH_MS = 60 * 1000;
  const JWKS_CACHE_MS = 5 * 60 * 1000;

  let published: () => ServiceTokenSigningKey[] | { status: number; body?: string };
  let jwksFetch: jest.SpyInstance;
  let clock: number;
  let oxy: OxyServices;

  const advance = (ms: number) => {
    clock += ms;
  };
  const accepted = async (bearer: string) => (await authenticate(oxy, bearer)).next.mock.calls.length === 1;

  beforeEach(() => {
    const start = Date.now();
    clock = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => start + clock);
    published = () => [KEY_A];
    jwksFetch = mockJwksFetch(() => published());
    oxy = new OxyServices({ baseURL: 'https://api.oxy.test' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('verifies a token from the current key, fetching the key set once', async () => {
    expect(await accepted(token(KEY_A.privateKey, KEY_A.kid))).toBe(true);
    expect(await accepted(token(KEY_A.privateKey, KEY_A.kid))).toBe(true);
    expect(jwksFetch).toHaveBeenCalledTimes(1);
  });

  it('verifies a token from the rotation-grace key (second key in the JWKS)', async () => {
    published = () => [KEY_B, KEY_A];
    expect(await accepted(token(KEY_A.privateKey, KEY_A.kid))).toBe(true);
    expect(await accepted(token(KEY_B.privateKey, KEY_B.kid))).toBe(true);
    expect(jwksFetch).toHaveBeenCalledTimes(1);
  });

  it('an unknown kid triggers exactly one refresh, then the new key is accepted', async () => {
    expect(await accepted(token(KEY_A.privateKey, KEY_A.kid))).toBe(true);
    published = () => [KEY_B, KEY_A];
    advance(UNKNOWN_KID_REFRESH_MS);

    expect(await accepted(token(KEY_B.privateKey, KEY_B.kid))).toBe(true);
    expect(jwksFetch).toHaveBeenCalledTimes(2);
    // Now cached: no further fetch for the same kid.
    expect(await accepted(token(KEY_B.privateKey, KEY_B.kid))).toBe(true);
    expect(jwksFetch).toHaveBeenCalledTimes(2);
  });

  it('an unknown kid still unknown after the refresh is refused, and does not refetch at once', async () => {
    expect(await accepted(token(KEY_A.privateKey, KEY_A.kid))).toBe(true);
    advance(UNKNOWN_KID_REFRESH_MS);

    const unknown = await authenticate(oxy, token(KEY_C.privateKey, KEY_C.kid));
    expect(unknown.next).not.toHaveBeenCalled();
    expect(unknown.response.statusCode).toBe(401);
    expect(unknown.response.body).toMatchObject({ code: 'INVALID_SERVICE_TOKEN' });
    expect(jwksFetch).toHaveBeenCalledTimes(2);

    expect(await accepted(token(KEY_C.privateKey, KEY_C.kid))).toBe(false);
    expect(jwksFetch).toHaveBeenCalledTimes(2);
  });

  it('a token claiming a published kid but signed by another key is refused', async () => {
    const forged = await authenticate(oxy, token(KEY_C.privateKey, KEY_A.kid));
    expect(forged.next).not.toHaveBeenCalled();
    expect(forged.response.statusCode).toBe(401);
  });

  it.each([
    ['wrong environment', { environment: 'staging-typo' }],
    ['missing environment', { environment: undefined }],
    ['expired', { exp: Math.floor(Date.now() / 1_000) - 1 }],
    ['wrong issuer', { iss: 'oxy-auth-fork' }],
    ['wrong audience', { aud: 'kaana-api' }],
  ])('refuses a correctly signed token with the %s', async (_label, claims) => {
    const result = await authenticate(oxy, token(KEY_A.privateKey, KEY_A.kid, claims));
    expect(result.next).not.toHaveBeenCalled();
    expect(result.response.statusCode).toBe(401);
    expect(result.request).not.toHaveProperty('serviceApp');
  });

  it('never treats a correctly signed non-service type as a service principal', async () => {
    const result = await authenticate(oxy, token(KEY_A.privateKey, KEY_A.kid, { type: 'access' }));
    expect(result.next).not.toHaveBeenCalled();
    expect(result.response.statusCode).toBe(401);
    expect(result.request).not.toHaveProperty('serviceApp');
    // It took the user-token lane, which never consults the JWKS.
    expect(jwksFetch).not.toHaveBeenCalled();
  });

  it('keeps verifying a cached key while the JWKS is temporarily unavailable', async () => {
    expect(await accepted(token(KEY_A.privateKey, KEY_A.kid))).toBe(true);
    published = () => ({ status: 503 });
    advance(UNKNOWN_KID_REFRESH_MS);

    // An unknown kid forces a refresh into the outage; it is refused...
    expect(await accepted(token(KEY_B.privateKey, KEY_B.kid))).toBe(false);
    expect(jwksFetch).toHaveBeenCalledTimes(2);
    // ...but the failed refresh does not evict the key already held.
    expect(await accepted(token(KEY_A.privateKey, KEY_A.kid))).toBe(true);
    expect(jwksFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps verifying a cached key when the JWKS fetch itself throws', async () => {
    expect(await accepted(token(KEY_A.privateKey, KEY_A.kid))).toBe(true);
    jwksFetch.mockRejectedValue(new TypeError('fetch failed'));
    advance(UNKNOWN_KID_REFRESH_MS);

    expect(await accepted(token(KEY_B.privateKey, KEY_B.kid))).toBe(false);
    expect(await accepted(token(KEY_A.privateKey, KEY_A.kid))).toBe(true);
  });

  it('refuses once the cache has expired and the JWKS is still unavailable', async () => {
    expect(await accepted(token(KEY_A.privateKey, KEY_A.kid))).toBe(true);
    published = () => ({ status: 503 });
    advance(JWKS_CACHE_MS);

    expect(await accepted(token(KEY_A.privateKey, KEY_A.kid))).toBe(false);
  });

  it.each([
    ['an empty key set', { status: 200, body: JSON.stringify({ keys: [] }) }],
    ['no keys member', { status: 200, body: JSON.stringify({}) }],
    ['a body that is not JSON', { status: 200, body: '<html>maintenance</html>' }],
    ['an HTTP error', { status: 500, body: '' }],
    ['a private key member', { status: 200, body: JSON.stringify({ keys: [{ ...KEY_A.jwk, d: 'AAAA' }] }) }],
    ['a non-Ed25519 key', { status: 200, body: JSON.stringify({ keys: [{ ...KEY_A.jwk, crv: 'X25519' }] }) }],
    ['a key without alg EdDSA', { status: 200, body: JSON.stringify({ keys: [{ ...KEY_A.jwk, alg: 'HS256' }] }) }],
    ['a duplicate kid', { status: 200, body: JSON.stringify({ keys: [KEY_A.jwk, KEY_A.jwk] }) }],
    ['a truncated public key', { status: 200, body: JSON.stringify({ keys: [{ ...KEY_A.jwk, x: 'AAAA' }] }) }],
  ])('refuses every token when the JWKS is %s', async (_label, answer) => {
    published = () => answer;
    const result = await authenticate(oxy, token(KEY_A.privateKey, KEY_A.kid));
    expect(result.next).not.toHaveBeenCalled();
    expect(result.response.statusCode).toBe(401);
    expect(result.response.body).toMatchObject({ code: 'INVALID_SERVICE_TOKEN' });
  });

  it('survives a key rotation during active traffic', async () => {
    // Before rotation: key A signs everything.
    expect(await accepted(token(KEY_A.privateKey, KEY_A.kid))).toBe(true);

    // The issuer publishes B next to A and starts signing with B. Tokens from
    // A are still in flight.
    published = () => [KEY_B, KEY_A];
    advance(UNKNOWN_KID_REFRESH_MS);
    const inFlightA = token(KEY_A.privateKey, KEY_A.kid);
    expect(await accepted(token(KEY_B.privateKey, KEY_B.kid))).toBe(true);
    expect(await accepted(inFlightA)).toBe(true);
    expect(await accepted(token(KEY_B.privateKey, KEY_B.kid))).toBe(true);
    expect(jwksFetch).toHaveBeenCalledTimes(2);

    // Grace over: A is withdrawn. After the cache expires, A is refused and B
    // carries on.
    published = () => [KEY_B];
    advance(JWKS_CACHE_MS);
    expect(await accepted(token(KEY_B.privateKey, KEY_B.kid))).toBe(true);
    expect(await accepted(token(KEY_A.privateKey, KEY_A.kid))).toBe(false);
  });
});
