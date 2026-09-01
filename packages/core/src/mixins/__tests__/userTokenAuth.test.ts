/**
 * User-token authentication security regression tests
 *
 * Locks in the fix for the `oxy.auth()` authentication bypass.
 *
 * `auth()` decodes the bearer JWT with `jwtDecode`, which does NOT verify a
 * signature — deliberately, since third-party backends mounting this middleware
 * do not hold the Oxy signing secret. Every claim is therefore attacker
 * controlled, and the middleware previously trusted two of them anyway:
 *
 *   1. **Session-less tokens were trusted outright.** When the payload carried
 *      no `sessionId`, the middleware skipped the network entirely and did:
 *
 *          req.userId = userId;                 // straight from the claim
 *          req.user   = { id: userId } as User;
 *
 *      Anyone could authenticate as anyone on every Oxy backend mounting
 *      `oxy.auth()` / `createOxyAuthMiddleware()` by hand-rolling a JWT with a
 *      `userId` claim, a future `exp`, and a garbage signature. Victim ids are
 *      public (`GET /profiles/username/:handle`).
 *
 *   2. **The session path trusted the claimed user id.** `GET
 *      /session/validate/:sessionId` is UNAUTHENTICATED and returns whichever
 *      user owns the session id it is handed; it does not bind the bearer
 *      token. `auth()` then set `req.userId` from the JWT claim rather than
 *      from the validated session, so a caller holding ANY live session id —
 *      their own, for instance — could pair it with a forged `userId` and be
 *      trusted as that user. `authSocket()` already cross-checked this; the
 *      HTTP middleware did not.
 *
 * Both are now closed: a user token MUST carry a `sessionId`, and `req.userId`
 * comes off the validated session, never off the token.
 *
 * There is nothing legitimate to preserve on the session-less path: every user
 * access token the Oxy API issues carries a `sessionId`
 * (`packages/api/src/utils/sessionUtils.ts`, `generateSessionTokens`, which is
 * the only user-token mint site — the OAuth code exchange routes through it
 * too). The `pre-authentication token shapes` block below covers the class of
 * signed-but-session-less token that must never resolve to a logged-in
 * identity, using the two shapes the API used to mint before they were removed.
 *
 * These tests exercise a real `OxyServices` instance with `validateSession`
 * stubbed, so the middleware's own logic runs end to end without the network.
 */

import crypto from 'node:crypto';
import { OxyServices } from '../../OxyServices';
import type { User } from '../../models/interfaces';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface UserTokenClaims {
  userId?: unknown;
  id?: unknown;
  sessionId?: unknown;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

const b64url = (input: Buffer | string): string => {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const ONE_HOUR_FROM_NOW = (): number => Math.floor(Date.now() / 1000) + 3600;

/** A JWT whose signature is invented. Structurally valid, cryptographically worthless. */
const forgeToken = (
  claims: UserTokenClaims,
  signature = 'AAAAcompletely-invented-signature',
): string => {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iat: Math.floor(Date.now() / 1000), exp: ONE_HOUR_FROM_NOW(), ...claims }),
  );
  return `${header}.${payload}.${signature}`;
};

/** An `alg: none` JWT — the classic unsigned-token attack. */
const forgeAlgNoneToken = (claims: UserTokenClaims): string => {
  const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iat: Math.floor(Date.now() / 1000), exp: ONE_HOUR_FROM_NOW(), ...claims }),
  );
  return `${header}.${payload}.`;
};

/**
 * A genuinely HS256-signed token, byte-identical in shape to what
 * `jsonwebtoken.sign()` produces in the API. The middleware never checks this
 * signature for user tokens — security comes from the session round-trip — but
 * signing the fixtures keeps them honest about what production sends, and
 * proves the refusal is not merely "the signature looked wrong".
 */
