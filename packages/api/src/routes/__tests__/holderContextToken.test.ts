import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { deviceContextTokenV1ResponseSchema } from '@oxy.so/contracts';
import { deviceContextTokenV1ResponseCheck } from '@oxy.so/contracts/client';
import express, { type Request } from 'express';
import { eq } from 'drizzle-orm';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  ...jest.requireActual('../../middleware/rateLimiter'),
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/loginLockout.service', () => ({
  ...jest.requireActual('../../services/loginLockout.service'),
  reserveAttempt: jest.fn().mockResolvedValue({ locked: false, attempts: 1 }),
  clearFailures: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { insertAccountFixture } from '../../db/__fixtures__/accountIdentity';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { sessions } from '../../db/schema/sessions';
import { validateAccessToken } from '../../utils/sessionUtils';
import deviceSessionService from '../../services/deviceSession.service';
import sessionService from '../../services/session.service';
import { errorHandler } from '../../middleware/errorHandler';
import sessionDeviceRouter from '../sessionDevice';

const deviceRequest = {
  headers: {
    'user-agent': 'Mozilla/5.0 Chrome/120.0',
    'accept-language': 'en-US',
  },
} as unknown as Request;

let server: http.Server;
beforeAll(async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  const app = express();
  app.use(express.json());
  app.use('/session/device', sessionDeviceRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closePostgres();
});

it('mints a signed active-context token only to the holder and denies missing bindings', async () => {
  const deviceId = `dev-${randomUUID()}`;
  const actor = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
  const org = await insertAccountFixture({
    kind: 'organization',
    username: `o-${randomUUID().slice(0, 12)}`,
  });
  await getDb()
    .insert(accountMembers)
    .values({ accountId: org.id, memberUserId: actor.id, role: 'admin', status: 'active' });
  const personal = await sessionService.createSession(actor.id, deviceRequest, { deviceId });
  await deviceSessionService.addAccount(deviceId, {
    accountId: actor.id,
    sessionId: personal.sessionId,
  });
  const directory = await deviceSessionService.getDirectory(deviceId);
  const contextId = directory.principals
    .find((principal) => principal.userId === actor.id)
    ?.contexts.find((context) => context.accountId === org.id)?.id;
  if (!contextId) throw new Error('Expected organization context');
  const activation = await deviceSessionService.activateContext(deviceId, contextId, deviceRequest);
  if (!activation.ok) throw new Error('Expected successful activation');
  const holder = await deviceSessionService.issueDeviceSecret(deviceId);
  if (!holder) throw new Error('Expected holder secret');
  const address = server.address() as AddressInfo;
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/session/device/context-token-v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const wrong = await post({ deviceId, deviceSecret: `${holder}-wrong` });
  expect(wrong.status).toBe(401);
  expect(await wrong.json()).toEqual({ error: 'invalid_device_secret' });

  const success = await post({ deviceId, deviceSecret: holder });
  expect(success.status).toBe(200);
  expect(success.headers.get('cache-control')).toBe('no-store');
  const { data } = (await success.json()) as {
    data: {
      actorId: string;
      accountId: string;
      sessionId: string;
      contextId: string;
      accessToken: string;
    };
  };
  expect(deviceContextTokenV1ResponseSchema.safeParse(data).success).toBe(true);
  expect(deviceContextTokenV1ResponseCheck(data, []).ok).toBe(true);
  expect(data).toMatchObject({ actorId: actor.id, accountId: org.id, contextId });
  expect(validateAccessToken(data.accessToken).payload).toMatchObject({
    act: { sub: actor.id },
    sub: org.id,
    sid: data.sessionId,
    device_context_id: contextId,
  });
  await getDb()
    .update(sessions)
    .set({ deviceContextId: null })
    .where(eq(sessions.sessionId, data.sessionId));
  const missing = await post({ deviceId, deviceSecret: holder });
  expect(missing.status).toBe(409);
  expect(await missing.json()).toEqual({ error: 'binding_unavailable' });
  const pinned = await post({ deviceId, deviceSecret: holder, accountId: actor.id });
  expect(pinned.status).toBe(400);
});
