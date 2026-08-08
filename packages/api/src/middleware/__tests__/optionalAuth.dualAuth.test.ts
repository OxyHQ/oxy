/**
 * optionalUserOrServiceAuth + resolveViewerId — the dual-auth viewer resolution
 * for the recommendation surface.
 *
 * The token-verification primitives (`verifyServiceToken` from ./serviceToken,
 * `authenticateRequestNonBlocking` from ./authUtils) are mocked so we exercise
 * the REAL middleware/resolver branching without a DB or real JWTs.
 *
 * Asserts:
 *  - a VALID service token attaches `req.serviceApp` (non-blocking),
 *  - an INVALID/expired token attaches NO principal (anonymous) — never rejected,
 *  - a service token + `user:read` + an `X-Oxy-User-Id` of EITHER live account-id
 *    shape → that viewer id,
 *  - a service token WITHOUT `user:read` ignores the header (anonymous),
 *  - a malformed / missing `X-Oxy-User-Id` → anonymous,
 *  - a USER token resolves to its OWN session user and IGNORES `X-Oxy-User-Id`
 *    (anti-impersonation),
 *  - no token → anonymous.
 *
 * ## The cutover bug the uuid-v7 cases pin
 *
 * `resolveViewerId` gated the delegation header on
 * `Types.ObjectId.isValid(viewerId)`, which rejects the **uuid v7 every account
 * created after the Postgres cutover carries** (`@oxyhq/db`'s
 * `generatedId()`). A delegating service naming such a viewer therefore resolved
 * to `undefined` and the request SILENTLY DEGRADED TO ANONYMOUS — viewer-scoped
 * visibility filtering (blocks, restricts, private accounts, follow-gated
 * fields) stopped applying, with no error anywhere. That is a privacy
 * consequence, not a failure, which is exactly why nothing surfaced it.
 *
 * The guard is REPLACED, not deleted, and `optionalAuth.ts` says why: unlike its
 * siblings in `securityActivityService` / `identityBinding.service`, this one is
 * not a Mongoose `CastError` artifact but the documented input contract of a
 * cross-principal delegation header. `isAccountIdFormat` accepts BOTH live
 * shapes, so both are asserted below — narrow it back to 24-hex and
 * `resolves a uuid v7 …` goes red.
 */

// The global jest.setup.cjs stubs `jsonwebtoken` (sign → fixed string, verify →
// fixed payload). The scoped-media-token tests below mint and verify REAL tokens
// (HS256 over a key derived from ACCESS_TOKEN_SECRET), so restore the genuine
// module for this suite.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import { v7 as uuidv7 } from 'uuid';
import { signMediaToken } from '../../utils/mediaToken';

const mockVerifyServiceToken = jest.fn();
jest.mock('../serviceToken', () => ({
  __esModule: true,
  verifyServiceToken: (...args: unknown[]) => mockVerifyServiceToken(...args),
}));

