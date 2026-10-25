/**
 * The session-revocation feed, end to end, over real sockets and real HTTP
 * against Postgres: a logout, a sign-out everywhere and a device removal each
 * announce on `/service-events`, and an Oxy backend's `OxyServer` — the real
 * `@oxy.so/core/server`, validating through the real `/session/validate-header`
 * route — stops serving its cached validation at once.
 *
 * Also the namespace's own gate: only a live own workload token is
 * admitted; no token, a user bearer, an external application's token and an
 * expired token are refused.
 *
 * Valkey is absent here (`REDIS_URL` unset), so announcements are delivered
 * in-process — the same `deliver` the Valkey subscriber calls on every task.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

jest.unmock('socket.io');
jest.unmock('socket.io-client');
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../middleware/originGuard', () => ({
  requireSameSiteOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/loginLockout.service', () => ({
  isLockedOut: jest.fn().mockResolvedValue({ locked: false, attempts: 0 }),
  reserveAttempt: jest.fn().mockResolvedValue({ locked: false, attempts: 1 }),
  recordFailure: jest.fn().mockResolvedValue({ locked: false, attempts: 1 }),
  clearFailures: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));
jest.mock('../../server', () => ({ emitSessionUpdate: jest.fn() }));
jest.mock('../../middleware/security', () => ({
  idpServiceLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  sessionHeaderValidationLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: {
    logDeviceAdded: jest.fn().mockResolvedValue(undefined),
    logSignOut: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  OXY_SERVICE_EVENTS_FORBIDDEN,
  OXY_SERVICE_EVENTS_HEARTBEAT_EVENT,
  OXY_SESSION_REVOKED_EVENT,
  type OxySessionRevocationEvent,
} from '@oxy.so/contracts';
import { OxyServer } from '@oxy.so/core/server';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import {
  applications,
  applicationCredentials,
  applicationWorkloadIdentities,
} from '../../db/schema';
import { bindWorkloadIdentity } from '../../services/workloadIdentityBinding.service';
import { createTestDatabase, dropTestDatabase } from '../../db/testDatabase';
import { LEGACY_WORKLOAD_BINDINGS } from '../../__fixtures__/retiredWorkloadCohort';
import { workloadAttestationHandle } from '../../services/workloadAttestation.service';
import { ensureWorkloadAttributionIdentity } from '../../services/workloadAttributionIdentity.service';
import { verifyServiceToken } from '../../middleware/serviceToken';
import { resolveLiveServiceTokenAuthority } from '../../services/liveServiceTokenAuthority.service';
import { errorHandler } from '../../middleware/errorHandler';
import sessionService from '../../services/session.service';
import sessionCache from '../../utils/sessionCache';
import { startServiceEvents } from '../../utils/serviceEvents';
import userCache from '../../utils/userCache';
import devicesRouter from '../devices';
import sessionRouter from '../session';

let server: http.Server;
let sockets: Server;
let feed: { stop: () => Promise<void> };
let baseURL: string;
let serviceOwner: string;
let serviceApp: string;
let serviceCredential: string;
let bindingId: string;
const originalDatabaseUrl = process.env.DATABASE_URL;
let databaseUrl: string;
jest.setTimeout(60_000);
const clients: ClientSocket[] = [];
const backends: OxyServer[] = [];

async function account(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${randomUUID().slice(0, 12)}` })
    .returning({ id: users.id });
  return row.id;
}

async function signIn(userId: string, deviceId = `fixture-device-${randomUUID()}`) {
  const created = await sessionService.createSession(
    userId,
    { headers: { 'user-agent': 'jest', 'accept-language': 'en-US' } } as never,
    { deviceId },
  );
  const minted = await sessionService.getAccessToken(created.sessionId);
  if (!minted) throw new Error('Fixture token mint failed');
  const [row] = await getDb()
    .select({ deviceId: sessions.deviceId })
    .from(sessions)
    .where(eq(sessions.sessionId, created.sessionId));
  return { sessionId: created.sessionId, bearer: minted.accessToken, deviceId: row.deviceId };
}

function serviceToken(
  options: {
    tier?: 'internal' | 'external';
    expiresIn?: number;
    owner?: string;
    credentialId?: string;
    legacy?: boolean;
    appId?: string;
  } = {},
): string {
  const now = Math.floor(Date.now() / 1_000);
  return signServiceTokenEd25519({
    type: 'service',
    appId: options.appId ?? serviceApp,
    appName: 'Feed test',
    credentialId: options.credentialId ?? serviceCredential,
    ownerAccountId: options.owner ?? serviceOwner,
    environment: 'development',
    tier: options.tier ?? 'internal',
    ...(options.legacy
      ? { scopes: [] }
      : options.tier === 'external'
        ? { authority: 'external', scopes: [] }
        : { authority: 'first_party' }),
    iss: 'oxy-auth',
    aud: 'oxy-api',
    // Service tokens live at most 300 s (`hasBoundedServiceTokenLifetime`).
    iat: (options.expiresIn ?? 300) > 0 ? now : now - 10,
    exp: now + (options.expiresIn ?? 300),
  });
}

function call(method: string, path: string, bearer: string): Promise<number> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: { authorization: `Bearer ${bearer}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function eventually(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A raw service client on the namespace, recording what it hears. */
function listen(token: string | undefined): {
  socket: ClientSocket;
  revoked: OxySessionRevocationEvent[];
  heartbeats: number;
  refusal: Promise<string>;
} {
  const socket = connect(`${baseURL}/service-events`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: token === undefined ? {} : { token },
  });
  clients.push(socket);
  const heard = {
    socket,
    revoked: [] as OxySessionRevocationEvent[],
    heartbeats: 0,
    refusal: new Promise<string>((resolve) =>
      socket.on('connect_error', (e) => resolve(e.message)),
    ),
  };
  socket.on(OXY_SESSION_REVOKED_EVENT, (event: OxySessionRevocationEvent) =>
    heard.revoked.push(event),
  );
  socket.on(OXY_SERVICE_EVENTS_HEARTBEAT_EVENT, () => {
    heard.heartbeats += 1;
  });
  return heard;
}

