import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import express from 'express';
import rateLimit from 'express-rate-limit';
import httpRequest from 'supertest';
import { optionalAuthMiddleware } from '../../middleware/optionalAuth';
import profilesRouter from '../../routes/profiles';
import usersRouter from '../../routes/users';
import searchRouter from '../../routes/search';
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../server', () => ({ emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));
jest.mock('../securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn() },
}));
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users, sessions, accountMembers } from '../../db/schema';
import { accountService } from '../account.service';
import sessionService from '../session.service';
import { inviteGuardian, acceptInvitation } from '../supervision.service';
import sessionCache from '../../utils/sessionCache';
import { SessionController } from '../../controllers/session.controller';
const request = (): Request =>
  ({
    headers: { 'user-agent': 'Safety test' },
    ip: '127.0.0.1',
    get: () => undefined,
  }) as unknown as Request;
async function person() {
  const [row] = await getDb()
    .insert(users)
    .values({ kind: 'personal' })
    .returning({ id: users.id });
  return row.id;
}
beforeAll(async () => {
  await connectPostgres();
  process.env.DEVICE_ID_SALT = 's'.repeat(48);
});
afterAll(closePostgres);
it('requires actual bearer signatures and invalidates warmed pre-enrollment sessions', async () => {
  const child = await person(),
    guardian = await person();
  const before = await sessionService.createSession(child, request(), { deviceId: randomUUID() });
  expect(await sessionService.validateSession(before.accessToken)).not.toBeNull();
  const forged = before.accessToken.slice(0, -12) + 'forged-proof';
  expect(
    await sessionService.validateSession(forged, { allowSupervisedPolicyEvaluation: true }),
  ).toBeNull();
  const invitation = await inviteGuardian(child, guardian);
  await acceptInvitation(invitation.id, guardian);
  expect(
    await sessionService.validateSession(before.accessToken, {
      allowSupervisedPolicyEvaluation: true,
    }),
  ).toBeNull();
  const current = await sessionService.createSession(child, request(), { deviceId: randomUUID() });
  expect(await sessionService.validateSession(current.accessToken)).toBeNull();
  expect(
    await sessionService.validateSession(current.accessToken, {
      allowSupervisedPolicyEvaluation: true,
    }),
  ).not.toBeNull();
  await getDb()
    .update(sessions)
    .set({ isActive: false })
    .where(eq(sessions.sessionId, current.sessionId));
  // Even a primed in-process session cache cannot override the live supervised session row.
  expect(
    await sessionService.validateSession(current.accessToken, {
      allowSupervisedPolicyEvaluation: true,
    }),
  ).toBeNull();
  sessionCache.clear();
});
it('header validation refuses an invented bearer with a real adult session ID', async () => {
  const adult = await person();
  const session = await sessionService.createSession(adult, request(), { deviceId: randomUUID() });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const req = {
    ...request(),
    params: { sessionId: session.sessionId },
    headers: { authorization: 'Bearer forged' },
    header: () => undefined,
  };
  await SessionController.validateSessionFromHeader(req as unknown as Request, res as never);
  expect(res.status).toHaveBeenCalledWith(401);
  const valid = { ...req, headers: { authorization: `Bearer ${session.accessToken}` } };
  res.status.mockClear();
  res.json.mockClear();
  await SessionController.validateSessionFromHeader(valid as unknown as Request, res as never);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ valid: true }));
});

