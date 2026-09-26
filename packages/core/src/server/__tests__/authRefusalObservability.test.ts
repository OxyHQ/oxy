/**
 * A refused credential is observable to the HOST — and to nobody else.
 *
 * The incident these lock in: Oxy served `{"keys":[]}` from
 * `/.well-known/jwks.json` with no Ed25519 signing key bound. Every service
 * token failed verification, the optional mount swallowed the failure into
 * `next()`, the host answered its own generic 401, and the one fact that named
 * the fault — an empty key set — was written down nowhere. These tests assert
 * that each refusal class now lands on `req.oxyAuthRefusal`, reaches
 * `onRefusal`, and emits exactly one `warn` carrying a stable code, while the
 * bodies the client sees stay byte-identical and optional auth still refuses to
 * 401 on its own.
 */

import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';
import { OxyServer } from '../OxyServer';
import type { OxyAuthRefusal } from '../middleware';
import { createOptionalOxyAuth, createOxyAuthMiddleware, getOxyAuthRefusal } from '../auth';
import { configureLogger, resetLoggerConfig, type LogEntry } from '../../logger';

const b64url = (value: string | Uint8Array): string => Buffer.from(value).toString('base64url');

const primary = generateKeyPairSync('ed25519');
const impostor = generateKeyPairSync('ed25519');
const primaryJwk = {
  ...primary.publicKey.export({ format: 'jwk' }),
  use: 'sig',
  alg: 'EdDSA',
  kid: 'service-2026-09-a',
};

