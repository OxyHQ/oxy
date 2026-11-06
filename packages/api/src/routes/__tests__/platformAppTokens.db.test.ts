/**
 * ADR 0058 — the platform holds the Oxy session; applications get tokens for
 * themselves from it. End to end through the real routers, the REAL bearer
 * check, the real session mint and a REAL Postgres:
 *
 *   a setup client signs in (an ordinary password sign-in, the SDK's own) →
 *   the platform service signs in with that device proof naming its own
 *   application (`platformClient`) and gets a PLATFORM credential, the proof's
 *   row deleted and the account's session replaced → it mints application
 *   tokens (`POST /session/device/app-token`) → every API verifies them, none
 *   reaches the device, they die with the session, the credential and the
 *   application's trust.
 *
 * Replaced, and only these: the per-IP limiters (Redis), Socket.IO broadcasts,
 * the security-activity log and the app-assertion signing runtime. The
 * lockout store and password hashing are real, wrapped to count their calls.
 */

import { randomUUID } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { generateKeyPairSync } from 'node:crypto';
import { verifyAppAssertion } from '@oxy.so/core/server';
import type { AppAssertionDependencies } from '../../services/appAssertion.service';

const AUTH_ORIGIN = `https://auth-${randomUUID().slice(0, 8)}.example`;
process.env.AUTH_WEB_ORIGIN = AUTH_ORIGIN;
process.env.DEVICE_ID_SALT ??= 'platform-test-device-id-salt-0123456789abcdef';

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
  socketRoomsFor: jest.requireActual('../../utils/socket').socketRoomsFor,
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: {
    logDeviceAdded: jest.fn().mockResolvedValue(undefined),
    logSignIn: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../../services/loginLockout.service', () => {
  const actual = jest.requireActual('../../services/loginLockout.service');
  return {
    ...actual,
    reserveAttempt: jest.fn((...args: unknown[]) => actual.reserveAttempt(...args)),
  };
});
jest.mock('../../services/password.service', () => {
  const actual = jest.requireActual('../../services/password.service');
  return {
    ...actual,
    readPasswordHash: jest.fn((...args: unknown[]) => actual.readPasswordHash(...args)),
    verifyPasswordOrDummy: jest.fn((...args: unknown[]) => actual.verifyPasswordOrDummy(...args)),
  };
});
let mockRuntime: AppAssertionDependencies;
jest.mock('../../services/appAssertion.service', () => ({
  ...jest.requireActual('../../services/appAssertion.service'),
  appAssertionRuntime: () => mockRuntime,
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import {
  applicationOxyosEntries,
  applicationRecognition,
  applicationWebOrigins,
} from '../../db/schema/applicationRecognition';
import { applications } from '../../db/schema/applications';
import { deviceCredentials } from '../../db/schema/deviceCredentials';
import { deviceSessions } from '../../db/schema/deviceSessions';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { reserveAttempt } from '../../services/loginLockout.service';
import {
  readPasswordHash,
  storePassword,
  verifyPasswordOrDummy,
} from '../../services/password.service';
import { confirmTotp, enrollTotp, totpCodeAt } from '../../services/totp.service';
import { sha256Hex } from '../../services/oauthCode.service';
import { resolveSocketIdentity } from '../../utils/socketAuth';
import { socketRoomsFor } from '../../utils/socket';
import { awayFromTotpStepEdge } from '../../../test-support/totpStep';
import appAssertionsRouter from '../appAssertions';
import sessionRouter from '../session';
import sessionDeviceRouter from '../sessionDevice';
import signInRouter from '../signIn';

jest.setTimeout(120_000);

const app = express();
app.use(express.json());
app.use('/auth', signInRouter);
app.use('/session/device', sessionDeviceRouter);
app.use('/session', sessionRouter);
app.use('/apps', appAssertionsRouter);
app.use(errorHandler);

const ISSUER = 'https://api.oxy.test';
const SIGNING = generateKeyPairSync('ed25519');

const tag = () => randomUUID().replace(/-/g, '').slice(0, 10);

interface TestApplication {
  applicationId: string;
  clientId: string;
}

async function owner(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `owner${tag()}` })
    .returning({ id: users.id });
  return row.id;
}

/** An application with a public client, its recognition and, optionally, a platform host and entries. */
async function registerApplication(options: {
  type?: 'first_party' | 'third_party';
  isOfficial?: boolean;
  platformHost?: 'oxyos' | 'astro';
  desktopEntryIds?: string[];
  webOrigins?: string[];
}): Promise<TestApplication> {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `App ${tag()}`,
      type: options.type ?? 'first_party',
      isOfficial: options.isOfficial ?? (options.type ?? 'first_party') !== 'third_party',
      redirectUris: [],
      ownerAccountId: await owner(),
    })
    .returning({ id: applications.id });
  const clientId = `oxy_dk_${tag()}${tag()}`;
  await getDb().insert(applicationCredentials).values({
    applicationId: row.id,
    name: 'Production',
    type: 'public',
    environment: 'production',
    publicKey: clientId,
  });
  await getDb()
    .insert(applicationRecognition)
    .values({ applicationId: row.id, platformHost: options.platformHost ?? null });
  for (const desktopEntryId of options.desktopEntryIds ?? []) {
    await getDb().insert(applicationOxyosEntries).values({ desktopEntryId, applicationId: row.id });
  }
  for (const origin of options.webOrigins ?? []) {
    await getDb().insert(applicationWebOrigins).values({ origin, applicationId: row.id });
  }
  return { applicationId: row.id, clientId };
}

