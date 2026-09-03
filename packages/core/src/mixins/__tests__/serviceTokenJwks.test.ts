import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';
import { OxyServices } from '../../OxyServices';
import { createOxyAuthMiddleware } from '../../server/auth';

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
