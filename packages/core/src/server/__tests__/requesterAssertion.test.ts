/**
 * Present-requester assertions (ADR 0025): the format, the JWKS resolver, the
 * audience middleware and the two SDK calls.
 *
 * Built around what must be REFUSED. An assertion is the only thing that lets a
 * product's service token speak for a signed-in person at Alia, so every way to
 * forge, stretch, redirect or reuse one has its own case.
 */

import { generateKeyPairSync, randomUUID, sign as signBytes, type KeyObject } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { OxyServices } from '../../OxyServices';
import {
  createOxyJwksKeyResolver,
  createOxyRequesterAssertionAuth,
  OXY_REQUESTER_ASSERTION_HEADER,
  OxyRequesterAssertionError,
  signOxyRequesterAssertion,
  verifyOxyRequesterAssertion,
  type OxyRequesterAssertionClaims,
  type OxyRequesterAssertionIntrospection,
  type OxyRequesterAssertionRequest,
} from '../requesterAssertion';

const NOW = new Date('2026-09-17T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const ISSUER = 'https://api.oxy.so';
const KEY = generateKeyPairSync('ed25519');
const OTHER_KEY = generateKeyPairSync('ed25519');
const KEY_ID = 'cap-test-1';

function claims(overrides: Partial<OxyRequesterAssertionClaims> = {}): OxyRequesterAssertionClaims {
  return {
    iss: ISSUER,
    aud: 'alia',
    sub: 'requester-1',
    jti: randomUUID(),
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 120,
    azp: 'homiio-app',
    cid: 'sindi-credential',
    agentId: 'sindi-agent',
    ...overrides,
  };
}

function sign(value: OxyRequesterAssertionClaims, privateKey: KeyObject = KEY.privateKey): string {
  return signOxyRequesterAssertion(value, { keyId: KEY_ID, privateKey });
}

/** Hand-rolled JWS so tests can produce what the real signer refuses to. */
function rawToken(header: Record<string, unknown>, payload: Record<string, unknown>, privateKey = KEY.privateKey): string {
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${input}.${signBytes(null, Buffer.from(input), privateKey).toString('base64url')}`;
}

function verify(token: string, overrides: Partial<Parameters<typeof verifyOxyRequesterAssertion>[1]> = {}) {
  return verifyOxyRequesterAssertion(token, {
    publicKey: KEY.publicKey,
    issuer: ISSUER,
    audience: 'alia',
    now: NOW,
    ...overrides,
  });
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof OxyRequesterAssertionError) return error.code;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('requester assertion format', () => {
  it('round-trips a signed assertion', () => {
    const value = claims();
    expect(verify(sign(value))).toEqual(value);
  });

  it('refuses a signature from any other key', () => {
    expect(codeOf(() => verify(sign(claims()), { publicKey: OTHER_KEY.publicKey }))).toBe('invalid_signature');
    expect(codeOf(() => verify(sign(claims(), OTHER_KEY.privateKey)))).toBe('invalid_signature');
  });

  it('refuses a payload altered after signing', () => {
    const [header, , signature] = sign(claims()).split('.');
    const forged = Buffer.from(JSON.stringify(claims({ sub: 'someone-else' }))).toString('base64url');
    expect(codeOf(() => verify(`${header}.${forged}.${signature}`))).toBe('invalid_signature');
  });

  it('refuses an unknown key', () => {
    expect(codeOf(() => verify(sign(claims()), { publicKey: undefined }))).toBe('unknown_key');
  });

  it('refuses expired, future and over-long assertions', () => {
    expect(codeOf(() => verify(sign(claims({ iat: NOW_SECONDS - 200, exp: NOW_SECONDS - 80 }))))).toBe('expired');
    expect(codeOf(() => verify(sign(claims({ iat: NOW_SECONDS + 60, exp: NOW_SECONDS + 180 }))))).toBe('not_yet_valid');
    const long = rawToken({ alg: 'EdDSA', typ: 'OXY-REQUESTER+JWT', kid: KEY_ID }, claims({ exp: NOW_SECONDS + 3600 }));
    expect(codeOf(() => verify(long))).toBe('ttl_exceeded');
    expect(() => sign(claims({ exp: NOW_SECONDS + 3600 }))).toThrow(OxyRequesterAssertionError);
  });

  it('refuses the wrong audience and the wrong issuer', () => {
    expect(codeOf(() => verify(sign(claims({ aud: 'syra' }))))).toBe('wrong_audience');
    expect(codeOf(() => verify(sign(claims({ iss: 'https://evil.example' }))))).toBe('wrong_issuer');
  });

  it('refuses other token types, alg none and extra header members', () => {
    const payload = claims();
    expect(codeOf(() => verify(rawToken({ alg: 'EdDSA', typ: 'OXY-CAPABILITY+JWT', kid: KEY_ID }, payload)))).toBe('malformed');
    expect(codeOf(() => verify(rawToken({ alg: 'EdDSA', typ: 'JWT', kid: KEY_ID }, payload)))).toBe('malformed');
    expect(codeOf(() => verify(rawToken({ alg: 'none', typ: 'OXY-REQUESTER+JWT', kid: KEY_ID }, payload)))).toBe('malformed');
    expect(codeOf(() => verify(rawToken({ alg: 'EdDSA', typ: 'OXY-REQUESTER+JWT', kid: KEY_ID, jku: 'x' }, payload)))).toBe('malformed');
    const [header, body] = sign(payload).split('.');
    expect(codeOf(() => verify(`${header}.${body}.`))).toBe('malformed');
    expect(codeOf(() => verify('not-a-token'))).toBe('malformed');
  });

  it('refuses unknown or missing claims', () => {
    const header = { alg: 'EdDSA', typ: 'OXY-REQUESTER+JWT', kid: KEY_ID };
    expect(codeOf(() => verify(rawToken(header, { ...claims(), scopes: ['*'] })))).toBe('invalid_claims');
    const { agentId: _agentId, ...withoutAgent } = claims();
    expect(codeOf(() => verify(rawToken(header, withoutAgent)))).toBe('invalid_claims');
  });
});

describe('JWKS key resolver', () => {
  const jwk = { ...KEY.publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'EdDSA', kid: KEY_ID };

  function fetchReturning(body: unknown) {
    return jest.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  }

  it('resolves and caches a published Ed25519 key', async () => {
    const fetchImpl = fetchReturning({ keys: [jwk] });
    const resolve = createOxyJwksKeyResolver({ jwksUrl: 'https://api.oxy.so/jwks', fetch: fetchImpl as never });
    const key = await resolve(KEY_ID);
    expect(key?.asymmetricKeyType).toBe('ed25519');
    expect(verify(sign(claims()), { publicKey: key })).toBeDefined();
    await resolve(KEY_ID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rate-limits refreshes caused by unknown key ids', async () => {
    let clock = 0;
    const fetchImpl = fetchReturning({ keys: [jwk] });
    const resolve = createOxyJwksKeyResolver({ jwksUrl: 'https://api.oxy.so/jwks', fetch: fetchImpl as never, clock: () => clock });
    for (let i = 0; i < 10; i += 1) expect(await resolve(`forged-${i}`)).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 61_000;
    await resolve('forged-late');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never accepts a key set that publishes private material', async () => {
    const privateJwk = { ...KEY.privateKey.export({ format: 'jwk' }), use: 'sig', alg: 'EdDSA', kid: KEY_ID };
    const resolve = createOxyJwksKeyResolver({ jwksUrl: 'https://api.oxy.so/jwks', fetch: fetchReturning({ keys: [privateJwk] }) as never });
    expect(await resolve(KEY_ID)).toBeUndefined();
  });
});

describe('createOxyRequesterAssertionAuth', () => {
  const serviceApp = {
    appId: 'homiio-app',
    appName: 'Homiio',
    credentialId: 'sindi-credential',
    ownerAccountId: 'homiio-owner',
    scopes: ['inference:invoke'],
    environment: 'live' as const,
  };

  function activeAnswer(value: OxyRequesterAssertionClaims): OxyRequesterAssertionIntrospection {
    return {
      active: true,
      requesterAccountId: value.sub,
      agentId: value.agentId,
      applicationId: value.azp,
      credentialId: value.cid,
      jti: value.jti,
      expiresAt: new Date(value.exp * 1000).toISOString(),
    };
  }

  function harness(introspect: (input: unknown) => Promise<OxyRequesterAssertionIntrospection>) {
    const introspector = {
      introspectRequesterAssertion: jest.fn(introspect),
      getBaseURL: () => 'https://api.oxy.so',
    };
    const middleware = createOxyRequesterAssertionAuth(introspector, {
      audience: 'alia',
      now: () => NOW,
      resolvePublicKey: async (keyId) => (keyId === KEY_ID ? KEY.publicKey : undefined),
    });
    const run = async (request: Partial<OxyRequesterAssertionRequest> & { headers: Record<string, unknown> }) => {
      let statusCode = 200;
      let body: Record<string, unknown> | undefined;
      const res = {
        status(code: number) { statusCode = code; return this; },
        json(value: Record<string, unknown>) { body = value; return this; },
      } as unknown as Response;
      const next = jest.fn() as unknown as NextFunction;
      await middleware(request as unknown as Request, res, next);
      return { statusCode, body, next: next as unknown as jest.Mock, request: request as OxyRequesterAssertionRequest };
    };
    return { introspector, run };
  }

  it('does nothing without the header', async () => {
    const { run, introspector } = harness(async () => ({ active: false }));
    const result = await run({ headers: {}, serviceApp });
    expect(result.next).toHaveBeenCalledTimes(1);
    expect(result.request.userId).toBeUndefined();
    expect(introspector.introspectRequesterAssertion).not.toHaveBeenCalled();
  });

  it('attaches the requester only after live introspection succeeds', async () => {
    const value = claims();
    const assertion = sign(value);
    const { run, introspector } = harness(async () => activeAnswer(value));
    const result = await run({ headers: { [OXY_REQUESTER_ASSERTION_HEADER]: assertion }, serviceApp, userId: null, user: null });
    expect(result.next).toHaveBeenCalledTimes(1);
    expect(result.request.userId).toBe('requester-1');
    expect(result.request.user).toEqual({ id: 'requester-1' });
    expect(result.request.oxyRequester).toMatchObject({ userId: 'requester-1', agentId: 'sindi-agent', jti: value.jti });
    expect(introspector.introspectRequesterAssertion).toHaveBeenCalledWith({
      assertion,
      presenter: { applicationId: 'homiio-app', credentialId: 'sindi-credential' },
    });
  });

  it('requires a verified service token as presenter', async () => {
    const { run } = harness(async () => activeAnswer(claims()));
    const result = await run({ headers: { [OXY_REQUESTER_ASSERTION_HEADER]: sign(claims()) } });
    expect(result.statusCode).toBe(401);
    expect(result.body?.code).toBe('service_token_required');
    expect(result.next).not.toHaveBeenCalled();
  });

  it('refuses to combine with offline delegation or an existing identity', async () => {
    const { run, introspector } = harness(async () => activeAnswer(claims()));
    const assertion = sign(claims());
    for (const request of [
      { headers: { [OXY_REQUESTER_ASSERTION_HEADER]: assertion, 'x-oxy-user-id': 'victim' }, serviceApp },
      { headers: { [OXY_REQUESTER_ASSERTION_HEADER]: assertion }, serviceApp, serviceActingAs: { userId: 'victim', scopes: [] } },
      { headers: { [OXY_REQUESTER_ASSERTION_HEADER]: assertion }, serviceApp, userId: 'victim' },
    ]) {
      const result = await run(request);
      expect(result.statusCode).toBe(400);
      expect(result.next).not.toHaveBeenCalled();
    }
    expect(introspector.introspectRequesterAssertion).not.toHaveBeenCalled();
  });

  it('refuses an assertion presented by another application or credential without spending it', async () => {
    const { run, introspector } = harness(async () => activeAnswer(claims()));
    for (const presenter of [
      { ...serviceApp, appId: 'other-app' },
      { ...serviceApp, credentialId: 'other-credential' },
    ]) {
      const result = await run({ headers: { [OXY_REQUESTER_ASSERTION_HEADER]: sign(claims()) }, serviceApp: presenter });
      expect(result.statusCode).toBe(401);
      expect(result.body?.code).toBe('presenter_mismatch');
    }
    expect(introspector.introspectRequesterAssertion).not.toHaveBeenCalled();
  });

  it('refuses forged, expired and wrong-audience assertions before introspection', async () => {
    const { run, introspector } = harness(async () => activeAnswer(claims()));
    for (const [token, code] of [
      [sign(claims(), OTHER_KEY.privateKey), 'invalid_signature'],
      [sign(claims({ iat: NOW_SECONDS - 300, exp: NOW_SECONDS - 180 })), 'expired'],
      [sign(claims({ aud: 'kaana' })), 'wrong_audience'],
      [signOxyRequesterAssertion(claims(), { keyId: 'unknown', privateKey: KEY.privateKey }), 'unknown_key'],
      ['garbage', 'malformed'],
    ] as const) {
      const result = await run({ headers: { [OXY_REQUESTER_ASSERTION_HEADER]: token }, serviceApp });
      expect(result.statusCode).toBe(401);
      expect(result.body?.code).toBe(code);
    }
    expect(introspector.introspectRequesterAssertion).not.toHaveBeenCalled();
  });

  it('refuses a replayed (inactive) assertion and a mismatched introspection answer', async () => {
    const value = claims();
    const answers: OxyRequesterAssertionIntrospection[] = [
      { active: false },
      { ...activeAnswer(value), requesterAccountId: 'someone-else' },
      { ...activeAnswer(value), agentId: 'other-agent' },
      { ...activeAnswer(value), jti: randomUUID() },
    ];
    const { run } = harness(async () => answers.shift() as OxyRequesterAssertionIntrospection);
    for (let i = 0; i < 4; i += 1) {
      const result = await run({ headers: { [OXY_REQUESTER_ASSERTION_HEADER]: sign(value) }, serviceApp });
      expect(result.statusCode).toBe(401);
      expect(result.body?.error).toBe('REQUESTER_ASSERTION_INACTIVE');
      expect(result.request.userId).toBeUndefined();
    }
  });

  it('fails closed when Oxy cannot be asked', async () => {
    const { run } = harness(async () => { throw new Error('ECONNREFUSED'); });
    const result = await run({ headers: { [OXY_REQUESTER_ASSERTION_HEADER]: sign(claims()) }, serviceApp });
    expect(result.statusCode).toBe(503);
    expect(result.next).not.toHaveBeenCalled();
  });
});

describe('OxyServices requester assertion calls', () => {
  afterEach(() => jest.restoreAllMocks());

  it('mints with the product service token and sends the subject token only in the body', async () => {
    const oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    jest.spyOn(oxy, 'getServiceToken').mockResolvedValue('product-service-token');
    const spy = jest.spyOn(oxy, 'makeRequest').mockResolvedValue({ assertion: 'a', expiresAt: 'e', requesterAccountId: 'u', agentId: 'g' } as never);
    await oxy.mintRequesterAssertion({ agentId: 'sindi-agent', subjectToken: 'human-bearer' });
    const [method, url, data, options] = spy.mock.calls[0] ?? [];
    expect(method).toBe('POST');
    expect(url).toBe('/internal/native-agents/requester-assertions');
    expect(data).toEqual({ agentId: 'sindi-agent', subjectToken: 'human-bearer' });
    expect(options?.headers).toEqual({ Authorization: 'Bearer product-service-token' });
    expect(options?.retry).toBe(false);
    expect(JSON.stringify(options)).not.toContain('human-bearer');
  });

  it('introspects with the audience service token and never retries a consuming call', async () => {
    const oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    jest.spyOn(oxy, 'getServiceToken').mockResolvedValue('alia-service-token');
    const spy = jest.spyOn(oxy, 'makeRequest').mockResolvedValue({ active: false } as never);
    const presenter = { applicationId: 'homiio-app', credentialId: 'sindi-credential' };
    await expect(oxy.introspectRequesterAssertion({ assertion: 'signed', presenter })).resolves.toEqual({ active: false });
    const [method, url, data, options] = spy.mock.calls[0] ?? [];
    expect([method, url]).toEqual(['POST', '/internal/native-agents/requester-assertions/introspect']);
    expect(data).toEqual({ assertion: 'signed', presenter });
    expect(options?.headers).toEqual({ Authorization: 'Bearer alia-service-token' });
    expect(options?.retry).toBe(false);
  });
});