const mockAuthNonBlocking = jest.fn();
// Fully mock authUtils (rather than requireActual) so loading optionalAuth does
// NOT pull in the real session.service chain and the database behind it. We
// provide only the members optionalAuth
// consumes: a pure bearer extractor and the non-blocking authenticator. The
// scoped media token is verified by the REAL `utils/mediaToken` (pure crypto),
// so no mock is needed for it.
jest.mock('../authUtils', () => ({
  __esModule: true,
  extractTokenFromRequest: (req: { headers: Record<string, string | undefined> }): string | undefined => {
    const auth = req.headers.authorization;
    return auth && auth.startsWith('Bearer ') ? auth.substring(7) : undefined;
  },
  authenticateRequestNonBlocking: (...args: unknown[]) => mockAuthNonBlocking(...args),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  optionalUserOrServiceAuth,
  resolveViewerId,
  getMediaViewerUserId,
  type OptionalUserOrServiceRequest,
} from '../optionalAuth';

function makeReq(overrides: Partial<OptionalUserOrServiceRequest> = {}): OptionalUserOrServiceRequest {
  return {
    headers: {},
    ...overrides,
  } as OptionalUserOrServiceRequest;
}

function runMiddleware(req: OptionalUserOrServiceRequest): Promise<void> {
  const res = {} as Response;
  return new Promise((resolve) => {
    void optionalUserOrServiceAuth(req, res, () => resolve());
  });
}

/**
 * The id shape EVERY account created since the Postgres cutover carries —
 * minted by the same `uuidv7()` inside `@oxyhq/db`'s `generatedId()` calls, not a
 * look-alike literal.
 */
const VIEWER_ID = uuidv7();
/** The pre-cutover shape, preserved verbatim in `text` for existing accounts. */
const LEGACY_VIEWER_ID = '64b0000000000000000000aa';
const OTHER_ID = uuidv7();

beforeEach(() => {
  mockVerifyServiceToken.mockReset();
  mockAuthNonBlocking.mockReset();
  mockAuthNonBlocking.mockResolvedValue({ user: null, source: null });
});

describe('optionalUserOrServiceAuth', () => {
  it('attaches req.serviceApp for a VALID service token and does not consult user-session auth', async () => {
    mockVerifyServiceToken.mockReturnValue({
      ok: true,
      payload: { type: 'service', appId: 'app1', appName: 'Mention', credentialId: 'c', scopes: ['user:read'] },
    });
    const req = makeReq({ headers: { authorization: 'Bearer svc' } });

    await runMiddleware(req);

    expect(req.serviceApp?.appId).toBe('app1');
    expect(req.user).toBeUndefined();
    expect(mockAuthNonBlocking).not.toHaveBeenCalled();
  });

  it('falls back to user-session auth when the token is NOT a service token', async () => {
    mockVerifyServiceToken.mockReturnValue({ ok: false, reason: 'not_service' });
    mockAuthNonBlocking.mockResolvedValue({ user: { _id: VIEWER_ID }, source: 'header' });
    const req = makeReq({ headers: { authorization: 'Bearer user' } });

    await runMiddleware(req);

    expect(req.serviceApp).toBeUndefined();
    expect(req.user?._id).toBe(VIEWER_ID);
  });

  it('attaches NO principal for an INVALID token (anonymous, never rejected)', async () => {
    mockVerifyServiceToken.mockReturnValue({ ok: false, reason: 'invalid' });
    mockAuthNonBlocking.mockResolvedValue({ user: null, source: 'header' });
    const req = makeReq({ headers: { authorization: 'Bearer garbage' } });

    await runMiddleware(req);

    expect(req.serviceApp).toBeUndefined();
    expect(req.user).toBeUndefined();
  });

  it('attaches NO principal for an EXPIRED token (anonymous)', async () => {
    mockVerifyServiceToken.mockReturnValue({ ok: false, reason: 'expired' });
    mockAuthNonBlocking.mockResolvedValue({ user: null, source: 'header' });
    const req = makeReq({ headers: { authorization: 'Bearer expired' } });

    await runMiddleware(req);

    expect(req.serviceApp).toBeUndefined();
    expect(req.user).toBeUndefined();
  });

  it('treats a request with no Authorization header as anonymous (user-session path yields null)', async () => {
    const req = makeReq();
    await runMiddleware(req);
    expect(req.serviceApp).toBeUndefined();
    expect(req.user).toBeUndefined();
    // verifyServiceToken is never called without a token.
    expect(mockVerifyServiceToken).not.toHaveBeenCalled();
  });
});

describe('resolveViewerId', () => {
  it('resolves the SESSION user for a user-token request and IGNORES X-Oxy-User-Id (anti-impersonation)', () => {
    const req = makeReq({
      user: { _id: VIEWER_ID } as OptionalUserOrServiceRequest['user'],
      headers: { 'x-oxy-user-id': OTHER_ID },
    });
    expect(resolveViewerId(req)).toBe(VIEWER_ID);
  });

  it('resolves a uuid v7 X-Oxy-User-Id — a post-cutover viewer is NOT dropped to anonymous', () => {
    // Under the deleted `Types.ObjectId.isValid` guard this returned `undefined`
    // and every viewer-scoped visibility filter downstream stopped applying,
    // silently, for every account created after the cutover.
    expect(VIEWER_ID).not.toMatch(/^[0-9a-f]{24}$/i);
    const req = makeReq({
      serviceApp: { type: 'service', appId: 'a', appName: 'n', credentialId: 'c', scopes: ['user:read'] },
      headers: { 'x-oxy-user-id': VIEWER_ID },
    });
    expect(resolveViewerId(req)).toBe(VIEWER_ID);
  });

  it('still resolves a 24-hex X-Oxy-User-Id — pre-cutover accounts keep working', () => {
    // Both shapes are live simultaneously: existing ids were preserved verbatim
    // so every foreign key survived the backfill.
    const req = makeReq({
      serviceApp: { type: 'service', appId: 'a', appName: 'n', credentialId: 'c', scopes: ['user:read'] },
      headers: { 'x-oxy-user-id': LEGACY_VIEWER_ID },
    });
    expect(resolveViewerId(req)).toBe(LEGACY_VIEWER_ID);
  });

  it('returns undefined for a service token WITHOUT user:read even with a valid header', () => {
    const req = makeReq({
      serviceApp: { type: 'service', appId: 'a', appName: 'n', credentialId: 'c', scopes: ['files:write'] },
      headers: { 'x-oxy-user-id': VIEWER_ID },
    });
    expect(resolveViewerId(req)).toBeUndefined();
  });

  it('returns undefined for a service token with a MALFORMED X-Oxy-User-Id', () => {
    const req = makeReq({
      serviceApp: { type: 'service', appId: 'a', appName: 'n', credentialId: 'c', scopes: ['user:read'] },
      headers: { 'x-oxy-user-id': 'not-an-objectid' },
    });
    expect(resolveViewerId(req)).toBeUndefined();
  });

  it('returns undefined for a service token with NO X-Oxy-User-Id (acts as itself)', () => {
    const req = makeReq({
      serviceApp: { type: 'service', appId: 'a', appName: 'n', credentialId: 'c', scopes: ['user:read'] },
      headers: {},
    });
    expect(resolveViewerId(req)).toBeUndefined();
  });

  it('returns undefined when no principal is present', () => {
    expect(resolveViewerId(makeReq())).toBeUndefined();
  });
});

/**
 * getMediaViewerUserId — resolves the viewer for `<img src>`/`<a download>`
 * media URLs that cannot carry an Authorization header OR a cookie, but DO carry
 * a SCOPED media token in `?mt=`. The token is pinned to a single file id
 * (`fid`) and must match the route param (`req.params.id`), so a token minted
 * for asset A cannot open asset B; expired/foreign/malformed tokens resolve to
 * anonymous.
 */
describe('getMediaViewerUserId (private media owner-from-scoped-media-token)', () => {
  const SECRET = 'test-access-secret';
  const FILE_A = '64c0000000000000000000a1';
  const FILE_B = '64c0000000000000000000b2';
  const OWNER = 'owner-123';
  let prevSecret: string | undefined;

  function makeMediaReq(
    query: Record<string, unknown>,
    fileId: string,
    user?: { _id: string },
  ): OptionalUserOrServiceRequest {
    return {
      headers: {},
      query,
      params: { id: fileId },
      user,
    } as unknown as OptionalUserOrServiceRequest;
  }

  beforeAll(() => {
    prevSecret = process.env.ACCESS_TOKEN_SECRET;
    process.env.ACCESS_TOKEN_SECRET = SECRET;
  });

  afterAll(() => {
    if (prevSecret === undefined) {
      delete process.env.ACCESS_TOKEN_SECRET;
    } else {
      process.env.ACCESS_TOKEN_SECRET = prevSecret;
    }
  });

  it('prefers the authenticated session user and ignores the media token', () => {
    const mt = signMediaToken(FILE_A, 'attacker');
    const req = makeMediaReq({ mt }, FILE_A, { _id: 'session-owner' });
    expect(getMediaViewerUserId(req)).toBe('session-owner');
  });

  it('resolves the viewer from a valid scoped media token bound to this asset', () => {
    const mt = signMediaToken(FILE_A, OWNER);
    expect(getMediaViewerUserId(makeMediaReq({ mt }, FILE_A))).toBe(OWNER);
  });

  it('returns undefined for a media token minted for a DIFFERENT asset', () => {
    // Token authorizes FILE_B; the request is for FILE_A → must not resolve.
    const mt = signMediaToken(FILE_B, OWNER);
    expect(getMediaViewerUserId(makeMediaReq({ mt }, FILE_A))).toBeUndefined();
  });

  it('returns undefined for an access/session JWT presented in ?mt= (wrong token family)', () => {
    // An access-token-shaped JWT signed with ACCESS_TOKEN_SECRET does NOT verify
    // under the derived media key, so it can never act as a media credential.
    const accessLike = jwt.sign(
      { type: 'access', sessionId: 's1', userId: OWNER },
      SECRET,
      { expiresIn: 3600 },
    );
    expect(getMediaViewerUserId(makeMediaReq({ mt: accessLike }, FILE_A))).toBeUndefined();
  });

  it('returns undefined for an expired media token', () => {
    // Mint a real token, then advance the clock past its 10-minute TTL so
    // `jwt.verify`'s expiry check rejects it — no reaching into the private key
    // derivation.
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const mt = signMediaToken(FILE_A, OWNER);
      jest.setSystemTime(new Date('2026-01-01T00:20:00Z'));
      expect(getMediaViewerUserId(makeMediaReq({ mt }, FILE_A))).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns undefined for a garbage / malformed token', () => {
    expect(getMediaViewerUserId(makeMediaReq({ mt: 'not-a-jwt' }, FILE_A))).toBeUndefined();
  });

  it('returns undefined when neither a media token nor a session user is present', () => {
    expect(getMediaViewerUserId(makeMediaReq({}, FILE_A))).toBeUndefined();
  });

  it('returns undefined when the route has no file id param', () => {
    const mt = signMediaToken(FILE_A, OWNER);
    const req = { headers: {}, query: { mt }, params: {} } as unknown as OptionalUserOrServiceRequest;
    expect(getMediaViewerUserId(req)).toBeUndefined();
  });

  it('returns undefined when ACCESS_TOKEN_SECRET is not configured', () => {
    const mt = signMediaToken(FILE_A, OWNER);
    delete process.env.ACCESS_TOKEN_SECRET;
    expect(getMediaViewerUserId(makeMediaReq({ mt }, FILE_A))).toBeUndefined();
    process.env.ACCESS_TOKEN_SECRET = SECRET;
  });
});