it('keeps absent-header adult validation but never falls back from supplied invalid authorization', async () => {
  const adult = await person(),
    child = await person(),
    guardian = await person();
  const invitation = await inviteGuardian(child, guardian);
  await acceptInvitation(invitation.id, guardian);
  const adultSession = await sessionService.createSession(adult, request(), {
    deviceId: randomUUID(),
  });
  const other = await sessionService.createSession(adult, request(), { deviceId: randomUUID() });
  const childSession = await sessionService.createSession(child, request(), {
    deviceId: randomUUID(),
  });
  const call = async (sessionId: string, authorization?: string) => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await SessionController.validateSessionFromHeader(
      {
        ...request(),
        params: { sessionId },
        headers: authorization === undefined ? {} : { authorization },
        header: () => undefined,
      } as unknown as Request,
      res as never,
    );
    return res;
  };
  expect((await call(adultSession.sessionId)).json).toHaveBeenCalledWith(
    expect.objectContaining({ valid: true }),
  );
  for (const invalid of ['Basic xyz', 'Bearer ', 'Bearer invented', `Bearer ${other.accessToken}`])
    expect((await call(adultSession.sessionId, invalid)).status).toHaveBeenCalledWith(401);
  expect((await call(childSession.sessionId)).status).toHaveBeenCalledWith(403);
  expect(
    (await call(childSession.sessionId, `Bearer ${childSession.accessToken}`)).status,
  ).toHaveBeenCalledWith(403);
});

it('optional profile reads never downgrade supervised, invalid or unverifiable bearers to anonymous', async () => {
  const adult = await person(),
    child = await person(),
    guardian = await person();
  const invitation = await inviteGuardian(child, guardian);
  await acceptInvitation(invitation.id, guardian);
  const adultSession = await sessionService.createSession(adult, request(), {
    deviceId: randomUUID(),
  });
  const childSession = await sessionService.createSession(child, request(), {
    deviceId: randomUUID(),
  });
  const app = express();
  // Bound synthetic loopback requests before auth, without storing IPs.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 128,
      keyGenerator: () => 'synthetic-supervision-fixture',
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.get('/profile', optionalAuthMiddleware, (_req, res) => res.json({ bio: 'public content' }));
  expect((await httpRequest(app).get('/profile')).status).toBe(200);
  expect(
    (
      await httpRequest(app)
        .get('/profile')
        .set('Authorization', `Bearer ${adultSession.accessToken}`)
    ).status,
  ).toBe(200);
  for (const invalid of ['Bearer fabricated', 'Basic abc', 'Bearer '])
    expect((await httpRequest(app).get('/profile').set('Authorization', invalid)).status).toBe(401);
  const denied = await httpRequest(app)
    .get('/profile')
    .set('Authorization', `Bearer ${childSession.accessToken}`);
  expect(denied.status).toBe(403);
  expect(denied.body.bio).toBeUndefined();
  const unavailable = jest
    .spyOn(sessionService, 'validateSession')
    .mockRejectedValueOnce(new Error('database unavailable'));
  expect(
    (
      await httpRequest(app)
        .get('/profile')
        .set('Authorization', `Bearer ${adultSession.accessToken}`)
    ).status,
  ).toBe(503);
  unavailable.mockRestore();
});

