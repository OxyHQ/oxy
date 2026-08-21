/**
 * The device flow END TO END — approve then claim — over the REAL
 * `session.service`, against a real Postgres.
 *
 * `sessionAuthorize.test.ts` and `sessionClaim.test.ts` each mock
 * `session.service`, which is correct for what they pin (the auth_sessions row
 * transitions, the single-use claim) and is exactly why neither could see this:
 * the failure lives in what the approve route's mint does to the session it
 * REUSES, and in what the claim then reads back out of it. So this suite mocks
 * the transport around the flow and nothing inside it.
 *
 * The shape it reproduces is a sign-in on a device the user is already signed
 * in on — the common case, not a corner. `POST /auth/session/authorize` mints
 * with a deviceId and a label and nothing else, the reuse lookup finds the
 * device's own session, and that session was bound to a device context by the
 * login lane after it was created.
 */

import express from 'express';
import type { Request } from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

/*
 * `jest.setup.cjs` mocks `jsonwebtoken` to a constant string. The whole subject
 * here is which CLAIMS the minted token carries and whether they still describe
 * the row, and `sessions.access_token` / `refresh_token` are UNIQUE, so the real
 * signer is a prerequisite rather than a preference.
 */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

const mockLogDeviceAdded = jest.fn();
const mockVerifyActingAs = jest.fn();

let authenticatedUser: { _id: string; username?: string; publicKey?: string } | null = null;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: unknown },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (!authenticatedUser) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = authenticatedUser;
    next();
  },
  serviceAuthMiddleware: jest.fn(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/account.service', () => ({
  __esModule: true,
  accountService: { verifyActingAs: (...args: unknown[]) => mockVerifyActingAs(...args) },
  default: { verifyActingAs: (...args: unknown[]) => mockVerifyActingAs(...args) },
}));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: (...args: unknown[]) => mockLogDeviceAdded(...args) },
}));
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: jest.fn(),
  emitAuthSessionProgress: jest.fn(),
}));
jest.mock('../../utils/socket', () => ({
  broadcastSessionAccountsChanged: jest.fn(),
  broadcastDeviceState: jest.fn(),
}));
jest.mock('../../controllers/session.controller', () => ({
  SessionController: {
    register: jest.fn(),
    requestChallenge: jest.fn(),
    verifyChallenge: jest.fn(),
    getUserByPublicKey: jest.fn(),
  },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { authSessions } from '../../db/schema/authSessions';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import sessionCache from '../../utils/sessionCache';
import userCache from '../../utils/userCache';
import deviceSessionService from '../../services/deviceSession.service';
import sessionService from '../../services/session.service';
import authRouter from '../auth';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;

function post(path: string, body: unknown = {}): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * A user already signed in on `device`, with the device context the login lane
 * writes AFTER the session exists — which is the state every second sign-in on
 * a device starts from.
 */
async function signedInOnDevice(): Promise<{ userId: string; deviceId: string; sessionId: string }> {
  const [user] = await getDb()
    .insert(users)
    .values({ username: `u${randomUUID().replace(/-/g, '').slice(0, 20)}` })
    .returning({ id: users.id });
  const deviceId = `dev-${randomUUID()}`;
  const session = await sessionService.createSession(
    user.id,
    { headers: { 'user-agent': 'Chrome/120.0', 'accept-language': 'en-US' } } as unknown as Request,
    { deviceId },
  );
  await deviceSessionService.addAccount(deviceId, {
    accountId: user.id,
    sessionId: session.sessionId,
  });
  await deviceSessionService.bindSessionToContext(deviceId, session.sessionId);
  return { userId: user.id, deviceId, sessionId: session.sessionId };
}

/** A pending device-flow request bound to `deviceId`, as `/session/create` writes it. */
async function pendingRequest(deviceId: string): Promise<string> {
  const [owner] = await getDb()
    .insert(users)
    .values({ username: `o${randomUUID().replace(/-/g, '').slice(0, 20)}` })
    .returning({ id: users.id });
  const [app] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID()}`, ownerAccountId: owner.id })
    .returning({ id: applications.id });
  const sessionToken = `at_${randomUUID().replace(/-/g, '')}`;
  await getDb().insert(authSessions).values({
    sessionToken,
    authorizeCode: randomUUID().replace(/-/g, ''),
    applicationId: app.id,
    deviceId,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    status: 'pending',
  });
  return sessionToken;
}

beforeAll(async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionCache.clear();
  userCache.clear();
  authenticatedUser = null;
  mockVerifyActingAs.mockResolvedValue('admin');
  mockLogDeviceAdded.mockResolvedValue(undefined);
});

describe('approve then claim, on a device that is already signed in', () => {
  it('claims the approved session and hands back a token that authenticates', async () => {
    const { userId, deviceId, sessionId } = await signedInOnDevice();
    const boundBefore = (
      await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId)).limit(1)
    )[0];
    expect(boundBefore.deviceSessionId).not.toBeNull();

    authenticatedUser = { _id: userId, username: 'someone' };
    const sessionToken = await pendingRequest(deviceId);

    const approved = await post(`/auth/session/authorize/${sessionToken}`, {});
    expect(approved.status).toBe(200);
    // The approve reused the device's existing session, which is the whole
    // point: it is that session's binding the mint must not narrow.
    expect((approved.body.data as { sessionId?: string }).sessionId).toBe(sessionId);

    // The token the approve LEFT ON THE ROW has to still describe that row. It
    // is a shipped credential, not an intermediate: `buildSessionAuthResponse`
    // hands `session.accessToken` straight to the client on the webauthn and
    // public-key sign-in lanes, which reuse through this same branch.
    const [afterApprove] = await getDb()
      .select()
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .limit(1);
    expect(afterApprove.deviceSessionId).toBe(boundBefore.deviceSessionId);
    sessionCache.clear();
    expect(await sessionService.validateSession(afterApprove.accessToken)).not.toBeNull();

    const claimed = await post('/auth/session/claim', { sessionToken });
    expect(claimed.status).toBe(200);

    const { accessToken } = claimed.body.data as { accessToken?: string };
    expect(typeof accessToken).toBe('string');

    // The claimed token is what the client signs in with. A token that no
    // longer describes its own row is refused on the FIRST request it is used
    // for, which is how a "successful" sign-in became a signed-out app.
    sessionCache.clear();
    expect(await sessionService.validateSession(accessToken as string)).not.toBeNull();
  });

  it('claims even when the task serving it cached the session before the approve', async () => {
    // Each ECS task has its own `sessionCache` local tier and no invalidation
    // crosses between them, so the claim routinely lands on a process holding a
    // pre-approve copy of the row. Seeded here with an EXPIRED access token,
    // which is the state a cached copy reaches 15 minutes in.
    const { userId, deviceId, sessionId } = await signedInOnDevice();
    const [staleCopy] = await getDb()
      .select()
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .limit(1);

    authenticatedUser = { _id: userId, username: 'someone' };
    const sessionToken = await pendingRequest(deviceId);
    expect((await post(`/auth/session/authorize/${sessionToken}`, {})).status).toBe(200);

    const jwt = jest.requireActual<typeof import('jsonwebtoken')>('jsonwebtoken');
    const claims = jwt.decode(staleCopy.accessToken) as Record<string, unknown>;
    delete claims.iat;
    delete claims.exp;
    sessionCache.set(sessionId, {
      ...staleCopy,
      accessToken: jwt.sign(claims, process.env.ACCESS_TOKEN_SECRET as string, {
        expiresIn: '-1s',
      }),
    });

    const claimed = await post('/auth/session/claim', { sessionToken });
    expect(claimed.status).toBe(200);
  });
});
