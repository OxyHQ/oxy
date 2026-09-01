/**
 * Closed-set denial reasons + rate limiting on
 * `POST /auth/session/deny/:authorizeCode` (issue #691).
 *
 * "This wasn't me" must be a RECORD, not just copy: the approver may attach a
 * reason from a closed set so a suspicious denial is distinguishable from an
 * ordinary cancel. The endpoint is UNAUTHENTICATED (the public approval handle
 * is the only credential), so:
 *
 *   - anything outside the closed set — including free-form text — is rejected
 *     at the edge and never reaches the document;
 *   - the route carries its own rate limiter with a UNIQUE prefix (a shared
 *     prefix makes `rate-limit-redis` double-count and halves the budget).
 *
 * Uses the REAL request validation, and a rate-limit factory mock that records
 * both the limiters the module CREATES and the ones a request actually RUNS
 * THROUGH, so "the limiter exists" and "the limiter is mounted" are both pinned.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockAuthSessionFindOne = jest.fn();
const mockEmitAuthSessionUpdate = jest.fn();
/** Every `rateLimit({...})` the auth router constructs, in module order. */
const mockCreatedLimiters: Array<{ prefix?: string }> = [];
/** Prefixes of the limiters the CURRENT request passed through. */
const mockLimiterHits: string[] = [];
const mockLoggerWarn = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  serviceAuthMiddleware: jest.fn(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: (options: { prefix?: string }) => {
    mockCreatedLimiters.push(options);
    return (_req: unknown, _res: unknown, next: () => void) => {
      mockLimiterHits.push(options.prefix ?? '<missing-prefix>');
      next();
    };
  },
}));
jest.mock('../../models/AuthSession', () => ({
  __esModule: true,
  default: { findOne: mockAuthSessionFindOne },
  AuthSession: { findOne: mockAuthSessionFindOne },
}));
jest.mock('../../models/Session', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../services/authSession.service', () => ({
  ...jest.requireActual('../../services/authSession.service'),
  claimAuthSession: jest.fn(),
  authorizeSessionWithSignedChallenge: jest.fn(),
}));
jest.mock('../../models/AuthCode', () => ({ __esModule: true, AuthCode: { create: jest.fn() }, default: { create: jest.fn() } }));
jest.mock('../../models/Application', () => ({ __esModule: true, Application: { findOne: jest.fn(), findById: jest.fn() }, default: { findOne: jest.fn(), findById: jest.fn() } }));
jest.mock('../../models/ApplicationCredential', () => ({ __esModule: true, ApplicationCredential: { findOne: jest.fn() }, default: { findOne: jest.fn() } }));
jest.mock('../../models/User', () => ({ __esModule: true, User: { findOne: jest.fn(), findById: jest.fn() }, default: { findOne: jest.fn(), findById: jest.fn() } }));
jest.mock('../../utils/userTransform', () => ({ formatUserResponse: jest.fn() }));
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: (...args: unknown[]) => mockEmitAuthSessionUpdate(...args),
  emitAuthSessionProgress: jest.fn(),
}));
jest.mock('../../services/session.service', () => ({ __esModule: true, default: { createSession: jest.fn() } }));
jest.mock('../../services/oauthCode.service', () => ({ issueAuthCode: jest.fn(), exchangeAuthCode: jest.fn(), AUTH_CODE_TTL_MS: 60_000 }));
jest.mock('../../services/signature.service', () => ({ __esModule: true, default: { verifyChallengeResponse: jest.fn(), isValidPublicKey: jest.fn() } }));
jest.mock('../../controllers/session.controller', () => ({
  SessionController: {
    register: jest.fn(), signUp: jest.fn(), signIn: jest.fn(), requestChallenge: jest.fn(),
    verifyChallenge: jest.fn(), requestPasswordReset: jest.fn(), verifyRecoveryCode: jest.fn(),
    resetPassword: jest.fn(), getUserByPublicKey: jest.fn(),
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../models/AppGrant', () => ({
  __esModule: true,
  AppGrant: { findOne: jest.fn(), find: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn() },
  default: { findOne: jest.fn(), find: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn() },
}));

import { COMMONS_DENY_REASONS } from '@oxyhq/contracts';
import authRouter from '../auth';
import { errorHandler } from '../../middleware/errorHandler';

const DENY_LIMITER_PREFIX = 'rl:auth:session-deny:';

interface JsonResponse {
  status: number;
  body: { data?: Record<string, unknown>; message?: string };
}

async function post(path: string, payload: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(payload ?? {});
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

interface PendingSessionDoc {
  sessionToken: string;
  status: string;
  deniedReason?: string;
  applicationId: { toString: () => string };
  save: jest.Mock;
}

function pendingSession(): PendingSessionDoc {
  return {
    sessionToken: 'secret-token',
    status: 'pending',
    applicationId: { toString: () => '64f7c2a1b8e9d3f4a1c2b301' },
    save: jest.fn().mockResolvedValue(undefined),
  };
}

let server: http.Server;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  mockLimiterHits.length = 0;
});