const signToken = (claims: UserTokenClaims, secret: string): string => {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iat: Math.floor(Date.now() / 1000),
      exp: ONE_HOUR_FROM_NOW(),
      type: 'access',
      deviceId: 'device-1',
      ...claims,
    }),
  );
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${payload}.${signature}`;
};

interface MockReq {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  userId?: string | null;
  user?: unknown;
  accessToken?: string;
  sessionId?: string | null;
  serviceApp?: unknown;
  serviceActingAs?: unknown;
}

interface MockRes {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

const makeReq = (overrides: Partial<MockReq> = {}): MockReq => ({
  method: 'GET',
  path: '/api/whoami',
  headers: {},
  query: {},
  ...overrides,
});

const makeRes = (): MockRes => ({
  statusCode: 0,
  body: undefined,
  headersSent: false,
  status(code: number) {
    this.statusCode = code;
    return this;
  },
  json(body: unknown) {
    this.body = body;
    this.headersSent = true;
    return this;
  },
});

/** Run the middleware against the loose Express shape it declares internally. */
const run = async (
  middleware: ReturnType<OxyServices['auth']>,
  req: MockReq,
  res: MockRes,
  next: jest.Mock,
): Promise<void> => {
  await middleware(req as unknown as never, res as unknown as never, next as unknown as never);
};

const VICTIM_ID = '507f1f77bcf86cd799439011';
const ATTACKER_ID = '507f1f77bcf86cd799439022';
const ACCESS_TOKEN_SECRET = 'test-access-token-secret-not-production';

const asUser = (id: string): User => ({ id }) as User;

const validSessionFor = (user: User) => ({
  valid: true as const,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  lastActivity: new Date().toISOString(),
  user,
});

// ---------------------------------------------------------------------------
// Hole 1 — session-less user tokens must never authenticate
// ---------------------------------------------------------------------------

describe('user tokens without a sessionId are refused', () => {
  let oxy: OxyServices;
  let validateSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    // Any call here would mean the middleware went to the network on a path
    // that must be decided locally. Assertions below check it never happens.
    validateSpy = jest.spyOn(oxy, 'validateSession');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a forged token whose signature is garbage', async () => {
    const req = makeReq({
      headers: { authorization: `Bearer ${forgeToken({ userId: VICTIM_ID })}` },
    });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(req.userId).toBeUndefined();
    expect(req.user).toBeUndefined();
    expect(req.accessToken).toBeUndefined();
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('rejects a token with an empty signature segment', async () => {
    const req = makeReq({
      headers: { authorization: `Bearer ${forgeToken({ userId: VICTIM_ID }, '')}` },
    });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(req.userId).toBeUndefined();
  });

  it('rejects an alg:none token', async () => {
    const req = makeReq({
      headers: { authorization: `Bearer ${forgeAlgNoneToken({ userId: VICTIM_ID })}` },
    });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(req.userId).toBeUndefined();
  });

  it('rejects a session-less token that carries the id claim instead of userId', async () => {
    const req = makeReq({ headers: { authorization: `Bearer ${forgeToken({ id: VICTIM_ID })}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(req.userId).toBeUndefined();
  });

  it('rejects a genuinely signed session-less token, so the refusal is not about the signature', async () => {
    const token = signToken({ userId: VICTIM_ID }, ACCESS_TOKEN_SECRET);
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(req.userId).toBeUndefined();
  });

  it('treats a non-string sessionId claim as no session at all', async () => {
    // A decoded payload is attacker-supplied JSON: `sessionId` can be an
    // object, and a truthiness check would have let it through into URL
    // construction.
    const req = makeReq({
      headers: {
        authorization: `Bearer ${forgeToken({ userId: VICTIM_ID, sessionId: { toString: 'x' } })}`,
      },
    });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('treats an empty-string sessionId claim as no session at all', async () => {
    const req = makeReq({
      headers: { authorization: `Bearer ${forgeToken({ userId: VICTIM_ID, sessionId: '' })}` },
    });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('never loads a user profile for a session-less token, even with loadUser', async () => {
    const getCurrentUserSpy = jest.spyOn(oxy, 'getCurrentUser');
    const req = makeReq({
      headers: { authorization: `Bearer ${forgeToken({ userId: VICTIM_ID })}` },
    });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth({ loadUser: true }), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(req.userId).toBeUndefined();
    expect(getCurrentUserSpy).not.toHaveBeenCalled();
  });

  it('treats a session-less token as anonymous under optional auth, never as the claimed user', async () => {
    const req = makeReq({
      headers: { authorization: `Bearer ${forgeToken({ userId: VICTIM_ID })}` },
    });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth({ optional: true }), req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headersSent).toBe(false);
    expect(req.userId).toBeNull();
    expect(req.user).toBeNull();
    expect(req.accessToken).toBeUndefined();
  });

  it('does not admit a session-less token via the jwtSecret / service-token path', async () => {
    // `jwtSecret` exists to verify SERVICE tokens. A user token must not gain
    // anything by its presence, whether or not it is signed with that secret.
    const token = signToken({ userId: VICTIM_ID }, ACCESS_TOKEN_SECRET);
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth({ jwtSecret: ACCESS_TOKEN_SECRET }), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(req.userId).toBeUndefined();
    expect(req.serviceApp).toBeUndefined();
  });

  it('does not admit a session-less token via the X-Oxy-User-Id delegation header', async () => {
    // Delegation is a SERVICE-token feature. The header must not turn a user
    // token into an acting-as grant, nor reach the grant lookup at all.
    const grantSpy = jest.spyOn(oxy, 'verifyServiceActingAs');
    const req = makeReq({
      headers: {
        authorization: `Bearer ${forgeToken({ userId: ATTACKER_ID })}`,
        'x-oxy-user-id': VICTIM_ID,
      },
    });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth({ jwtSecret: ACCESS_TOKEN_SECRET }), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(req.userId).toBeUndefined();
    expect(req.serviceActingAs).toBeUndefined();
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('reports SESSION_REQUIRED through a custom onError handler', async () => {
    const onError = jest.fn();
    const req = makeReq({
      headers: { authorization: `Bearer ${forgeToken({ userId: VICTIM_ID })}` },
    });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth({ onError }), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.headersSent).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SESSION_REQUIRED', status: 401 }),
    );
  });
});

// ---------------------------------------------------------------------------
// The pre-authentication token class
// ---------------------------------------------------------------------------

describe('pre-authentication token shapes never resolve to a logged-in identity', () => {
  let oxy: OxyServices;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * These two shapes were minted by `controllers/session.controller.ts` and
   * signed with `ACCESS_TOKEN_SECRET`, carrying `userId` and no `sessionId`.
   * Both were issued BEFORE authentication completed — one between the password
   * step and the second factor, one to a caller proving only that they had
   * received a recovery code — and the old middleware accepted either as the
   * fully signed-in user.
   *
   * The password / 2FA / recovery backend was removed in `8bfdd965`, so neither
   * token exists on `main` today. They stay here as the regression fixtures for
   * the CLASS: any future signed, session-less, pre-authentication token must
   * be refused by construction rather than by nobody happening to mint one.
   */
  it('refuses the 2FA-challenge shape (signed, userId, no sessionId)', async () => {
    const loginToken = signToken(
      { userId: VICTIM_ID, purpose: '2fa_challenge' },
      ACCESS_TOKEN_SECRET,
    );
    const req = makeReq({ headers: { authorization: `Bearer ${loginToken}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(req.userId).toBeUndefined();
  });

  it('refuses the account-recovery shape (signed, userId, no sessionId)', async () => {
    const recoveryToken = signToken(
      { type: 'recovery', recoveryId: 'rec-1', userId: VICTIM_ID },
      ACCESS_TOKEN_SECRET,
    );
    const req = makeReq({ headers: { authorization: `Bearer ${recoveryToken}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(req.userId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Hole 2 — the identity must come from the validated session, not the claim
// ---------------------------------------------------------------------------

describe('session-backed user tokens bind identity to the validated session', () => {
  let oxy: OxyServices;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a token pairing a live session with a forged userId claim', async () => {
    // The attacker holds their OWN valid session and swaps the userId claim.
    // `/session/validate/:id` is unauthenticated, so obtaining a live session
    // id is not the hard part — binding it to an identity is.
    jest.spyOn(oxy, 'validateSession').mockResolvedValue(validSessionFor(asUser(ATTACKER_ID)));

    const token = forgeToken({ userId: VICTIM_ID, sessionId: 'attacker-session' });
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_USER_MISMATCH' });
    expect(req.userId).toBeUndefined();
    expect(req.user).toBeUndefined();
    expect(req.accessToken).toBeUndefined();
  });

  it('rejects a session whose validation returns no user', async () => {
    jest.spyOn(oxy, 'validateSession').mockResolvedValue({
      valid: true,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      lastActivity: new Date().toISOString(),
    } as unknown as Awaited<ReturnType<OxyServices['validateSession']>>);

    const token = forgeToken({ userId: VICTIM_ID, sessionId: 'session-1' });
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'INVALID_SESSION' });
    expect(req.userId).toBeUndefined();
  });

  it('rejects a session whose user carries no usable id', async () => {
    jest
      .spyOn(oxy, 'validateSession')
      .mockResolvedValue(validSessionFor({ username: 'ghost' } as unknown as User));

    const token = forgeToken({ userId: VICTIM_ID, sessionId: 'session-1' });
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'INVALID_SESSION' });
    expect(req.userId).toBeUndefined();
  });

  it('accepts a matching session and takes the id from the server, not the token', async () => {
    jest.spyOn(oxy, 'validateSession').mockResolvedValue(validSessionFor(asUser(VICTIM_ID)));

    const token = signToken({ userId: VICTIM_ID, sessionId: 'session-1' }, ACCESS_TOKEN_SECRET);
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headersSent).toBe(false);
    expect(req.userId).toBe(VICTIM_ID);
    expect(req.sessionId).toBe('session-1');
    expect(req.accessToken).toBe(token);
    expect(req.user).toEqual({ id: VICTIM_ID });
  });

  it('accepts a session identified by the raw Mongo _id shape', async () => {
    jest
      .spyOn(oxy, 'validateSession')
      .mockResolvedValue(validSessionFor({ _id: VICTIM_ID } as unknown as User));

    const token = signToken({ userId: VICTIM_ID, sessionId: 'session-1' }, ACCESS_TOKEN_SECRET);
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userId).toBe(VICTIM_ID);
  });

  it('attaches the full validated profile when loadUser is set, with no extra round-trip', async () => {
    const fullUser = {
      id: VICTIM_ID,
      username: 'victim',
      email: 'victim@example.com',
    } as User;
    jest.spyOn(oxy, 'validateSession').mockResolvedValue(validSessionFor(fullUser));
    const getCurrentUserSpy = jest.spyOn(oxy, 'getCurrentUser');

    const token = signToken({ userId: VICTIM_ID, sessionId: 'session-1' }, ACCESS_TOKEN_SECRET);
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth({ loadUser: true }), req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual(fullUser);
    expect(getCurrentUserSpy).not.toHaveBeenCalled();
  });

  it('rejects an invalid session', async () => {
    jest.spyOn(oxy, 'validateSession').mockResolvedValue({
      valid: false,
    } as unknown as Awaited<ReturnType<OxyServices['validateSession']>>);

    const token = signToken({ userId: VICTIM_ID, sessionId: 'revoked' }, ACCESS_TOKEN_SECRET);
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'INVALID_SESSION' });
  });

  it('rejects when session validation throws', async () => {
    jest.spyOn(oxy, 'validateSession').mockRejectedValue(new Error('session not found'));

    const token = signToken({ userId: VICTIM_ID, sessionId: 'nope' }, ACCESS_TOKEN_SECRET);
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_VALIDATION_ERROR' });
    expect(req.userId).toBeUndefined();
  });

  it('rejects an expired token before any session round-trip', async () => {
    const validateSpy = jest.spyOn(oxy, 'validateSession');
    const token = forgeToken({
      userId: VICTIM_ID,
      sessionId: 'session-1',
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('falls back to anonymous, not to the claim, when optional auth hits a mismatch', async () => {
    jest.spyOn(oxy, 'validateSession').mockResolvedValue(validSessionFor(asUser(ATTACKER_ID)));

    const token = forgeToken({ userId: VICTIM_ID, sessionId: 'attacker-session' });
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth({ optional: true }), req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headersSent).toBe(false);
    expect(req.userId).toBeNull();
    expect(req.user).toBeNull();
  });

  it('never logs the token or the decoded payload when refusing a mismatch', async () => {
    // The warn on this path names ids (public) and nothing else.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(oxy, 'validateSession').mockResolvedValue(validSessionFor(asUser(ATTACKER_ID)));

    const token = forgeToken({ userId: VICTIM_ID, sessionId: 'attacker-session' });
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await run(oxy.auth(), req, res, next);

    const logged = warnSpy.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('attacker-session');
  });
});

// ---------------------------------------------------------------------------
// Socket auth keeps the same contract
// ---------------------------------------------------------------------------

describe('authSocket keeps refusing session-less tokens', () => {
  let oxy: OxyServices;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  interface MockSocket {
    handshake: { auth: { token?: string } };
    data?: Record<string, unknown>;
    user?: { id: string; userId: string; sessionId?: string | null };
  }

  const runSocket = async (socket: MockSocket, next: jest.Mock): Promise<void> => {
    await oxy.authSocket()(socket as unknown as never, next as unknown as never);
  };

  it('refuses a session-less token', async () => {
    const validateSpy = jest.spyOn(oxy, 'validateSession');
    const next = jest.fn();

    await runSocket({ handshake: { auth: { token: forgeToken({ userId: VICTIM_ID }) } } }, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Session required' }));
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('refuses a live session paired with a forged userId claim', async () => {
    jest.spyOn(oxy, 'validateSession').mockResolvedValue(validSessionFor(asUser(ATTACKER_ID)));
    const next = jest.fn();
    const socket: MockSocket = {
      handshake: { auth: { token: forgeToken({ userId: VICTIM_ID, sessionId: 'attacker-session' }) } },
    };

    await runSocket(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Session user mismatch' }));
    expect(socket.user).toBeUndefined();
  });

  it('accepts a matching session', async () => {
    jest.spyOn(oxy, 'validateSession').mockResolvedValue(validSessionFor(asUser(VICTIM_ID)));
    const next = jest.fn();
    const socket: MockSocket = {
      handshake: {
        auth: { token: signToken({ userId: VICTIM_ID, sessionId: 'session-1' }, ACCESS_TOKEN_SECRET) },
      },
    };

    await runSocket(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.user).toEqual({ id: VICTIM_ID, userId: VICTIM_ID, sessionId: 'session-1' });
    expect(socket.data?.sessionId).toBe('session-1');
  });
});
