/**
 * Access token v2 — the claim set, and the resource-server check that enforces
 * it (issue #937, Phase 6).
 *
 * These are the pure halves: what `generateSessionTokens` puts in a token, and
 * what `checkAccessTokenBinding` does with a token and the session row it
 * names. The lanes that CALL them — `validateSession`, the device lane, the
 * OAuth exchange — are covered against a real Postgres in
 * `services/__tests__/session.service.test.ts`,
 * `routes/__tests__/sessionDeviceThirdParty.test.ts` and
 * `routes/__tests__/oauthToken.test.ts`.
 *
 * Real `jsonwebtoken`, not the global mock: a test whose `sign` returns the
 * string `'mock-jwt-token'` cannot tell two mints apart, which is the single
 * most important property here.
 */

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import {
  ACCESS_TOKEN_VERSION,
  OXY_RESOURCE_SERVER,
  OXY_TOKEN_ISSUER,
  checkAccessTokenBinding,
  generateSessionTokens,
  validateAccessToken,
  type AccessTokenBinding,
  type SessionTokenBindingRow,
  type SessionTokenPayload,
} from '../sessionUtils';

const ACCESS_SECRET = `access-${randomUUID()}`;
const REFRESH_SECRET = `refresh-${randomUUID()}`;

/** A delegated session: Nate (`principal`) acting as The Oxy Collective (`subject`). */
const SUBJECT = 'account-oxy-collective';
const PRINCIPAL = 'user-nate';
const SESSION_ID = 'session-abc';
const DEVICE_ID = 'device-xyz';
const DEVICE_SESSION_ID = 'devsess-1';
const DEVICE_CONTEXT_ID = 'ctx-nate-oxy';
const CLIENT_ID = 'oxy_dk_thirdparty';

function binding(overrides: Partial<AccessTokenBinding> = {}): AccessTokenBinding {
  return {
    subjectAccountId: SUBJECT,
    principalUserId: PRINCIPAL,
    sessionId: SESSION_ID,
    deviceId: DEVICE_ID,
    deviceSessionId: DEVICE_SESSION_ID,
    deviceContextId: DEVICE_CONTEXT_ID,
    clientId: CLIENT_ID,
    scopes: ['read', 'write'],
    ...overrides,
  };
}

/** The `sessions` row that binding describes. */
function row(overrides: Partial<SessionTokenBindingRow> = {}): SessionTokenBindingRow {
  return {
    sessionId: SESSION_ID,
    userId: SUBJECT,
    operatedByUserId: PRINCIPAL,
    applicationId: 'app-1',
    clientId: CLIENT_ID,
    deviceSessionId: DEVICE_SESSION_ID,
    deviceContextId: DEVICE_CONTEXT_ID,
    scopes: ['read', 'write'],
    ...overrides,
  };
}

function claimsOf(token: string): SessionTokenPayload {
  const result = validateAccessToken(token);
  if (!result.valid || !result.payload) throw new Error('token did not verify');
  return result.payload;
}

beforeAll(() => {
  process.env.ACCESS_TOKEN_SECRET = ACCESS_SECRET;
  process.env.REFRESH_TOKEN_SECRET = REFRESH_SECRET;
});

beforeEach(() => {
  delete process.env.ACCESS_TOKEN_V1_WINDOW;
});

