/**
 * Approving a sign-in from an OPERATED session never drops the operator
 * (issue #1520, I01) — against a REAL Postgres, real `authMiddleware`, real
 * `session.service`.
 *
 * An operated session authenticates as the managed account (its SUBJECT) and
 * carries the human who operates it as `operatedByUserId`. Both bearer approval
 * routes — `POST /auth/session/authorize/:sessionToken` and
 * `POST /auth/session/authorize-code/:authorizeCode` — mint a session for the
 * approving SUBJECT. If that mint forgets the operator, the approval launders
 * an operated seat into an unoperated one:
 *
 *  - the actor chain then names the managed account as its own actor, hiding
 *    the person (for a bot: a human's actions recorded as the bot acting
 *    autonomously — the seat `isOperatorSwitchTargetKind` refuses a person);
 *  - the managed-session recheck (`ensureManagedSessionAuthorized`) only runs
 *    for operated sessions, so removing the person from the account no longer
 *    ends the session they minted.
 *
 * So: an organization/project approval keeps the operator on the minted
 * session, and a bot (or channel) — a seat no person may occupy — is refused.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: jest.fn(),
  emitAuthSessionProgress: jest.fn(),
}));
jest.mock('../../utils/socket', () => ({
  broadcastSessionAccountsChanged: jest.fn(),
}));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: {
    logDeviceAdded: jest.fn().mockResolvedValue(undefined),
    logSignIn: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { and, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { applications } from '../../db/schema/applications';
import { authSessions } from '../../db/schema/authSessions';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import sessionService from '../../services/session.service';
import sessionCache from '../../utils/sessionCache';
import userCache from '../../utils/userCache';
import authRouter from '../auth';

jest.setTimeout(60_000);

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;

function post(path: string, bearer: string): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const payload = JSON.stringify({});
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
          'user-agent': 'jest',
          authorization: `Bearer ${bearer}`,
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

async function account(over: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u${randomUUID().replace(/-/g, '').slice(0, 14)}`, ...over })
    .returning({ id: users.id });
  return row.id;
}

/** A managed account of `kind` under `ownerId`, hung the way `POST /accounts` hangs one. */
async function managed(kind: 'organization' | 'bot', ownerId: string): Promise<string> {
  const id = await account({ kind, parentAccountId: ownerId, rootAccountId: ownerId });
  await getDb().execute(
    sql`insert into user_ancestors (user_id, depth, ancestor_id) values (${id}, 0, ${ownerId})`,
  );
  await getDb()
    .insert(accountMembers)
    .values({ accountId: id, memberUserId: ownerId, role: 'owner', status: 'active' });
  return id;
}

/** An operated session: subject `subjectId`, operated by `operatorId` — what `/accounts/:id/switch` mints. */
async function operatedBearer(subjectId: string, operatorId: string): Promise<string> {
  const minted = await sessionService.createSession(
    subjectId,
    { headers: { 'user-agent': 'jest' } } as never,
    { deviceId: `dev-${randomUUID()}`, operatedByUserId: operatorId },
  );
  return minted.accessToken;
}

async function pendingSignIn(): Promise<{ sessionToken: string; authorizeCode: string }> {
  const ownerAccountId = await account();
  const [app] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID()}`, ownerAccountId })
    .returning({ id: applications.id });
  const sessionToken = `at_${randomUUID().replace(/-/g, '')}`;
  const authorizeCode = randomUUID().replace(/-/g, '');
  await getDb().insert(authSessions).values({
    sessionToken,
    authorizeCode,
    applicationId: app.id,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    status: 'pending',
  });
  return { sessionToken, authorizeCode };
}

async function stored(sessionToken: string) {
  const [row] = await getDb()
    .select()
    .from(authSessions)
    .where(eq(authSessions.sessionToken, sessionToken))
    .limit(1);
  return row;
}

async function mintedRow(sessionId: string) {
  const [row] = await getDb()
    .select({ userId: sessions.userId, operatedByUserId: sessions.operatedByUserId })
    .from(sessions)
    .where(eq(sessions.sessionId, sessionId))
    .limit(1);
  return row;
}

/** Every session row for `accountId` that nobody operates. */
async function unoperatedSessionsOf(accountId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, accountId), sql`${sessions.operatedByUserId} is null`));
  return rows.length;
}

beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET ??= `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET ??= `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT ??= 'x'.repeat(48);
  await connectPostgres();
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
  sessionCache.clear();
  userCache.clear();
});

const ROUTES = [
  ['POST /auth/session/authorize/:sessionToken', (r: { sessionToken: string }) => `/auth/session/authorize/${r.sessionToken}`],
  ['POST /auth/session/authorize-code/:authorizeCode', (r: { authorizeCode: string }) => `/auth/session/authorize-code/${r.authorizeCode}`],
] as const;

describe.each(ROUTES)('%s from an operated session', (_label, pathOf) => {
  it('still mints an unoperated session when a person approves for themself', async () => {
    const person = await account();
    const minted = await sessionService.createSession(
      person,
      { headers: { 'user-agent': 'jest' } } as never,
      { deviceId: `dev-${randomUUID()}` },
    );
    const request = await pendingSignIn();

    const res = await post(pathOf(request), minted.accessToken);

    expect(res.status).toBe(200);
    const row = await stored(request.sessionToken);
    expect(await mintedRow(row.authorizedSessionId as string)).toEqual({
      userId: person,
      operatedByUserId: null,
    });
  });

  it('keeps the person as the operator of a session minted for an organization', async () => {
    const person = await account();
    const org = await managed('organization', person);
    const bearer = await operatedBearer(org, person);
    const request = await pendingSignIn();

    const res = await post(pathOf(request), bearer);

    expect(res.status).toBe(200);
    const row = await stored(request.sessionToken);
    expect(row.authorizedUserId).toBe(org);
    expect(row.authorizedSessionId).toBeTruthy();
    const minted = await mintedRow(row.authorizedSessionId as string);
    expect(minted).toEqual({ userId: org, operatedByUserId: person });
  });

  it('ends the minted organization session once the person loses the account', async () => {
    const founder = await account();
    const person = await account();
    const org = await managed('organization', founder);
    await getDb()
      .insert(accountMembers)
      .values({ accountId: org, memberUserId: person, role: 'admin', status: 'active' });
    const bearer = await operatedBearer(org, person);
    const request = await pendingSignIn();
    const res = await post(pathOf(request), bearer);
    expect(res.status).toBe(200);
    const minted = (await stored(request.sessionToken)).authorizedSessionId as string;

    await getDb()
      .delete(accountMembers)
      .where(and(eq(accountMembers.accountId, org), eq(accountMembers.memberUserId, person)));
    sessionCache.clear();

    expect(
      await sessionService.validateSessionById(minted, false, { useCache: false }),
    ).toBeNull();
  });

  it('refuses to mint a bot seat for the person operating the bot', async () => {
    const owner = await account();
    const bot = await managed('bot', owner);
    const bearer = await operatedBearer(bot, owner);
    const request = await pendingSignIn();
    const before = await unoperatedSessionsOf(bot);

    const res = await post(pathOf(request), bearer);

    expect(res.status).toBe(403);
    const row = await stored(request.sessionToken);
    expect(row.status).toBe('pending');
    expect(row.authorizedSessionId).toBeNull();
    expect(await unoperatedSessionsOf(bot)).toBe(before);
  });
});