const entry = () => `so.oxy.t${tag()}`;

let oxyos: TestApplication;
let astro: TestApplication;
let dropsea: TestApplication;
let dropseaEntry: string;
let thirdParty: TestApplication;
let thirdPartyEntry: string;
let identityCarrier: TestApplication;
let identityCarrierEntry: string;
let plainApp: TestApplication;

beforeAll(async () => {
  await connectPostgres();
  oxyos = await registerApplication({ platformHost: 'oxyos' });
  astro = await registerApplication({ platformHost: 'astro' });
  dropseaEntry = entry();
  dropsea = await registerApplication({ desktopEntryIds: [dropseaEntry] });
  thirdPartyEntry = entry();
  thirdParty = await registerApplication({
    type: 'third_party',
    isOfficial: false,
    desktopEntryIds: [thirdPartyEntry],
  });
  identityCarrierEntry = entry();
  identityCarrier = await registerApplication({
    desktopEntryIds: [identityCarrierEntry],
    webOrigins: [AUTH_ORIGIN],
  });
  plainApp = await registerApplication({});
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.mocked(reserveAttempt).mockClear();
  jest.mocked(readPasswordHash).mockClear();
  jest.mocked(verifyPasswordOrDummy).mockClear();
  mockRuntime = {
    now: () => new Date(),
    issuer: ISSUER,
    signing: () => ({ keyId: 'platform-test', privateKey: SIGNING.privateKey }),
    playIntegrity: () => null,
    appAttestRoot: () => {
      throw new Error('not used');
    },
    appAttestEnvironments: () => [],
  };
});

const PASSWORD = 'correct horse battery staple';

async function person(): Promise<{ id: string; username: string }> {
  const username = `person${tag()}`;
  const [row] = await getDb().insert(users).values({ username }).returning({ id: users.id });
  await storePassword(row.id, PASSWORD);
  return { id: row.id, username };
}

type Body = Record<string, unknown>;

async function post(path: string, body: Body, headers: Record<string, string> = {}) {
  const response = await request(app).post(path).set(headers).send(body);
  return { status: response.status, body: response.body as Body };
}

function dataOf(body: Body): Body {
  return body.data as Body;
}

/** The setup client's own sign-in: an ordinary password sign-in, no platform. */
async function setupSignIn(identifier: string) {
  const signedIn = await post('/auth/signin/password', { identifier, password: PASSWORD });
  expect(signedIn.status).toBe(200);
  return {
    deviceId: signedIn.body.deviceId as string,
    deviceSecret: signedIn.body.deviceSecret as string,
    accessToken: signedIn.body.accessToken as string,
    sessionId: signedIn.body.sessionId as string,
  };
}

