/**
 * A device sign-in (the Commons QR, `POST /auth/session/create` without an
 * OAuth binding) is an official Oxy application's only, end to end over HTTP,
 * the REAL `authMiddleware`, `session.service`, device lane and Postgres.
 *
 * The defect this pins: a third-party application could start a device sign-in
 * by client id, have it approved, and claim a SHARED session (no application
 * binding) plus a device restore secret. That session passed
 * `requireFirstPartyDeviceAccess`, so the third party could replace or delete
 * the person's identity backup, read key history, and reach every other route
 * gated only by it.
 *
 * What is pinned:
 *  - an official application's QR still signs in, and its session still writes
 *    the backup (and the write is on the account's security trail);
 *  - a third party cannot start one (403 `third_party_device_sign_in_denied`),
 *    and a request made before that refusal is never approved;
 *  - an application demoted between approval and claim gets nothing, and the
 *    session the approval minted is ended;
 *  - a third party's OAuth bearer is still refused the backup's writes and
 *    `POST /accounts/:id/switch` (which mints a shared session), and the
 *    refused attempt is in the audit log.
 *
 * Only the edges are mocked: Redis limiters, Socket.IO, the CSRF origin check,
 * the logger (asserted on for the audit line).
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

jest.mock('../../middleware/originGuard', () => ({
  requireSameSiteOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  ...jest.requireActual('../../middleware/rateLimiter'),
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: jest.fn(),
  emitAuthSessionProgress: jest.fn(),
}));
// `session.controller` reaches `server.ts`, whose route table needs this
// module back mid-import; the key sign-in it serves is not the subject here.
jest.mock('../../controllers/session.controller', () => ({
  SessionController: {
    register: jest.fn(),
    requestChallenge: jest.fn(),
    verifyChallenge: jest.fn(),
    getUserByPublicKey: jest.fn(),
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { and, eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { authSessions } from '../../db/schema/authSessions';
import { securityActivities } from '../../db/schema/securityActivities';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import sessionService from '../../services/session.service';
import { logger } from '../../utils/logger';
import sessionCache from '../../utils/sessionCache';
import userCache from '../../utils/userCache';
import accountsRouter from '../accounts';
import authRouter from '../auth';
import identityBackupRouter from '../identityBackup';

let server: http.Server;

type AppFields = Partial<typeof applications.$inferInsert>;

const OFFICIAL: AppFields = { type: 'first_party', isOfficial: true };
const THIRD_PARTY: AppFields = { type: 'third_party' };

async function account(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${randomUUID().slice(0, 12)}` })
    .returning({ id: users.id });
  return row.id;
}

async function application(
  fields: AppFields,
): Promise<{ applicationId: string; clientId: string }> {
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      redirectUris: ['https://example.test/cb'],
      ...fields,
      ownerAccountId: await account(),
    })
    .returning({ id: applications.id });
  const clientId = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  await getDb().insert(applicationCredentials).values({
    applicationId: app.id,
    name: 'client',
    type: 'public',
    environment: 'production',
    publicKey: clientId,
  });
  return { applicationId: app.id, clientId };
}

/** A bearer for `userId`: the shared session, or `app`'s own (an OAuth one). */
async function bearer(
  userId: string,
  app?: { applicationId: string; clientId: string },
): Promise<string> {
  const session = await sessionService.createSession(
    userId,
    { headers: { 'user-agent': 'jest', 'accept-language': 'en-US' } } as never,
    {
      deviceId: `dev-${randomUUID()}`,
      ...(app
        ? { application: { applicationId: app.applicationId, clientId: app.clientId, scopes: [] } }
        : {}),
    },
  );
  const minted = await sessionService.getAccessToken(session.sessionId);
  if (!minted) throw new Error('no access token for the freshly created session');
  return minted.accessToken;
}

async function call(
  method: string,
  path: string,
  options: { bearer?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const address = server.address() as AddressInfo;
  const body = options.body === undefined ? '' : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'jest',
          ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
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
    if (body) req.write(body);
    req.end();
  });
}