/**
 * True once the socket is connected, false if the server refuses it first (or it
 * never connects). A refusal ends the wait at once instead of burning the deadline.
 */
async function connectsInTime(heard: ReturnType<typeof listen>): Promise<boolean> {
  let refused = false;
  void heard.refusal.then(() => {
    refused = true;
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (heard.socket.connected) return true;
    if (refused) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** An Oxy backend: the real `OxyServer`, its service token minted here, its feed live. */
async function backend() {
  const oxy = new OxyServer({ baseURL, serviceAuth: { apiKey: 'oxy_dk_feed', apiSecret: 's' } });
  backends.push(oxy);
  jest.spyOn(oxy, 'serviceToken').mockImplementation(async () => serviceToken());
  const request = jest.spyOn(oxy, 'request');
  const validations = () =>
    request.mock.calls.filter(([, url]) => String(url).startsWith('/session/validate-header/'))
      .length;
  return { oxy, validations };
}

/** Validate until the backend's feed is live and an answer is served from its cache. */
async function cached(oxy: OxyServer, sessionId: string, bearer: string) {
  const calls = () => (oxy.request as jest.Mock).mock.calls.length;
  await eventually(async () => {
    await oxy.session.validate(sessionId, { accessToken: bearer });
    const before = calls();
    await oxy.session.validate(sessionId, { accessToken: bearer });
    return calls() === before;
  }, 'the backend to cache a validation');
}

beforeAll(async () => {
  await closePostgres();
  databaseUrl = await createTestDatabase();
  process.env.DATABASE_URL = databaseUrl;
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  const app = express();
  app.use(express.json());
  app.use('/session', sessionRouter);
  app.use('/devices', devicesRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  sockets = new Server(server);
  feed = startServiceEvents(sockets.of('/service-events'), null);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  serviceOwner = await account();
  const [appRow] = await getDb()
    .insert(applications)
    .values({ name: 'Own feed', ownerAccountId: serviceOwner, isOfficial: true, status: 'active' })
    .returning();
  serviceApp = appRow.id;
  const { binding } = await bindWorkloadIdentity({
    applicationId: serviceApp,
    environment: 'development',
    subject: `arn:aws:iam::237343248947:role/feed-${randomUUID()}`,
    actor: { isPlatformStaff: true, describedAs: 'feed fixture' },
  });
  bindingId = binding.id;
  serviceCredential = binding.attestationId;
  const verified = verifyServiceToken(serviceToken());
  expect(verified.ok).toBe(true);
  if (verified.ok) expect(await resolveLiveServiceTokenAuthority(verified.payload)).not.toBeNull();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  for (const oxy of backends.splice(0)) oxy.dispose();
});

afterAll(async () => {
  await feed.stop();
  await new Promise<void>((resolve) => sockets.close(() => resolve()));
  await closePostgres();
  await dropTestDatabase(databaseUrl);
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

beforeEach(() => {
  sessionCache.clear();
  userCache.clear();
});

describe('the /service-events namespace admits only Oxy’s own services', () => {
  it('refuses no token, a user bearer, an external application and an expired token', async () => {
    const owner = await account();
    const { bearer } = await signIn(owner);
    expect(await listen(undefined).refusal).toBe('unauthorized');
    expect(await listen(bearer).refusal).toBe(OXY_SERVICE_EVENTS_FORBIDDEN);
    expect(await listen(serviceToken({ tier: 'external' })).refusal).toBe(
      OXY_SERVICE_EVENTS_FORBIDDEN,
    );
    expect(await listen(serviceToken({ expiresIn: -1 })).refusal).toBe('unauthorized');
  });

  it('admits a scope-less own workload, vouches for itself at once, and relays revocations to it', async () => {
    const heard = listen(serviceToken());
    await eventually(() => heard.heartbeats > 0, 'a heartbeat');

    const owner = await account();
    const { sessionId } = await signIn(owner);
    await sessionService.deactivateSession(sessionId);
    await eventually(() => heard.revoked.length > 0, 'the revocation');
    expect(heard.revoked).toEqual([{ sessionId, userId: owner, at: expect.any(Number) }]);
  });

  it('rejects revoked bindings, applications and owners, including on an established connection', async () => {
    for (const target of ['binding', 'application', 'owner'] as const) {
      const heard = listen(serviceToken());
      await eventually(() => heard.socket.connected, 'live connection');
      if (target === 'binding')
        await getDb()
          .update(applicationWorkloadIdentities)
          .set({ expiresAt: new Date(0) })
          .where(eq(applicationWorkloadIdentities.id, bindingId));
      if (target === 'application')
        await getDb()
          .update(applications)
          .set({ status: 'suspended' })
          .where(eq(applications.id, serviceApp));
      if (target === 'owner')
        await getDb()
          .update(users)
          .set({ accountStatus: 'archived' })
          .where(eq(users.id, serviceOwner));
      expect(await listen(serviceToken()).refusal).toBe(OXY_SERVICE_EVENTS_FORBIDDEN);
      const session = await signIn(await account());
      await sessionService.deactivateSession(session.sessionId);
      await eventually(() => !heard.socket.connected, 'live authority disconnect');
      expect(heard.revoked).toEqual([]);
      await getDb()
        .update(applicationWorkloadIdentities)
        .set({ expiresAt: null })
        .where(eq(applicationWorkloadIdentities.id, bindingId));
      await getDb()
        .update(applications)
        .set({ status: 'active' })
        .where(eq(applications.id, serviceApp));
      await getDb()
        .update(users)
        .set({ accountStatus: 'active' })
        .where(eq(users.id, serviceOwner));
    }
  });

  it('never promotes an official application customer credential, including old internal branding', async () => {
    const [credential] = await getDb()
      .insert(applicationCredentials)
      .values({
        applicationId: serviceApp,
        name: 'customer',
        type: 'service',
        publicKey: randomUUID(),
        secretHash: 'fixture',
        environment: 'development',
        scopes: [],
      })
      .returning();
    expect(
      await listen(serviceToken({ tier: 'external', credentialId: credential.id })).refusal,
    ).toBe(OXY_SERVICE_EVENTS_FORBIDDEN);
    expect(await listen(serviceToken({ legacy: true, credentialId: credential.id })).refusal).toBe(
      OXY_SERVICE_EVENTS_FORBIDDEN,
    );
    expect(await listen(serviceToken({ legacy: true })).refusal).toBe(OXY_SERVICE_EVENTS_FORBIDDEN);
  });

  it('refuses v1 even for an exact live historical cohort workload', async () => {
    const tuple = LEGACY_WORKLOAD_BINDINGS[0];
    await getDb().insert(applications).values({
      id: tuple.applicationId,
      name: 'Legacy feed',
      ownerAccountId: serviceOwner,
      isOfficial: true,
      status: 'active',
    });
    await getDb()
      .insert(applicationWorkloadIdentities)
      .values({ ...tuple, environment: 'development', scopes: [] });
    await ensureWorkloadAttributionIdentity({
      bindingId: tuple.id,
      applicationId: tuple.applicationId,
      subject: tuple.subject,
    });
    const token = serviceToken({
      legacy: true,
      appId: tuple.applicationId,
      credentialId: workloadAttestationHandle(tuple.subject),
    });
    expect(await listen(token).refusal).toBe(OXY_SERVICE_EVENTS_FORBIDDEN);
  });

  it('closes a service socket when its token expires', async () => {
    // The token must still be live when the server checks it at the handshake.
    // The test used `expiresIn: 1`, and `serviceToken` floors `iat` to the second,
    // so that token had anywhere from 0 to 1 s of real life: shorter than one GC
    // pause on a loaded CI runner. The server then refused it, the socket never
    // connected, and the test failed with "Timed out waiting for the connection"
    // without ever reaching what it is about. Take a fresh two-second token for each
    // attempt until one connects, and assert the part under test: once that token's
    // life is over, the server closes the socket.
    let heard = listen(serviceToken({ expiresIn: 2 }));
    for (let attempt = 1; attempt < 4 && !(await connectsInTime(heard)); attempt += 1) {
      heard.socket.close();
      heard = listen(serviceToken({ expiresIn: 2 }));
    }
    await eventually(() => heard.socket.connected, 'the connection');
    await eventually(() => !heard.socket.connected, 'the expiry disconnect');
  });
});

describe('a backend stops trusting a revoked session at once', () => {
  it('logout', async () => {
    const owner = await account();
    const session = await signIn(owner);
    const heard = listen(serviceToken());
    const { oxy, validations } = await backend();
    await cached(oxy, session.sessionId, session.bearer);

    expect(await call('POST', `/session/logout/${session.sessionId}`, session.bearer)).toBe(200);
    await eventually(
      () => heard.revoked.some((event) => event.sessionId === session.sessionId),
      'the logout announcement',
    );
    const before = validations();
    await expect(
      oxy.session.validate(session.sessionId, { accessToken: session.bearer }),
    ).rejects.toBeDefined();
    expect(validations()).toBe(before + 1);
  });

  it('sign-out everywhere', async () => {
    const owner = await account();
    const current = await signIn(owner);
    const other = await signIn(owner);
    const heard = listen(serviceToken());
    const { oxy, validations } = await backend();
    await cached(oxy, other.sessionId, other.bearer);

    expect(await call('POST', `/session/logout-all/${current.sessionId}`, current.bearer)).toBe(
      200,
    );
    await eventually(
      () => heard.revoked.some((event) => event.userId === owner && !event.sessionId),
      'the account-wide announcement',
    );
    const before = validations();
    await expect(
      oxy.session.validate(other.sessionId, { accessToken: other.bearer }),
    ).rejects.toBeDefined();
    expect(validations()).toBe(before + 1);
  });

  it('device removal', async () => {
    const owner = await account();
    const current = await signIn(owner);
    const removed = await signIn(owner);
    const heard = listen(serviceToken());
    const { oxy, validations } = await backend();
    await cached(oxy, removed.sessionId, removed.bearer);

    expect(await call('DELETE', `/devices/${removed.deviceId}`, current.bearer)).toBe(200);
    await eventually(
      () => heard.revoked.some((event) => event.sessionId === removed.sessionId),
      'the device-removal announcement',
    );
    const before = validations();
    await expect(
      oxy.session.validate(removed.sessionId, { accessToken: removed.bearer }),
    ).rejects.toBeDefined();
    expect(validations()).toBe(before + 1);
  });

  it('a backend drops its cache when its feed drops', async () => {
    const owner = await account();
    const session = await signIn(owner);
    const { oxy, validations } = await backend();
    await cached(oxy, session.sessionId, session.bearer);

    sockets.of('/service-events').disconnectSockets(true);
    // Whether the backend is still down or already back in a new live period,
    // the answer cached before the gap is never served after it.
    await eventually(async () => {
      const before = validations();
      await oxy.session.validate(session.sessionId, { accessToken: session.bearer });
      return validations() === before + 1;
    }, 'the cache to stop being used');
  });
});