/** The platform service's own sign-in, with a device proof. */
async function platformSignIn(
  identifier: string,
  proof: { deviceId: string; deviceSecret: string },
  platformClient: Body = { platform: 'oxyos', clientId: oxyos.clientId },
) {
  return post('/auth/signin/password', {
    identifier,
    password: PASSWORD,
    device: proof,
    platformClient,
  });
}

/** A person with a platform credential on their own device. */
async function enrolled() {
  const who = await person();
  const setup = await setupSignIn(who.username);
  const platform = await platformSignIn(who.username, setup);
  expect(platform.status).toBe(200);
  return {
    who,
    setup,
    deviceId: platform.body.deviceId as string,
    platformSecret: platform.body.deviceSecret as string,
    sessionId: platform.body.sessionId as string,
  };
}

async function mint(body: Body, headers: Record<string, string> = {}) {
  return post('/session/device/app-token', body, headers);
}

async function credentialRows(deviceId: string) {
  return getDb()
    .select({
      secretHash: deviceCredentials.secretHash,
      platform: deviceCredentials.platform,
      platformApplicationId: deviceCredentials.platformApplicationId,
    })
    .from(deviceCredentials)
    .innerJoin(deviceSessions, eq(deviceSessions.id, deviceCredentials.deviceSessionId))
    .where(eq(deviceSessions.deviceId, deviceId));
}

async function liveSessionsOf(userId: string, deviceId: string) {
  return getDb()
    .select({ sessionId: sessions.sessionId })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.deviceId, deviceId),
        eq(sessions.isActive, true),
      ),
    );
}

async function validateHeader(token: string, sessionId: string) {
  const response = await request(app)
    .get(`/session/validate-header/${sessionId}`)
    .set('authorization', `Bearer ${token}`);
  return { status: response.status, body: response.body as Body };
}