const sessionToken = () => `at_${randomUUID().replace(/-/g, '')}`;

/** A pending device sign-in written straight to the table (what `/session/create` used to accept). */
async function legacyRequest(applicationId: string): Promise<string> {
  const token = sessionToken();
  await getDb()
    .insert(authSessions)
    .values({
      sessionToken: token,
      applicationId,
      authorizeCode: randomUUID().replace(/-/g, ''),
      status: 'pending',
      purpose: 'device_sign_in',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
  return token;
}

/** The audit line the backup's writes emit, once the answer has been sent. */
async function auditLine(
  level: 'info' | 'warn',
  match: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fn = logger[level] as jest.Mock;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = fn.mock.calls.find(
      ([message, fields]) =>
        message === 'identity.backup.write' &&
        Object.entries(match).every(
          ([key, value]) => (fields as Record<string, unknown>)[key] === value,
        ),
    );
    if (found) return found[1] as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no identity.backup.write ${level} line matching ${JSON.stringify(match)}`);
}

/**
 * The account's backup entries on its security trail. Written after the answer,
 * so waited for: until one appears, or (`settle`) for the time one would take.
 */
async function backupTrail(userId: string, options: { settle?: boolean } = {}) {
  const read = () =>
    getDb()
      .select({
        eventType: securityActivities.eventType,
        severity: securityActivities.severity,
        metadata: securityActivities.metadata,
      })
      .from(securityActivities)
      .where(
        and(
          eq(securityActivities.userId, userId),
          inArray(securityActivities.eventType, ['backup_created', 'security_settings_changed']),
        ),
      );
  if (options.settle) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return read();
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await read();
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return read();
}

beforeAll(async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use('/identity/backup', identityBackupRouter);
  app.use('/accounts', accountsRouter);
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
});

describe("an official application's QR sign-in still works", () => {
  it('creates, approves and claims a shared session that may write and delete the backup', async () => {
    const { clientId } = await application(OFFICIAL);
    const userId = await account();
    const token = sessionToken();

    const created = await call('POST', '/auth/session/create', {
      body: { sessionToken: token, clientId },
    });
    expect(created.status).toBe(200);

    const approved = await call('POST', `/auth/session/authorize/${token}`, {
      bearer: await bearer(userId),
    });
    expect(approved.status).toBe(200);

    const claimed = await call('POST', '/auth/session/claim', { body: { sessionToken: token } });
    expect(claimed.status).toBe(200);
    const data = claimed.body.data as {
      accessToken: string;
      sessionId: string;
      deviceSecret?: string;
    };
    expect(typeof data.deviceSecret).toBe('string');
    const [row] = await getDb()
      .select({ applicationId: sessions.applicationId })
      .from(sessions)
      .where(eq(sessions.sessionId, data.sessionId));
    // The shared device session: NULL is "an official app's device" because the
    // application that asked was official.
    expect(row.applicationId).toBeNull();

    const deleted = await call('DELETE', '/identity/backup', { bearer: data.accessToken });
    expect(deleted.status).toBe(200);

    // Audited: the log line names the session's lane, and the person's own
    // trail records the deletion.
    const line = await auditLine('info', { action: 'delete', outcome: 'written', userId });
    expect(line.applicationId).toBeNull();
    expect(JSON.stringify(line)).not.toContain(data.accessToken);
    const [activity] = await backupTrail(userId);
    expect(activity).toMatchObject({
      eventType: 'security_settings_changed',
      severity: 'high',
      metadata: { settingName: 'identity_backup', newValue: 'deleted' },
    });
  });
});

describe('a third-party application gets no device sign-in', () => {
  it('cannot start one, by client id or application id, from a browser or natively', async () => {
    const { applicationId, clientId } = await application(THIRD_PARTY);

    for (const body of [{ clientId }, { applicationId }]) {
      const token = sessionToken();
      const res = await call('POST', '/auth/session/create', {
        body: { sessionToken: token, ...body },
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'third_party_device_sign_in_denied' });
      const [row] = await getDb()
        .select({ id: authSessions.id })
        .from(authSessions)
        .where(eq(authSessions.sessionToken, token));
      expect(row).toBeUndefined();
    }
  });

  it('never gets a request made before the refusal approved, so there is nothing to claim', async () => {
    const { applicationId } = await application(THIRD_PARTY);
    const token = await legacyRequest(applicationId);

    const approved = await call('POST', `/auth/session/authorize/${token}`, {
      bearer: await bearer(await account()),
    });
    expect(approved.status).toBe(403);
    expect(approved.body).toMatchObject({ error: 'third_party_device_sign_in_denied' });

    const claimed = await call('POST', '/auth/session/claim', { body: { sessionToken: token } });
    expect(claimed.status).toBe(401);
    expect(claimed.body).not.toHaveProperty('data');
  });

  it('gets nothing at the claim when its application stopped being official after approval', async () => {
    const { applicationId, clientId } = await application(OFFICIAL);
    const token = sessionToken();
    expect(
      (await call('POST', '/auth/session/create', { body: { sessionToken: token, clientId } }))
        .status,
    ).toBe(200);
    expect(
      (
        await call('POST', `/auth/session/authorize/${token}`, {
          bearer: await bearer(await account()),
        })
      ).status,
    ).toBe(200);
    const [approvedRow] = await getDb()
      .select({ authorizedSessionId: authSessions.authorizedSessionId })
      .from(authSessions)
      .where(eq(authSessions.sessionToken, token));

    await getDb()
      .update(applications)
      .set({ type: 'third_party', isOfficial: false })
      .where(eq(applications.id, applicationId));

    const claimed = await call('POST', '/auth/session/claim', { body: { sessionToken: token } });
    expect(claimed.status).toBe(401);
    expect(claimed.body).not.toHaveProperty('data');
    const [minted] = await getDb()
      .select({ isActive: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.sessionId, approvedRow.authorizedSessionId as string));
    expect(minted.isActive).toBe(false);
  });
});

describe("a third party's OAuth bearer (regression)", () => {
  it('is refused both backup writes, and the refused attempts are audited', async () => {
    const userId = await account();
    const app = await application(THIRD_PARTY);
    const oauthBearer = await bearer(userId, app);

    const deleted = await call('DELETE', '/identity/backup', { bearer: oauthBearer });
    expect(deleted.status).toBe(403);
    expect(deleted.body).toEqual({ error: 'third_party_device_access_denied' });
    const uploaded = await call('POST', '/identity/backup', { bearer: oauthBearer, body: {} });
    expect(uploaded.status).toBe(403);
    expect(uploaded.body).toEqual({ error: 'third_party_device_access_denied' });

    for (const action of ['delete', 'upload']) {
      const line = await auditLine('warn', { action, outcome: 'refused', userId });
      expect(line.applicationId).toBe(app.applicationId);
      expect(line.status).toBe(403);
    }
    // Nothing was written, so nothing is on the person's trail.
    expect(await backupTrail(userId, { settle: true })).toHaveLength(0);
  });

  it('cannot switch into an account, which would mint a shared session', async () => {
    const app = await application(THIRD_PARTY);
    const oauthBearer = await bearer(await account(), app);

    const res = await call('POST', `/accounts/${await account()}/switch`, { bearer: oauthBearer });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'third_party_device_access_denied' });
  });

  it("leaves the shared session's switch to its own authorization", async () => {
    // Positive control for the guard above: a shared bearer is past it and is
    // answered by the act_as check instead (it holds none over this account).
    const res = await call('POST', `/accounts/${await account()}/switch`, {
      bearer: await bearer(await account()),
    });

    expect(res.status).toBe(403);
    expect(res.body).not.toEqual({ error: 'third_party_device_access_denied' });
  });
});