describe('the v2 claim set', () => {
  it('carries every claim issue #937 requires an application token to express', () => {
    const claims = claimsOf(generateSessionTokens(binding()).accessToken);

    expect(claims).toMatchObject({
      ver: ACCESS_TOKEN_VERSION,
      iss: OXY_TOKEN_ISSUER,
      sub: SUBJECT,
      act: { sub: PRINCIPAL },
      aud: [OXY_RESOURCE_SERVER],
      azp: CLIENT_ID,
      scope: 'read write',
      sid: SESSION_ID,
      device_session_id: DEVICE_SESSION_ID,
      device_context_id: DEVICE_CONTEXT_ID,
    });
    expect(typeof claims.jti).toBe('string');
    expect(typeof claims.iat).toBe('number');
    expect(typeof claims.exp).toBe('number');
  });

  it('never conflates the actor with the subject on a delegated session', () => {
    const claims = claimsOf(generateSessionTokens(binding()).accessToken);

    // The organization is what the token acts AS; the person is who is acting.
    // If these were ever collapsed the audit actor and the `account:act_as`
    // revocation path would both point at the organization itself.
    expect(claims.sub).toBe(SUBJECT);
    expect(claims.act?.sub).toBe(PRINCIPAL);
    expect(claims.sub).not.toBe(claims.act?.sub);
  });

  it('reports the actor as the subject itself on a first-party session', () => {
    const claims = claimsOf(
      generateSessionTokens(binding({ subjectAccountId: PRINCIPAL, principalUserId: PRINCIPAL }))
        .accessToken
    );

    expect(claims.sub).toBe(PRINCIPAL);
    expect(claims.act?.sub).toBe(PRINCIPAL);
  });

  it('omits azp, scope and the context claims when the session is bound to none of them', () => {
    // The shared device session every official app uses. Absent, not empty
    // string: an `azp` of `''` would be a claim that some application is the
    // authorized party.
    const claims = claimsOf(
      generateSessionTokens(
        binding({ clientId: null, scopes: [], deviceSessionId: null, deviceContextId: null })
      ).accessToken
    );

    expect(claims).not.toHaveProperty('azp');
    expect(claims).not.toHaveProperty('scope');
    expect(claims).not.toHaveProperty('device_session_id');
    expect(claims).not.toHaveProperty('device_context_id');
    // The v2 marker and the identity claims are still there.
    expect(claims.ver).toBe(ACCESS_TOKEN_VERSION);
    expect(claims.sub).toBe(SUBJECT);
  });

  it('keeps the v1 claims that @oxyhq/core/server reads decode-only', () => {
    // A third-party app backend holds no signing secret, so it decodes the
    // token, looks the session up over HTTP by `sessionId`, and compares
    // `userId` against what it gets back. Dropping either would sign every
    // consuming backend out.
    const claims = claimsOf(generateSessionTokens(binding()).accessToken);

    expect(claims.userId).toBe(SUBJECT);
    expect(claims.sessionId).toBe(SESSION_ID);
    expect(claims.deviceId).toBe(DEVICE_ID);
    expect(claims.type).toBe('access');
  });
});

describe('every mint is unique', () => {
  it('produces different access AND refresh tokens for two mints in the same second', () => {
    // The property this phase exists to establish. Before `jti`, the payload
    // was `{userId, sessionId, deviceId, type}` and `iat`/`exp` have one-second
    // resolution, so this pair was BYTE-IDENTICAL — which meant a rotation
    // inside one second left `previous_refresh_token === refresh_token` and did
    // not invalidate the token it was handed.
    const start = Date.now();
    const first = generateSessionTokens(binding());
    const second = generateSessionTokens(binding());
    // The assertion is only about a same-second pair, so prove they were one.
    expect(Math.floor(Date.now() / 1000)).toBe(Math.floor(start / 1000));

    expect(first.accessToken).not.toBe(second.accessToken);
    expect(first.refreshToken).not.toBe(second.refreshToken);
    expect(claimsOf(first.accessToken).jti).not.toBe(claimsOf(second.accessToken).jti);
  });

  it('gives the access and refresh halves of ONE mint different jti values', () => {
    const { accessToken, refreshToken } = generateSessionTokens(binding());
    const accessJti = claimsOf(accessToken).jti;
    const refreshJti = (jwt.verify(refreshToken, REFRESH_SECRET) as jwt.JwtPayload).jti;

    expect(accessJti).toBeDefined();
    expect(refreshJti).toBeDefined();
    expect(accessJti).not.toBe(refreshJti);
  });

  it('does not put the binding claims on the refresh half', () => {
    // The refresh token is presented to one endpoint, which reads the whole
    // binding off the row. A copy on the token could only ever drift from it.
    const decoded = jwt.verify(
      generateSessionTokens(binding()).refreshToken,
      REFRESH_SECRET
    ) as jwt.JwtPayload;

    expect(decoded.type).toBe('refresh');
    expect(decoded).not.toHaveProperty('azp');
    expect(decoded).not.toHaveProperty('scope');
    expect(decoded).not.toHaveProperty('device_context_id');
  });
});

