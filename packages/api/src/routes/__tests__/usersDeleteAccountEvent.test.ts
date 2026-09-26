/**
 * `DELETE /users/me` tells relying parties (OxyHQ/Mention#1169), and
 * `GET /account-events` serves them the announcement — both through the real
 * routers and a REAL Postgres.
 *
 * Stubbed: the session/signature proof (authMiddleware, SignatureService), and
 * the destructive side systems the route calls before the final delete (email,
 * sessions, device sessions, the social-graph purge, caches). Those have their
 * own tests; what is under test here is that the deletion's own transaction
 * writes the event, and that a refused deletion writes none.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

let currentUserId: string | undefined;
let currentServiceAppId: string | undefined;
let signatureValid = true;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    if (currentUserId) req.user = { id: currentUserId };
    next();
  },
  serviceAuthMiddleware: (req: { serviceApp?: { appId: string } }, _res: unknown, next: () => void) => {
    if (currentServiceAppId) req.serviceApp = { appId: currentServiceAppId };
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/signature.service', () => ({
  __esModule: true,
  default: {
    verifySignature: () => signatureValid,
    isTimestampFresh: () => true,
  },
}));
jest.mock('../../services/email.service', () => ({
  emailService: { deleteAllUserData: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { deactivateAllUserSessions: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/deviceSession.service', () => ({
  __esModule: true,
  default: { purgeAccountFromAllDevices: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/user.service', () => ({
  userService: { purgeUserSocialGraph: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/federation.service', () => ({
  federationService: { scheduleAvatarRefresh: jest.fn() },
  isOwnFederationDomain: jest.fn(),
}));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { ensureOwnedAssetPublic: jest.fn().mockResolvedValue(undefined) },
  s3Service: {},
}));
jest.mock('../../utils/graphCache', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), invalidate: jest.fn() },
}));
jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: jest.fn() },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountEventDeliveries, accountEvents } from '../../db/schema/accountEvents';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { wallets } from '../../db/schema/wallets';
import { errorHandler } from '../../middleware/errorHandler';
import { ACCOUNT_EVENT_FEED_SETTLE_MS } from '../../services/accountEvents.service';
import accountEventRoutes from '../accountEvents';
import usersRouter from '../users';

jest.setTimeout(60_000);

const signingKey = generateKeyPairSync('ed25519');
const savedEnv = { ...process.env };
let server: http.Server;

beforeAll(async () => {
  process.env.SERVICE_TOKEN_SIGNING_KEY_ID = 'users-delete-test';
  process.env.SERVICE_TOKEN_PRIVATE_KEY = signingKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  delete process.env.SERVICE_TOKEN_PUBLIC_JWKS;
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  app.use('/account-events', accountEventRoutes);
  app.use(errorHandler);
  server = app.listen(0);
});

afterAll(async () => {
  process.env = savedEnv;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

interface CallResult {
  status: number;
  body: {
    data: {
      retained?: boolean;
      events: Array<{ eventId: string; userId: string; username: string | null; type: string; token: string }>;
    };
  };
}

async function call(method: string, path: string, body?: unknown): Promise<CallResult> {
  const address = server.address() as AddressInfo;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : undefined }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb()
    .insert(users)
    .values({ username: `rp-owner-${suffix}`, email: `rp-owner-${suffix}@example.test` })
    .returning({ id: users.id });
  const [person] = await getDb()
    .insert(users)
    .values({
      username: `leaving-${suffix}`,
      email: `leaving-${suffix}@example.test`,
      publicKey: `02${randomBytes(32).toString('hex')}`,
    })
    .returning({ id: users.id, username: users.username });
  const [mention] = await getDb()
    .insert(applications)
    .values({ name: `Mention ${suffix}`, ownerAccountId: owner.id, type: 'first_party' })
    .returning({ id: applications.id });
  return { person, mentionAppId: mention.id };
}

function deleteBody(username: string) {
  return { signature: 'ab'.repeat(64), timestamp: Date.now(), confirmText: username };
}

describe('DELETE /users/me records an account.deleted event', () => {
  beforeEach(() => {
    signatureValid = true;
    currentServiceAppId = undefined;
  });

  it('deletes the account and, in the same commit, announces it to the relying parties', async () => {
    const { person, mentionAppId } = await seed();
    currentUserId = person.id;

    const response = await call('DELETE', '/users/me', deleteBody(person.username!));
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ retained: false });

    expect(await getDb().select({ id: users.id }).from(users).where(eq(users.id, person.id))).toHaveLength(0);
    const events = await getDb().select().from(accountEvents).where(eq(accountEvents.userId, person.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'account.deleted', username: person.username, retained: false });
    const deliveries = await getDb()
      .select({ applicationId: accountEventDeliveries.applicationId })
      .from(accountEventDeliveries)
      .where(eq(accountEventDeliveries.eventId, events[0]!.id));
    expect(deliveries.map((row) => row.applicationId)).toContain(mentionAppId);

    // The relying party then reads it from its pull feed.
    currentServiceAppId = mentionAppId;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
    jest.setSystemTime(Date.now() + ACCOUNT_EVENT_FEED_SETTLE_MS + 1_000);
    try {
      const feed = await call('GET', '/account-events?limit=200');
      expect(feed.status).toBe(200);
      const ours = feed.body.data.events.filter((event) => event.userId === person.id);
      expect(ours).toHaveLength(1);
      expect(ours[0]).toMatchObject({ eventId: events[0]!.id, username: person.username, type: 'account.deleted' });
      expect(typeof ours[0]!.token).toBe('string');
    } finally {
      jest.useRealTimers();
    }
  });

  it('announces nothing when the deletion is refused', async () => {
    const { person } = await seed();
    currentUserId = person.id;
    signatureValid = false;

    const response = await call('DELETE', '/users/me', deleteBody(person.username!));
    expect(response.status).toBe(401);
    expect(await getDb().select({ id: users.id }).from(users).where(eq(users.id, person.id))).toHaveLength(1);
    expect(await getDb().select().from(accountEvents).where(eq(accountEvents.userId, person.id))).toHaveLength(0);
  });
});

describe('DELETE /users/me and a wallet', () => {
  beforeEach(() => {
    signatureValid = true;
    currentServiceAppId = undefined;
  });

  it('deletes an account whose wallet is empty and never used — the wallet goes with it', async () => {
    const { person } = await seed();
    currentUserId = person.id;
    const [wallet] = await getDb().insert(wallets).values({ userId: person.id }).returning({ id: wallets.id });

    const response = await call('DELETE', '/users/me', deleteBody(person.username!));
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ retained: false });
    expect(await getDb().select({ id: users.id }).from(users).where(eq(users.id, person.id))).toHaveLength(0);
    expect(await getDb().select({ id: wallets.id }).from(wallets).where(eq(wallets.id, wallet.id))).toHaveLength(0);
  });

  it('archives, as before, an account whose wallet holds a balance — the wallet is kept', async () => {
    const { person } = await seed();
    currentUserId = person.id;
    const [wallet] = await getDb().insert(wallets).values({ userId: person.id, balance: '1.5' }).returning({ id: wallets.id });

    const response = await call('DELETE', '/users/me', deleteBody(person.username!));
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ retained: true });
    const [row] = await getDb().select({ status: users.accountStatus }).from(users).where(eq(users.id, person.id));
    expect(row).toEqual({ status: 'archived' });
    expect(await getDb().select({ id: wallets.id }).from(wallets).where(eq(wallets.id, wallet.id))).toHaveLength(1);
  });
});

describe('GET /account-events', () => {
  it('refuses a caller without a service token', async () => {
    currentServiceAppId = undefined;
    const response = await call('GET', '/account-events');
    expect(response.status).toBe(401);
  });

  it('rejects an out-of-range limit', async () => {
    currentServiceAppId = 'some-app';
    const response = await call('GET', '/account-events?limit=5000');
    expect(response.status).toBe(400);
  });
});