describe('POST /auth/session/deny/:authorizeCode — closed-set reason', () => {
  it('records a "not_me" denial on the session', async () => {
    const session = pendingSession();
    mockAuthSessionFindOne.mockResolvedValueOnce(session);

    const res = await post('/auth/session/deny/code-1', { reason: 'not_me' });

    expect(res.status).toBe(200);
    expect(session.status).toBe('cancelled');
    expect(session.deniedReason).toBe('not_me');
    expect(session.save).toHaveBeenCalledTimes(1);
  });

  it('records an ordinary "declined" denial distinctly from "not_me"', async () => {
    const session = pendingSession();
    mockAuthSessionFindOne.mockResolvedValueOnce(session);

    const res = await post('/auth/session/deny/code-1', { reason: 'declined' });

    expect(res.status).toBe(200);
    expect(session.deniedReason).toBe('declined');
    // Only the suspicious reason is surfaced for follow-up.
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('flags a "not_me" denial in the log without any identifying detail', async () => {
    mockAuthSessionFindOne.mockResolvedValueOnce(pendingSession());

    await post('/auth/session/deny/code-1', { reason: 'not_me' });

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const [, context] = mockLoggerWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(context).filter((key) => /ip|location|country|geo|userAgent/i.test(key)))
      .toEqual([]);
  });

  it('leaves the reason unset when none is given (unchanged legacy behaviour)', async () => {
    const session = pendingSession();
    mockAuthSessionFindOne.mockResolvedValueOnce(session);

    const res = await post('/auth/session/deny/code-1', {});

    expect(res.status).toBe(200);
    expect(session.status).toBe('cancelled');
    expect(session.deniedReason).toBeUndefined();
    expect(mockEmitAuthSessionUpdate).toHaveBeenCalledWith('secret-token', { status: 'cancelled' });
  });

  it.each([
    ['free-form text', 'the app looked phishy'],
    ['an out-of-set value', 'suspicious'],
    ['an empty string', ''],
    ['a non-string', 42],
    ['an object', { reason: 'not_me' }],
  ])('rejects %s with 400 and writes nothing', async (_label, reason) => {
    const session = pendingSession();
    mockAuthSessionFindOne.mockResolvedValue(session);

    const res = await post('/auth/session/deny/code-1', { reason });

    expect(res.status).toBe(400);
    expect(session.save).not.toHaveBeenCalled();
    expect(session.deniedReason).toBeUndefined();
    expect(session.status).toBe('pending');
    expect(mockEmitAuthSessionUpdate).not.toHaveBeenCalled();
  });

  it('accepts exactly the closed set and nothing else', async () => {
    // The route validates against the SHARED declaration in `@oxyhq/contracts` —
    // the same one the `AuthSession.deniedReason` enum and the SDK read. Pinning
    // the literal values here is what makes an accidental widening of the set
    // (on any of the three sides) fail loudly instead of silently.
    expect([...COMMONS_DENY_REASONS]).toEqual(['declined', 'not_me']);

    for (const reason of COMMONS_DENY_REASONS) {
      const session = pendingSession();
      mockAuthSessionFindOne.mockResolvedValueOnce(session);
      const res = await post('/auth/session/deny/code-1', { reason });
      expect(res.status).toBe(200);
      expect(session.deniedReason).toBe(reason);
    }
  });

  it('never broadcasts the reason back to the waiting relying party', async () => {
    mockAuthSessionFindOne.mockResolvedValueOnce(pendingSession());

    await post('/auth/session/deny/code-1', { reason: 'not_me' });

    expect(mockEmitAuthSessionUpdate).toHaveBeenCalledWith('secret-token', { status: 'cancelled' });
    expect(JSON.stringify(mockEmitAuthSessionUpdate.mock.calls)).not.toContain('not_me');
  });

  it('does not record a reason against an already-authorized session', async () => {
    const session = { ...pendingSession(), status: 'authorized' };
    mockAuthSessionFindOne.mockResolvedValueOnce(session);

    const res = await post('/auth/session/deny/code-1', { reason: 'not_me' });

    expect(res.status).toBe(200);
    expect(session.status).toBe('authorized');
    expect(session.deniedReason).toBeUndefined();
    expect(session.save).not.toHaveBeenCalled();
  });
});

describe('POST /auth/session/deny/:authorizeCode — rate limiting', () => {
  it('runs the request through a deny limiter (the route is actually mounted with one)', async () => {
    mockAuthSessionFindOne.mockResolvedValueOnce(pendingSession());

    await post('/auth/session/deny/code-1', { reason: 'declined' });

    expect(mockLimiterHits).toContain(DENY_LIMITER_PREFIX);
  });

  it('declares the deny limiter with a UNIQUE prefix (no rate-limit-redis double-count)', () => {
    const denyLimiters = mockCreatedLimiters.filter((options) => options.prefix === DENY_LIMITER_PREFIX);
    expect(denyLimiters).toHaveLength(1);

    const prefixes = mockCreatedLimiters.map((options) => options.prefix);
    expect(prefixes.every((prefix) => typeof prefix === 'string' && prefix.length > 0)).toBe(true);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