describe('resource-server validation', () => {
  it('accepts a token that matches its row, and reports the actor and subject apart', () => {
    const result = checkAccessTokenBinding(
      claimsOf(generateSessionTokens(binding()).accessToken),
      row()
    );

    expect(result).toEqual({
      ok: true,
      identity: {
        version: 2,
        subjectAccountId: SUBJECT,
        principalUserId: PRINCIPAL,
        sessionId: SESSION_ID,
        applicationId: 'app-1',
        clientId: CLIENT_ID,
        deviceSessionId: DEVICE_SESSION_ID,
        deviceContextId: DEVICE_CONTEXT_ID,
        scopes: ['read', 'write'],
      },
    });
  });

  /**
   * Each case forges ONE claim and leaves everything else correct, so the named
   * check is the only thing that can reject it. A token is only forgeable here
   * because the test holds the signing secret; the point is that holding it is
   * not enough once the row disagrees.
   */
  it.each([
    ['issuer_mismatch', { iss: 'evil-issuer' }],
    ['audience_mismatch', { aud: ['some-other-resource-server'] }],
    ['wrong_token_type', { type: 'refresh' }],
    ['session_mismatch', { sid: 'session-somebody-else' }],
    ['subject_mismatch', { sub: 'account-somebody-else' }],
    ['actor_mismatch', { act: { sub: 'user-alice' } }],
    ['client_mismatch', { azp: 'oxy_dk_another_client' }],
    ['device_session_mismatch', { device_session_id: 'devsess-other' }],
    ['device_context_mismatch', { device_context_id: 'ctx-alice-oxy' }],
    ['scope_not_granted', { scope: 'read write admin' }],
  ])('refuses a token whose claims disagree with the row: %s', (reason, override) => {
    const authentic = claimsOf(generateSessionTokens(binding()).accessToken);
    const { iat: _iat, exp: _exp, ...claims } = authentic;
    const forged = jwt.sign({ ...claims, ...override }, ACCESS_SECRET, { expiresIn: '15m' });

    expect(checkAccessTokenBinding(claimsOf(forged), row())).toEqual({ ok: false, reason });
  });

  it('refuses a token claiming a context after the session was rebound to another one', () => {
    // The switch case: the token was minted for one context and the row now
    // names a different one. Nothing about the token changed, and it still
    // verifies — the row is what moved.
    const claims = claimsOf(generateSessionTokens(binding()).accessToken);

    expect(checkAccessTokenBinding(claims, row({ deviceContextId: 'ctx-nate-personal' }))).toEqual({
      ok: false,
      reason: 'device_context_mismatch',
    });
  });

  it('refuses an application-bound token once the row is no longer bound to it', () => {
    const claims = claimsOf(generateSessionTokens(binding()).accessToken);

    expect(
      checkAccessTokenBinding(claims, row({ applicationId: null, clientId: null }))
    ).toEqual({ ok: false, reason: 'client_mismatch' });
  });

  it('accepts a narrower scope claim than the row grants', () => {
    const claims = claimsOf(generateSessionTokens(binding({ scopes: ['read'] })).accessToken);
    const result = checkAccessTokenBinding(claims, row({ scopes: ['read', 'write'] }));

    expect(result.ok).toBe(true);
    // The token asked for less, so it gets less — the row is a ceiling, not a floor.
    expect(result.ok && result.identity.scopes).toEqual(['read']);
  });
});

describe('the v1 compatibility window', () => {
  /** A token in the shape every mint produced before this phase. */
  function v1Token(): string {
    return jwt.sign(
      { userId: SUBJECT, sessionId: SESSION_ID, deviceId: DEVICE_ID, type: 'access' },
      ACCESS_SECRET,
      { expiresIn: '15m' }
    );
  }

  it('is entered by the ABSENCE of ver:2, not by the absence of jti', () => {
    // A v1 token that happens to carry a `jti` is still v1: `jti` says the
    // token is not replayable, `ver` says the binding claims were minted.
    const withJti = jwt.sign(
      {
        userId: SUBJECT,
        sessionId: SESSION_ID,
        deviceId: DEVICE_ID,
        type: 'access',
        jti: randomUUID(),
      },
      ACCESS_SECRET,
      { expiresIn: '15m' }
    );

    const result = checkAccessTokenBinding(claimsOf(withJti), row());
    expect(result.ok).toBe(true);
    expect(result.ok && result.identity.version).toBe(1);
  });

  it('resolves a v1 token to the ROW\'s binding, so the row still governs it', () => {
    // A v1 token asserted nothing about the application, so refusing it on that
    // basis is impossible — but the device lane reads `applicationId`, and that
    // comes from the row either way. This is what keeps the third-party guard
    // working for a legacy bearer.
    const result = checkAccessTokenBinding(claimsOf(v1Token()), row());

    expect(result).toEqual({
      ok: true,
      identity: {
        version: 1,
        subjectAccountId: SUBJECT,
        principalUserId: PRINCIPAL,
        sessionId: SESSION_ID,
        applicationId: 'app-1',
        clientId: CLIENT_ID,
        deviceSessionId: DEVICE_SESSION_ID,
        deviceContextId: DEVICE_CONTEXT_ID,
        scopes: ['read', 'write'],
      },
    });
  });

  it('refuses every v1 token once the window is closed', () => {
    process.env.ACCESS_TOKEN_V1_WINDOW = 'closed';

    expect(checkAccessTokenBinding(claimsOf(v1Token()), row())).toEqual({
      ok: false,
      reason: 'legacy_window_closed',
    });
  });

  it('still accepts a v2 token once the window is closed', () => {
    process.env.ACCESS_TOKEN_V1_WINDOW = 'closed';

    expect(
      checkAccessTokenBinding(claimsOf(generateSessionTokens(binding()).accessToken), row()).ok
    ).toBe(true);
  });
});