describe('the platform credential (ADR 0058 2.1, R1)', () => {
  it('is issued to the platform’s sign-in, retires the proof and replaces the account’s session', async () => {
    const who = await person();
    const setup = await setupSignIn(who.username);
    const before = await credentialRows(setup.deviceId);
    expect(before.map((row) => row.secretHash)).toContain(sha256Hex(setup.deviceSecret));

    const platform = await platformSignIn(who.username, setup);
    expect(platform.status).toBe(200);
    expect(platform.body.deviceId).toBe(setup.deviceId);
    const platformSecret = platform.body.deviceSecret as string;
    expect(platformSecret).toEqual(expect.any(String));

    const rows = await credentialRows(setup.deviceId);
    // The proof the setup client's JavaScript saw is gone; the platform's is the only one.
    expect(rows.map((row) => row.secretHash)).not.toContain(sha256Hex(setup.deviceSecret));
    expect(rows).toEqual([
      {
        secretHash: sha256Hex(platformSecret),
        platform: 'oxyos',
        platformApplicationId: oxyos.applicationId,
      },
    ]);
    const stale = await post('/session/device/token', {
      deviceId: setup.deviceId,
      deviceSecret: setup.deviceSecret,
    });
    expect([stale.status, stale.body.error]).toEqual([401, 'invalid_device_secret']);

    // One session for the account; the setup client's token died with its session.
    expect(await liveSessionsOf(who.id, setup.deviceId)).toEqual([
      { sessionId: platform.body.sessionId },
    ]);
    expect(platform.body.sessionId).not.toBe(setup.sessionId);
    expect((await validateHeader(setup.accessToken, setup.sessionId)).status).toBe(401);

    // R4: a platform credential still mints the device's own token.
    const deviceToken = await post('/session/device/token', {
      deviceId: setup.deviceId,
      deviceSecret: platformSecret,
    });
    expect(deviceToken.status).toBe(200);
  });

  it('leaves one session and one credential however often the platform signs in again', async () => {
    const { who, deviceId, platformSecret } = await enrolled();
    let secret = platformSecret;
    for (let round = 0; round < 2; round += 1) {
      const again = await platformSignIn(who.username, { deviceId, deviceSecret: secret });
      expect(again.status).toBe(200);
      const rows = await credentialRows(deviceId);
      expect(rows.map((row) => row.secretHash)).toEqual([
        sha256Hex(again.body.deviceSecret as string),
      ]);
      expect((await liveSessionsOf(who.id, deviceId)).length).toBe(1);
      secret = again.body.deviceSecret as string;
    }
  });

  it('is never evicted by the per-device holder cap', async () => {
    const { deviceId, platformSecret } = await enrolled();
    const { deviceSessionService } = await import('../../services/deviceSession.service');
    for (let index = 0; index < 34; index += 1) {
      await deviceSessionService.issueDeviceSecret(deviceId);
    }
    const rows = await credentialRows(deviceId);
    expect(rows.filter((row) => row.platform === null).length).toBe(32);
    expect(rows.map((row) => row.secretHash)).toContain(sha256Hex(platformSecret));
  });

  it('refuses an unhonoured platformClient identically for known and unknown identifiers, before any password work', async () => {
    const who = await person();
    const cases: Array<{ platformClient: Body; headers?: Record<string, string> }> = [
      { platformClient: { platform: 'oxyos', clientId: `oxy_dk_${tag()}` } },
      // An Oxy application that is not a platform host.
      { platformClient: { platform: 'oxyos', clientId: dropsea.clientId } },
      // The other platform's client id.
      { platformClient: { platform: 'oxyos', clientId: astro.clientId } },
      { platformClient: { platform: 'astro', clientId: oxyos.clientId } },
      // A page: a platform credential is never issued to a browser.
      {
        platformClient: { platform: 'oxyos', clientId: oxyos.clientId },
        headers: { origin: 'http://localhost:5173' },
      },
    ];
    for (const { platformClient, headers } of cases) {
      const answers = [];
      for (const identifier of [who.username, `nobody${tag()}`]) {
        jest.mocked(reserveAttempt).mockClear();
        jest.mocked(readPasswordHash).mockClear();
        jest.mocked(verifyPasswordOrDummy).mockClear();
        const answer = await post(
          '/auth/signin/password',
          { identifier, password: PASSWORD, platformClient },
          headers,
        );
        expect(reserveAttempt).not.toHaveBeenCalled();
        expect(readPasswordHash).not.toHaveBeenCalled();
        expect(verifyPasswordOrDummy).not.toHaveBeenCalled();
        answers.push(answer);
      }
      expect(answers[0].status).toBe(400);
      expect(answers[0]).toEqual(answers[1]);
    }
  });

  it('carries the platform client through the second factor, and only the same one completes it', async () => {
    // Three codes of three consecutive steps (each spent once, ADR 0030): the
    // previous one confirms, the current one is the setup's, the next the platform's.
    await awayFromTotpStepEdge();
    const who = await person();
    const { secret } = await enrollTotp(who.id, who.username);
    await confirmTotp(who.id, totpCodeAt(secret, new Date(Date.now() - 30_000)));
    // The setup client passes its own second factor first.
    const first = await post('/auth/signin/password', {
      identifier: who.username,
      password: PASSWORD,
    });
    expect(first.body.secondFactorRequired).toBe(true);
    const setupDone = await post('/auth/signin/second-factor', {
      challengeId: first.body.challengeId,
      code: totpCodeAt(secret, new Date()),
    });
    expect(setupDone.status).toBe(200);
    const proof = {
      deviceId: setupDone.body.deviceId as string,
      deviceSecret: setupDone.body.deviceSecret as string,
    };

    const challenge = await platformSignIn(who.username, proof);
    expect(challenge.body.secondFactorRequired).toBe(true);
    // Completing it naming no platform client, or another one, is refused.
    for (const platformClient of [undefined, { platform: 'astro', clientId: astro.clientId }]) {
      const refused = await post('/auth/signin/second-factor', {
        challengeId: challenge.body.challengeId,
        code: totpCodeAt(secret, new Date(Date.now() + 30_000)),
        device: proof,
        ...(platformClient ? { platformClient } : {}),
      });
      expect(refused.status).toBe(401);
    }
    const done = await post('/auth/signin/second-factor', {
      challengeId: challenge.body.challengeId,
      code: totpCodeAt(secret, new Date(Date.now() + 30_000)),
      device: proof,
      platformClient: { platform: 'oxyos', clientId: oxyos.clientId },
    });
    expect(done.status).toBe(200);
    const rows = await credentialRows(proof.deviceId);
    expect(rows).toEqual([
      expect.objectContaining({
        secretHash: sha256Hex(done.body.deviceSecret as string),
        platform: 'oxyos',
      }),
    ]);
  });
});

