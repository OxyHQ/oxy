/**
 * `POST /session/device/platform` — a platform's credential from the QR
 * approval (ADR 0058 2.1, amended 2026-11-08) — end to end through the real
 * routers, the real bearer check, the real session mint and a REAL Postgres:
 *
 *   OxyOS's setup client shows a QR (`POST /auth/session/create`, OxyOS's
 *   client) → a phone already signed in approves it (`authorize-code`, by
 *   bearer) → the setup client claims it (`POST /auth/session/claim`) and holds
 *   a holder credential → the platform service redeems that proof once for a
 *   PLATFORM credential, no password anywhere → it mints application tokens.
 *
 * And every proof that is not redeemable gets the same 401: replayed, raced,
 * named by another platform client, stale, of a device signed out, of a
 * credential that is not the claim's, unknown.
 *
 * Replaced, and only these: the per-IP limiters (Redis), Socket.IO broadcasts
 * and the security-activity log. The lockout store is real.
 */

import { randomUUID } from 'node:crypto';
import express, { type Request } from 'express';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';

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
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: jest.fn(),
  emitAuthSessionProgress: jest.fn(),
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: {
    logDeviceAdded: jest.fn().mockResolvedValue(undefined),
    logSignIn: jest.fn().mockResolvedValue(undefined),
  },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import {
  applicationOxyosEntries,
  applicationRecognition,
} from '../../db/schema/applicationRecognition';
import { applications } from '../../db/schema/applications';
import { authSessions } from '../../db/schema/authSessions';
import { deviceAccountContexts } from '../../db/schema/deviceAccountContexts';
import { deviceCredentials } from '../../db/schema/deviceCredentials';
import { deviceSessions } from '../../db/schema/deviceSessions';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { clearFailures } from '../../services/loginLockout.service';
import { storePassword } from '../../services/password.service';
import sessionService from '../../services/session.service';
import { sha256Hex } from '../../services/oauthCode.service';
import { PROMOTION_WINDOW_MS } from '../../services/platformPromotion.service';
import authRouter from '../auth';
import sessionRouter from '../session';
import sessionDeviceRouter from '../sessionDevice';
import signInRouter from '../signIn';

jest.setTimeout(120_000);

const app = express();
app.use(express.json());
app.use('/auth', signInRouter);
app.use('/session/device', sessionDeviceRouter);
app.use('/session', sessionRouter);
app.use('/auth', authRouter);
app.use(errorHandler);

const tag = () => randomUUID().replace(/-/g, '').slice(0, 10);

interface TestApplication {
  applicationId: string;
  clientId: string;
}

async function registerApplication(platformHost: 'oxyos' | 'astro' | null, entries: string[] = []) {
  const [owner] = await getDb()
    .insert(users)
    .values({ username: `owner${tag()}` })
    .returning({ id: users.id });
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `App ${tag()}`,
      type: 'first_party',
      isOfficial: true,
      redirectUris: [],
      ownerAccountId: owner.id,
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
  await getDb().insert(applicationRecognition).values({ applicationId: row.id, platformHost });
  for (const desktopEntryId of entries) {
    await getDb().insert(applicationOxyosEntries).values({ desktopEntryId, applicationId: row.id });
  }
  return { applicationId: row.id, clientId } satisfies TestApplication;
}

let oxyos: TestApplication;
let astro: TestApplication;
let otherOfficial: TestApplication;
let dropsea: TestApplication;
let dropseaEntry: string;

beforeAll(async () => {
  await connectPostgres();
  oxyos = await registerApplication('oxyos');
  astro = await registerApplication('astro');
  otherOfficial = await registerApplication(null);
  dropseaEntry = `so.oxy.t${tag()}`;
  dropsea = await registerApplication(null, [dropseaEntry]);
});

afterAll(async () => {
  await closePostgres();
});

type Body = Record<string, unknown>;

async function post(path: string, body: Body, headers: Record<string, string> = {}) {
  const response = await request(app).post(path).set(headers).send(body);
  return { status: response.status, body: response.body as Body };
}

/**
 * A person signed in on their phone, as Commons is: a session on the phone and
 * no password at all (the QR path never asks for one).
 */
async function personOnPhone(): Promise<{ id: string; username: string; bearer: string }> {
  const username = `person${tag()}`;
  const [row] = await getDb().insert(users).values({ username }).returning({ id: users.id });
  const phone = await sessionService.createSession(
    row.id,
    {
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile' },
    } as unknown as Request,
    { deviceId: `phone-${randomUUID()}` },
  );
  return { id: row.id, username, bearer: phone.accessToken };
}