function serviceToken(
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

/** An unsigned user token — the middleware decodes these, it never verifies them. */
function userToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = { alg: 'none', typ: 'JWT' };
  const payload = { userId: 'user-1', exp: now + 3_600, ...claims };
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.`;
}

function responseHarness() {
  return {
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
}

function requestHarness(headers: Record<string, string>) {
  return { method: 'POST', path: '/v1/chat/completions', query: {}, headers };
}

function jwksResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Drive a composed (optional-inside) middleware to completion. */
async function runMiddleware(
  middleware: (req: unknown, res: unknown, next: unknown) => unknown,
  headers: Record<string, string>,
) {
  const request = requestHarness(headers);
  const response = responseHarness();
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const originalJson = response.json.bind(response);
  response.json = (body: unknown) => {
    const result = originalJson(body);
    settle();
    return result;
  };
  const next = jest.fn(() => settle());
  await middleware(request as never, response as never, next as never);
  await settled;
  return { request, response, next };
}

let warnings: LogEntry[];

beforeEach(() => {
  warnings = [];
  configureLogger({
    level: 'warn',
    sink: (entry) => {
      if (entry.level === 'warn') warnings.push(entry);
    },
  });
});

afterEach(() => {
  resetLoggerConfig();
  jest.restoreAllMocks();
});

function refusalWarnings(): LogEntry[] {
  return warnings.filter((entry) => entry.message.startsWith('[oxy.auth] refused '));
}

describe('optional auth records why a presented credential was refused', () => {
  /**
   * Each case is a distinct production outage that answers the client the same
   * way. `reason` is what tells them apart, so each case asserts on it.
   */
  const cases: Array<{
    name: string;
    jwks: unknown | 'unreachable';
    token: string;
    expected: { code: string; stage: OxyAuthRefusal['stage']; reason: RegExp; status: number };
  }> = [
    {
      name: 'a signature that does not verify',
      jwks: { keys: [primaryJwk] },
      token: serviceToken(impostor.privateKey, primaryJwk.kid),
      expected: {
        code: 'INVALID_SERVICE_TOKEN',
        stage: 'service-token',
        reason: /signature is invalid/i,
        status: 401,
      },
    },
    {
      name: 'a kid the key set does not carry',
      jwks: { keys: [primaryJwk] },
      token: serviceToken(impostor.privateKey, 'rotated-away'),
      expected: {
        code: 'INVALID_SERVICE_TOKEN',
        stage: 'service-token',
        reason: /signing key is unknown/i,
        status: 401,
      },
    },
    {
      name: 'the empty key set Oxy actually served',
      jwks: { keys: [] },
      token: serviceToken(primary.privateKey, primaryJwk.kid),
      expected: {
        code: 'INVALID_SERVICE_TOKEN',
        stage: 'service-token',
        reason: /key set is unavailable/i,
        status: 401,
      },
    },
    {
      name: 'a JWKS endpoint that cannot be reached',
      jwks: 'unreachable',
      token: serviceToken(primary.privateKey, primaryJwk.kid),
      expected: {
        code: 'INVALID_SERVICE_TOKEN',
        stage: 'service-token',
        reason: /key set is unavailable/i,
        status: 401,
      },
    },
    {
      name: 'an expired service token',
      jwks: { keys: [primaryJwk] },
      token: serviceToken(primary.privateKey, primaryJwk.kid, { exp: 1 }),
      expected: {
        code: 'TOKEN_EXPIRED',
        stage: 'service-token',
        reason: /expired/i,
        status: 401,
      },
    },
    {
      name: 'an audience this verifier does not answer for',
      jwks: { keys: [primaryJwk] },
      token: serviceToken(primary.privateKey, primaryJwk.kid, { aud: 'someone-else' }),
      expected: {
        code: 'INVALID_SERVICE_TOKEN_CLAIMS',
        stage: 'service-token',
        reason: /audience/i,
        status: 401,
      },
    },
    {
      name: 'an issuer this verifier does not trust',
      jwks: { keys: [primaryJwk] },
      token: serviceToken(primary.privateKey, primaryJwk.kid, { iss: 'attacker' }),
      expected: {
        code: 'INVALID_SERVICE_TOKEN_CLAIMS',
        stage: 'service-token',
        reason: /issuer/i,
        status: 401,
      },
    },
    {
      name: 'a service token missing a required claim',
      jwks: { keys: [primaryJwk] },
      token: serviceToken(primary.privateKey, primaryJwk.kid, { appName: undefined }),
      expected: {
        code: 'INVALID_SERVICE_TOKEN',
        stage: 'service-token',
        reason: /appName/,
        status: 401,
      },
    },
  ];

  it.each(cases)('$name', async ({ jwks, token, expected }) => {
    if (jwks === 'unreachable') {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    } else {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(jwksResponse(jwks));
    }
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.test' });
    const refused: OxyAuthRefusal[] = [];

    const { request, response, next } = await runMiddleware(
      createOptionalOxyAuth(oxy, { auth: { onRefusal: (refusal) => refused.push(refusal) } }),
      { authorization: `Bearer ${token}` },
    );

    // Optional auth still does not answer for itself.
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(0);
    expect(response.body).toBeUndefined();

    const recorded = getOxyAuthRefusal(request as never);
    expect(recorded).toMatchObject({
      code: expected.code,
      stage: expected.stage,
      status: expected.status,
      optional: true,
    });
    expect(recorded?.reason).toMatch(expected.reason);
    expect(refused).toEqual([recorded]);

    const warned = refusalWarnings();
    expect(warned).toHaveLength(1);
    expect(warned[0]?.context).toMatchObject({ code: expected.code, optional: true });
    // The credential itself never reaches a log line.
    expect(JSON.stringify(warned[0])).not.toContain(token);
  });

  it('records a user token that carries no session', async () => {
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.test' });
    const { request, next } = await runMiddleware(
      createOptionalOxyAuth(oxy),
      { authorization: `Bearer ${userToken({})}` },
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(getOxyAuthRefusal(request as never)).toMatchObject({
      code: 'SESSION_REQUIRED',
      stage: 'token',
      optional: true,
    });
  });

  it('records a session the API refuses to validate, without logging the session id', async () => {
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.test' });
    jest.spyOn(oxy.session, 'validate').mockResolvedValue({ valid: false });
    const { request } = await runMiddleware(
      createOptionalOxyAuth(oxy),
      { authorization: `Bearer ${userToken({ sessionId: 'session-secret-value' })}` },
    );

    expect(getOxyAuthRefusal(request as never)).toMatchObject({
      code: 'INVALID_SESSION',
      stage: 'session',
    });
    expect(JSON.stringify(warnings)).not.toContain('session-secret-value');
  });

  it('keeps a validation transport failure diagnostic but id-free', async () => {
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.test' });
    const transport = Object.assign(new Error('connect ECONNREFUSED https://api.oxy.test/session/validate/session-secret-value'), {
      code: 'ECONNREFUSED',
    });
    jest.spyOn(oxy.session, 'validate').mockRejectedValue(transport);

    const { request } = await runMiddleware(
      createOptionalOxyAuth(oxy),
      { authorization: `Bearer ${userToken({ sessionId: 'session-secret-value' })}` },
    );

    const recorded = getOxyAuthRefusal(request as never);
    expect(recorded).toMatchObject({ code: 'SESSION_VALIDATION_ERROR', stage: 'session' });
    expect(recorded?.reason).toContain('ECONNREFUSED');
    expect(recorded?.reason).not.toContain('session-secret-value');
  });

  it('records a bearer that is not a JWT at all', async () => {
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.test' });
    const { request } = await runMiddleware(createOptionalOxyAuth(oxy), {
      authorization: 'Bearer not-a-jwt',
    });

    expect(getOxyAuthRefusal(request as never)).toMatchObject({
      code: 'INVALID_TOKEN_FORMAT',
      stage: 'token',
    });
  });

  it('treats an absent credential as absence, not refusal', async () => {
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.test' });
    const refused: OxyAuthRefusal[] = [];
    const { request, response, next } = await runMiddleware(
      createOptionalOxyAuth(oxy, { auth: { onRefusal: (refusal) => refused.push(refusal) } }),
      {},
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(0);
    expect(getOxyAuthRefusal(request as never)).toBeNull();
    expect(refused).toEqual([]);
    expect(refusalWarnings()).toEqual([]);
  });

  it('survives an onRefusal observer that throws', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jwksResponse({ keys: [] }));
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.test' });
    const { request, response, next } = await runMiddleware(
      createOptionalOxyAuth(oxy, {
        auth: { onRefusal: () => { throw new Error('observer blew up'); } },
      }),
      { authorization: `Bearer ${serviceToken(primary.privateKey, primaryJwk.kid)}` },
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(0);
    expect(getOxyAuthRefusal(request as never)).toMatchObject({ code: 'INVALID_SERVICE_TOKEN' });
  });
});

describe('a blocking mount answers exactly what it always answered', () => {
  it('keeps the generic 401 body while naming the refusal in the log', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jwksResponse({ keys: [] }));
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.test' });
    const { request, response, next } = await runMiddleware(
      createOxyAuthMiddleware(oxy),
      { authorization: `Bearer ${serviceToken(primary.privateKey, primaryJwk.kid)}` },
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
    // Unchanged, and deliberately uninformative.
    expect(response.body).toEqual({ error: 'Unauthorized', message: 'Authentication required' });
    expect(getOxyAuthRefusal(request as never)).toMatchObject({ code: 'INVALID_SERVICE_TOKEN' });
    expect(
      warnings.some((entry) => entry.message.includes('401 after refusal INVALID_SERVICE_TOKEN')),
    ).toBe(true);
  });

  it('reports a non-optional refusal as non-optional', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jwksResponse({ keys: [] }));
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.test' });
    const request = requestHarness({
      authorization: `Bearer ${serviceToken(primary.privateKey, primaryJwk.kid)}`,
    });
    const response = responseHarness();

    await oxy.middleware.auth()(request as never, response as never, jest.fn() as never);

    expect(response.statusCode).toBe(401);
    expect(getOxyAuthRefusal(request as never)).toMatchObject({
      code: 'INVALID_SERVICE_TOKEN',
      optional: false,
    });
    // The client is told the code on a blocking mount — that has always been
    // true and is not what this change touches.
    expect(response.body).toMatchObject({ code: 'INVALID_SERVICE_TOKEN', status: 401 });
  });
});