describe('an application’s token (ADR 0058 2.2 to 2.4, R2)', () => {
  it('is minted for a launched application and verified by every API', async () => {
    const { who, deviceId, platformSecret, sessionId } = await enrolled();
    const minted = await mint({
      deviceId,
      deviceSecret: platformSecret,
      attestation: { platform: 'oxyos', desktopEntryId: dropseaEntry },
    });
    expect(minted.status).toBe(200);
    const token = dataOf(minted.body);
    expect(token).toEqual({
      accessToken: expect.any(String),
      expiresAt: expect.any(String),
      applicationId: dropsea.applicationId,
      accountId: who.id,
    });
    const claims = jwt.decode(token.accessToken as string) as jwt.JwtPayload;
    const [credential] = await getDb()
      .select({ id: deviceCredentials.id })
      .from(deviceCredentials)
      .where(eq(deviceCredentials.secretHash, sha256Hex(platformSecret)));
    expect(claims).toMatchObject({
      ver: 2,
      sub: who.id,
      sid: sessionId,
      azp: dropsea.clientId,
      host: { platform: 'oxyos', credential: credential.id },
    });
    expect(claims.deviceId).toBeUndefined();
    expect(claims.scope).toBeUndefined();
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(300);
    expect(new Date(token.expiresAt as string).getTime()).toBe((claims.exp ?? 0) * 1000);
    // Never stored: the row keeps the device's own token.
    const [row] = await getDb()
      .select({ accessToken: sessions.accessToken })
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId));
    expect(row.accessToken).not.toBe(token.accessToken);

    const validated = await validateHeader(token.accessToken as string, sessionId);
    expect(validated.status).toBe(200);
    expect(validated.body.host).toEqual({
      applicationId: dropsea.applicationId,
      platform: 'oxyos',
    });
    // The device's own token says nothing of an application.
    const deviceToken = await post('/session/device/token', {
      deviceId,
      deviceSecret: platformSecret,
    });
    const plain = await validateHeader(dataOf(deviceToken.body).accessToken as string, sessionId);
    expect(plain.status).toBe(200);
    expect(plain.body.host).toBeUndefined();

    // The platform's own application.
    const self = await mint({
      deviceId,
      deviceSecret: platformSecret,
      attestation: { platform: 'oxyos', self: true },
    });
    expect(dataOf(self.body).applicationId).toBe(oxyos.applicationId);
    // A client id naming the same application is accepted.
    const named = await mint({
      deviceId,
      deviceSecret: platformSecret,
      clientId: dropsea.clientId,
      attestation: { platform: 'oxyos', desktopEntryId: dropseaEntry },
    });
    expect(named.status).toBe(200);
  });

  it('is refused by every /session/device route and joins no device room', async () => {
    const { deviceId, platformSecret } = await enrolled();
    const token = dataOf(
      (
        await mint({
          deviceId,
          deviceSecret: platformSecret,
          attestation: { platform: 'oxyos', desktopEntryId: dropseaEntry },
        })
      ).body,
    ).accessToken as string;
    const routes: Array<['get' | 'post', string, Body?]> = [
      ['get', '/session/device/state'],
      ['get', '/session/device/directory'],
      ['post', '/session/device/switch', { accountId: 'x' }],
      ['post', '/session/device/signout', { all: true }],
      ['post', '/session/device/add', {}],
      ['post', '/session/device/activate', { contextId: 'x' }],
      ['post', '/session/device/background-credential', {}],
    ];
    for (const [method, path, body] of routes) {
      const response = await request(app)
        [method](path)
        .set('authorization', `Bearer ${token}`)
        .send(body ?? {});
      expect({ path, status: response.status, error: response.body.error }).toEqual({
        path,
        status: 403,
        error: 'app_token_device_access_denied',
      });
    }
    // The device is untouched: its own token still mints.
    expect(
      (await post('/session/device/token', { deviceId, deviceSecret: platformSecret })).status,
    ).toBe(200);

    const identity = await resolveSocketIdentity({ auth: { token } });
    expect(identity?.kind).toBe('user');
    const rooms = socketRoomsFor(
      identity?.kind === 'user' ? { user: identity.user } : { deviceId: null },
    );
    expect(rooms).toEqual([`user:${identity?.kind === 'user' ? identity.user.id : ''}`]);
  });

  it('refuses a web Origin, a malformed body, a wrong or non-platform secret, another platform and every unrecognised application', async () => {
    const { who, deviceId, platformSecret } = await enrolled();
    const ok = { deviceId, deviceSecret: platformSecret };
    const desktop = (desktopEntryId: string) => ({ platform: 'oxyos', desktopEntryId });

    const browser = await mint(
      { ...ok, attestation: desktop(dropseaEntry) },
      { origin: 'https://dropsea.net' },
    );
    expect([browser.status, browser.body.error]).toEqual([403, 'browser_not_allowed']);
    const malformed = await mint({ deviceId, attestation: desktop(dropseaEntry) });
    expect([malformed.status, malformed.body.error]).toEqual([400, 'invalid_request']);
    const wrong = await mint({
      deviceId,
      deviceSecret: 'w'.repeat(43),
      attestation: desktop(dropseaEntry),
    });
    expect([wrong.status, wrong.body.error]).toEqual([401, 'invalid_device_secret']);

    // An ordinary holder credential of a device mints nothing here.
    const other = await person();
    const ordinary = await setupSignIn(other.username);
    const holder = await mint({
      deviceId: ordinary.deviceId,
      deviceSecret: ordinary.deviceSecret,
      attestation: desktop(dropseaEntry),
    });
    expect([holder.status, holder.body.error]).toEqual([401, 'invalid_device_secret']);

    const notRecognised = [
      { ...ok, attestation: { platform: 'astro', self: true } },
      {
        ...ok,
        attestation: {
          platform: 'astro',
          origin: 'https://dropsea.example',
          clientId: dropsea.clientId,
        },
      },
      { ...ok, attestation: desktop(entry()) },
      { ...ok, attestation: desktop(identityCarrierEntry) },
      { ...ok, attestation: desktop(thirdPartyEntry) },
      { ...ok, clientId: plainApp.clientId, attestation: desktop(dropseaEntry) },
    ];
    for (const body of notRecognised) {
      const refused = await mint(body);
      expect({ body: body.attestation, status: refused.status, error: refused.body.error }).toEqual(
        {
          body: body.attestation,
          status: 403,
          error: 'application_not_recognised',
        },
      );
    }

    const pinned = await mint({ ...ok, accountId: other.id, attestation: desktop(dropseaEntry) });
    expect([pinned.status, pinned.body.error]).toEqual([401, 'account_not_on_device']);
    const own = await mint({ ...ok, accountId: who.id, attestation: desktop(dropseaEntry) });
    expect(own.status).toBe(200);
  });

  it('dies with its platform credential, its session and its application’s trust', async () => {
    const { who, deviceId, platformSecret, sessionId } = await enrolled();
    const appToken = async (secret: string) =>
      dataOf(
        (
          await mint({
            deviceId,
            deviceSecret: secret,
            attestation: { platform: 'oxyos', desktopEntryId: dropseaEntry },
          })
        ).body,
      ).accessToken as string;

    // The credential: a newer platform sign-in retires it (and replaces the session).
    const first = await appToken(platformSecret);
    expect((await validateHeader(first, sessionId)).status).toBe(200);
    const again = await platformSignIn(who.username, { deviceId, deviceSecret: platformSecret });
    expect((await validateHeader(first, sessionId)).status).toBe(401);
    const secret = again.body.deviceSecret as string;
    const newSession = again.body.sessionId as string;

    // The credential alone, the session still live.
    const second = await appToken(secret);
    expect((await validateHeader(second, newSession)).status).toBe(200);
    await getDb()
      .update(deviceCredentials)
      .set({ platform: 'astro' })
      .where(eq(deviceCredentials.secretHash, sha256Hex(secret)));
    expect((await validateHeader(second, newSession)).status).toBe(401);
    await getDb()
      .update(deviceCredentials)
      .set({ platform: 'oxyos' })
      .where(eq(deviceCredentials.secretHash, sha256Hex(secret)));
    expect((await validateHeader(second, newSession)).status).toBe(200);

    // The application's trust, read live.
    await getDb()
      .update(applications)
      .set({ type: 'third_party', isOfficial: false })
      .where(eq(applications.id, dropsea.applicationId));
    try {
      expect((await validateHeader(second, newSession)).status).toBe(401);
    } finally {
      await getDb()
        .update(applications)
        .set({ type: 'first_party', isOfficial: true })
        .where(eq(applications.id, dropsea.applicationId));
    }
    expect((await validateHeader(second, newSession)).status).toBe(200);

    // The session (R4): the platform ends the device with its own token.
    const deviceToken = dataOf(
      (await post('/session/device/token', { deviceId, deviceSecret: secret })).body,
    ).accessToken as string;
    const signedOut = await request(app)
      .post('/session/device/signout')
      .set('authorization', `Bearer ${deviceToken}`)
      .send({ all: true });
    expect(signedOut.status).toBe(200);
    expect((await validateHeader(second, newSession)).status).toBe(401);
    const after = await mint({
      deviceId,
      deviceSecret: secret,
      attestation: { platform: 'oxyos', desktopEntryId: dropseaEntry },
    });
    expect(after.status).toBe(401);
    expect(['invalid_device_secret', 'no_active_session']).toContain(after.body.error);
  });
});