/** The QR, approved on the phone and claimed by the setup client: its device proof. */
async function claimedQr(
  person: { bearer: string },
  client: TestApplication = oxyos,
): Promise<{ deviceId: string; deviceSecret: string; sessionToken: string }> {
  const sessionToken = `at_${randomUUID().replace(/-/g, '')}`;
  const created = await post('/auth/session/create', { sessionToken, clientId: client.clientId });
  expect(created.status).toBe(200);
  const [row] = await getDb()
    .select({ authorizeCode: authSessions.authorizeCode })
    .from(authSessions)
    .where(eq(authSessions.sessionToken, sessionToken));
  const approved = await post(
    `/auth/session/authorize-code/${row.authorizeCode}`,
    {},
    { Authorization: `Bearer ${person.bearer}` },
  );
  expect(approved.status).toBe(200);
  const claimed = await post('/auth/session/claim', { sessionToken });
  expect(claimed.status).toBe(200);
  const data = (claimed.body.data ?? claimed.body) as Body;
  expect(typeof data.deviceSecret).toBe('string');
  return {
    deviceId: data.deviceId as string,
    deviceSecret: data.deviceSecret as string,
    sessionToken,
  };
}

async function promote(
  proof: { deviceId: string; deviceSecret: string },
  platformClient: Body = { platform: 'oxyos', clientId: oxyos.clientId },
  headers: Record<string, string> = {},
) {
  const device = { deviceId: proof.deviceId, deviceSecret: proof.deviceSecret };
  return post('/session/device/platform', { device, platformClient }, headers);
}

async function credentialsOf(deviceId: string) {
  return getDb()
    .select({
      id: deviceCredentials.id,
      secretHash: deviceCredentials.secretHash,
      platform: deviceCredentials.platform,
      platformApplicationId: deviceCredentials.platformApplicationId,
    })
    .from(deviceCredentials)
    .innerJoin(deviceSessions, eq(deviceSessions.id, deviceCredentials.deviceSessionId))
    .where(eq(deviceSessions.deviceId, deviceId));
}

/** Each case's own device budget: the budget is not what most cases test. */
async function freshBudget(deviceId: string): Promise<void> {
  await clearFailures({ scope: 'device-platform:device', identifier: deviceId });
}

const INVALID = { status: 401 };