it('denies full generic profile and search DTOs before route hydration for a supervised bearer', async () => {
  const child = await person(),
    guardian = await person();
  const invitation = await inviteGuardian(child, guardian);
  await acceptInvitation(invitation.id, guardian);
  const session = await sessionService.createSession(child, request(), { deviceId: randomUUID() });
  const app = express();
  app.use(express.json());
  app.use('/profiles', profilesRouter);
  app.use('/users', usersRouter);
  app.use('/search', searchRouter);
  for (const path of [
    '/profiles/username/knownhandle',
    '/profiles/search?query=knownhandle',
    `/users/${guardian}`,
    '/search?query=knownhandle',
  ]) {
    const res = await httpRequest(app)
      .get(path)
      .set('Authorization', `Bearer ${session.accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.bio).toBeUndefined();
  }
  expect(
    (
      await httpRequest(app)
        .post('/users/search')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ query: 'knownhandle' })
    ).status,
  ).toBe(403);
});

it.each(['restricted', 'archived'] as const)(
  'does not reuse a warmed active child profile when live authority becomes %s',
  async (state) => {
    const child = await person(),
      guardian = await person();
    await acceptInvitation((await inviteGuardian(child, guardian)).id, guardian);
    const current = await sessionService.createSession(child, request(), {
      deviceId: randomUUID(),
    });
    expect(
      await sessionService.validateSession(current.accessToken, {
        allowSupervisedPolicyEvaluation: true,
      }),
    ).not.toBeNull();
    await getDb()
      .update(users)
      .set(
        state === 'restricted' ? { reputationTier: 'restricted' } : { accountStatus: 'archived' },
      )
      .where(eq(users.id, child));
    expect(
      await sessionService.validateSession(current.accessToken, {
        allowSupervisedPolicyEvaluation: true,
      }),
    ).toBeNull();
  },
);
it('checks a hundred original socket proofs with bounded live queries and never carries revocation to the next request', async () => {
  const adult = await person();
  const current = await sessionService.createSession(adult, request(), { deviceId: randomUUID() });
  const proofs = Array.from({ length: 100 }, () => current.accessToken);
  const select = jest.spyOn(getDb(), 'select');
  try {
    const result = await sessionService.validateSessionProofs(proofs);
    expect(result.every((item) => item?.session.userId === adult)).toBe(true);
    expect(select.mock.calls.length).toBeLessThanOrEqual(3);
    expect(select.mock.calls.length).toBeGreaterThan(0);
  } finally {
    select.mockRestore();
  }
  await getDb()
    .update(sessions)
    .set({ isActive: false })
    .where(eq(sessions.sessionId, current.sessionId));
  expect((await sessionService.validateSessionProofs(proofs)).every((item) => item === null)).toBe(
    true,
  );
});
it('rejects expired, forged, disabled and pre-enrollment socket proofs without denying other valid proofs', async () => {
  const adult = await person(),
    child = await person(),
    guardian = await person();
  const a = await sessionService.createSession(adult, request(), { deviceId: randomUUID() });
  const c = await sessionService.createSession(child, request(), { deviceId: randomUUID() });
  const secret = process.env.ACCESS_TOKEN_SECRET;
  if (!secret) throw new Error('Missing test signing secret');
  const decoded = jwt.decode(a.accessToken);
  if (!decoded || typeof decoded === 'string') throw new Error('Invalid fixture JWT');
  const expired = jwt.sign({ ...decoded, exp: Math.floor(Date.now() / 1000) - 1 }, secret);
  expect(
    (await sessionService.validateSessionProofs([expired, 'malformed', a.accessToken])).map(
      Boolean,
    ),
  ).toEqual([false, false, true]);
  expect((await sessionService.validateSessionProofs([c.accessToken]))[0]?.supervised).toBe(false);
  await acceptInvitation((await inviteGuardian(child, guardian)).id, guardian);
  expect((await sessionService.validateSessionProofs([c.accessToken]))[0]).toBeNull();
  const fresh = await sessionService.createSession(child, request(), { deviceId: randomUUID() });
  expect((await sessionService.validateSessionProofs([fresh.accessToken]))[0]?.supervised).toBe(
    true,
  );
  await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, adult));
  expect(
    (await sessionService.validateSessionProofs([a.accessToken, fresh.accessToken])).map(Boolean),
  ).toEqual([false, true]);
});

it('keeps live ordinary organization actors valid and rechecks revoked act-as authority for socket proofs', async () => {
  const operator = await person();
  const { account } = await accountService.createChildAccount(operator, operator, {
    kind: 'organization',
    username: `receiver${randomUUID().replaceAll('-', '').slice(0, 14)}`,
  });
  const current = await sessionService.createSession(account.id, request(), {
    deviceId: randomUUID(),
    operatedByUserId: operator,
  });
  expect(
    (await sessionService.validateSessionProofs([current.accessToken]))[0]?.session.userId,
  ).toBe(account.id);
  await getDb()
    .update(accountMembers)
    .set({ permissionRevokes: ['account:act_as'] })
    .where(
      and(eq(accountMembers.accountId, account.id), eq(accountMembers.memberUserId, operator)),
    );
  expect((await sessionService.validateSessionProofs([current.accessToken]))[0]).toBeNull();
});