describe('the oxyos assertion lane (ADR 0058 2.7)', () => {
  it('asserts an application token’s own application and platform, and nothing else', async () => {
    const { deviceId, platformSecret } = await enrolled();
    const appToken = dataOf(
      (
        await mint({
          deviceId,
          deviceSecret: platformSecret,
          attestation: { platform: 'oxyos', desktopEntryId: dropseaEntry },
        })
      ).body,
    ).accessToken as string;
    const assert = (bearer: string, body: Body) =>
      request(app).post('/apps/assertions').set('authorization', `Bearer ${bearer}`).send(body);

    const asserted = await assert(appToken, {
      applicationId: dropsea.applicationId,
      platform: 'oxyos',
    });
    expect(asserted.status).toBe(200);
    expect(asserted.body).toMatchObject({
      applicationId: dropsea.applicationId,
      platform: 'oxyos',
    });
    const claims = jwt.decode(appToken) as jwt.JwtPayload;
    const verified = await verifyAppAssertion(asserted.body.assertion, {
      session: { userId: claims.sub as string, sessionId: claims.sid as string },
      issuer: ISSUER,
      resolvePublicKey: async (keyId: string) =>
        keyId === 'platform-test' ? SIGNING.publicKey : undefined,
    });
    expect(verified).toEqual({ applicationId: dropsea.applicationId, platform: 'oxyos' });

    for (const body of [
      { applicationId: oxyos.applicationId, platform: 'oxyos' },
      { applicationId: dropsea.applicationId, platform: 'astro' },
      { applicationId: dropsea.applicationId, platform: 'web' },
    ]) {
      const refused = await assert(appToken, body);
      expect([refused.status, refused.body.error]).toEqual([403, 'app_token_mismatch']);
    }
    // The device's own token is no application's proof on this lane.
    const deviceToken = dataOf(
      (await post('/session/device/token', { deviceId, deviceSecret: platformSecret })).body,
    ).accessToken as string;
    const plain = await assert(deviceToken, {
      applicationId: dropsea.applicationId,
      platform: 'oxyos',
    });
    expect([plain.status, plain.body.error]).toEqual([403, 'app_token_mismatch']);
  });
});

describe('the device mint (ADR 0058 step 0)', () => {
  it('answers expiresAt as the access token’s own exp, not the session’s', async () => {
    const { deviceId, platformSecret } = await enrolled();
    const minted = dataOf(
      (await post('/session/device/token', { deviceId, deviceSecret: platformSecret })).body,
    );
    const claims = jwt.decode(minted.accessToken as string) as jwt.JwtPayload;
    expect(new Date(minted.expiresAt as string).getTime()).toBe((claims.exp ?? 0) * 1000);
    expect(new Date(minted.expiresAt as string).getTime() - Date.now()).toBeLessThanOrEqual(
      15 * 60 * 1000,
    );
  });
});