describe('POST /session/device/platform — the QR approval redeemed once', () => {
  it("issues the platform credential, spends the proof and replaces the setup client's session", async () => {
    const person = await personOnPhone();
    const proof = await claimedQr(person);
    const before = await credentialsOf(proof.deviceId);
    expect(before.map((row) => row.platform)).toEqual([null]);

    const promoted = await promote(proof);
    expect(promoted.status).toBe(200);
    expect(promoted.body.deviceId).toBe(proof.deviceId);
    expect((promoted.body.user as Body).id).toBe(person.id);
    expect(typeof promoted.body.accessToken).toBe('string');
    const platformSecret = promoted.body.deviceSecret as string;
    expect(platformSecret).toBeTruthy();
    expect(platformSecret).not.toBe(proof.deviceSecret);

    // Exactly the password sign-in's credential: a platform credential of
    // OxyOS's application, and the proof's row gone.
    const after = await credentialsOf(proof.deviceId);
    expect(after).toEqual([
      expect.objectContaining({
        secretHash: sha256Hex(platformSecret),
        platform: 'oxyos',
        platformApplicationId: oxyos.applicationId,
      }),
    ]);
    const [claim] = await getDb()
      .select({ claimedCredentialId: authSessions.claimedCredentialId })
      .from(authSessions)
      .where(eq(authSessions.sessionToken, proof.sessionToken));
    expect(claim.claimedCredentialId).toBeNull();

    // One session for the account on the device: the platform's.
    const live = await getDb()
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, person.id),
          eq(sessions.deviceId, proof.deviceId),
          eq(sessions.isActive, true),
        ),
      );
    expect(live.map((row) => row.sessionId)).toEqual([promoted.body.sessionId]);

    // The platform credential mints an application's token like one the
    // password sign-in issued.
    const minted = await post('/session/device/app-token', {
      deviceId: proof.deviceId,
      deviceSecret: platformSecret,
      attestation: { platform: 'oxyos', desktopEntryId: dropseaEntry },
    });
    expect(minted.status).toBe(200);
    expect((minted.body.data as Body).applicationId).toBe(dropsea.applicationId);
  });

  it('is spent once: a replay is refused', async () => {
    const proof = await claimedQr(await personOnPhone());
    expect((await promote(proof)).status).toBe(200);
    await freshBudget(proof.deviceId);
    expect(await promote(proof)).toMatchObject(INVALID);
  });

  it('lets exactly one of concurrent redemptions through', async () => {
    const proof = await claimedQr(await personOnPhone());
    const outcomes = await Promise.all([promote(proof), promote(proof), promote(proof)]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([200, 401, 401]);
    const platformRows = (await credentialsOf(proof.deviceId)).filter((row) => row.platform);
    expect(platformRows).toHaveLength(1);
  });

  it('is redeemable only by the platform client whose application started the QR', async () => {
    const person = await personOnPhone();
    // Astro's own QR: OxyOS cannot redeem it, nor Astro OxyOS's.
    const astroProof = await claimedQr(person, astro);
    expect(await promote(astroProof)).toMatchObject(INVALID);
    const oxyosProof = await claimedQr(person);
    expect(
      await promote(oxyosProof, { platform: 'astro', clientId: astro.clientId }),
    ).toMatchObject(INVALID);
    // The refusals spent nothing: the right client still redeems its own.
    await freshBudget(oxyosProof.deviceId);
    expect((await promote(oxyosProof)).status).toBe(200);
  });

  it("is never a proof for an application that is not a platform's", async () => {
    const proof = await claimedQr(await personOnPhone(), otherOfficial);
    const answer = await promote(proof, { platform: 'oxyos', clientId: otherOfficial.clientId });
    expect(answer.status).toBe(400);
    expect(await credentialsOf(proof.deviceId)).toEqual([
      expect.objectContaining({ platform: null }),
    ]);
  });

  it('is refused to a browser before anything is looked up', async () => {
    const proof = await claimedQr(await personOnPhone());
    const answer = await promote(proof, undefined, { Origin: 'https://example.com' });
    expect(answer.status).toBe(400);
    await freshBudget(proof.deviceId);
    expect((await promote(proof)).status).toBe(200);
  });

  it('expires: a claim older than the window is not redeemable', async () => {
    const proof = await claimedQr(await personOnPhone());
    await getDb()
      .update(authSessions)
      .set({ consumedAt: new Date(Date.now() - PROMOTION_WINDOW_MS - 1000) })
      .where(eq(authSessions.sessionToken, proof.sessionToken));
    expect(await promote(proof)).toMatchObject(INVALID);
  });

  it('is refused once the account signed out of the device', async () => {
    const proof = await claimedQr(await personOnPhone());
    await getDb()
      .update(deviceAccountContexts)
      .set({ revokedAt: new Date() })
      .where(
        eq(
          deviceAccountContexts.deviceSessionId,
          (
            await getDb()
              .select({ id: deviceSessions.id })
              .from(deviceSessions)
              .where(eq(deviceSessions.deviceId, proof.deviceId))
          )[0].id,
        ),
      );
    expect(await promote(proof)).toMatchObject(INVALID);
  });

  it('is refused once the device was revoked (its credential gone)', async () => {
    const proof = await claimedQr(await personOnPhone());
    await getDb()
      .delete(deviceCredentials)
      .where(eq(deviceCredentials.secretHash, sha256Hex(proof.deviceSecret)));
    expect(await promote(proof)).toMatchObject(INVALID);
  });

  it('is refused for an account that is no longer active', async () => {
    const person = await personOnPhone();
    const proof = await claimedQr(person);
    await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, person.id));
    expect(await promote(proof)).toMatchObject(INVALID);
  });

  it('answers a wrong secret, an unknown device and a password sign-in credential alike', async () => {
    const person = await personOnPhone();
    const proof = await claimedQr(person);
    const wrongSecret = await promote({ deviceId: proof.deviceId, deviceSecret: `x${tag()}` });
    const unknownDevice = await promote({
      deviceId: `dev-${randomUUID()}`,
      deviceSecret: `x${tag()}`,
    });
    // A holder credential no QR claim issued (an ordinary password sign-in's).
    const username = `pw${tag()}`;
    const [row] = await getDb().insert(users).values({ username }).returning({ id: users.id });
    await storePassword(row.id, 'a long enough password');
    const signedIn = await post('/auth/signin/password', {
      identifier: username,
      password: 'a long enough password',
    });
    const passwordProof = await promote({
      deviceId: signedIn.body.deviceId as string,
      deviceSecret: signedIn.body.deviceSecret as string,
    });
    for (const answer of [wrongSecret, unknownDevice, passwordProof]) {
      expect(answer.status).toBe(401);
      expect(answer.body).toEqual(wrongSecret.body);
    }
    // None of them spent the claim's proof.
    await freshBudget(proof.deviceId);
    expect((await promote(proof)).status).toBe(200);
  });

  it("counts a device id's attempts whether or not it exists", async () => {
    const unknown = `dev-${randomUUID()}`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await promote({ deviceId: unknown, deviceSecret: `x${tag()}` })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('records the claimed credential on the request it answers', async () => {
    const proof = await claimedQr(await personOnPhone());
    const [claim] = await getDb()
      .select({ claimedCredentialId: authSessions.claimedCredentialId })
      .from(authSessions)
      .where(eq(authSessions.sessionToken, proof.sessionToken));
    const [credential] = await credentialsOf(proof.deviceId);
    expect(claim.claimedCredentialId).toBe(credential.id);
  });
});
