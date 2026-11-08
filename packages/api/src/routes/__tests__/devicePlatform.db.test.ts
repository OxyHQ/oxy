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

import { randomBytes, randomUUID } from 'node:crypto';
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
import { clearFailures, reserveAttempt } from '../../services/loginLockout.service';
import { storePassword } from '../../services/password.service';
import sessionService from '../../services/session.service';
import { sha256Hex } from '../../services/oauthCode.service';
import deviceSessionService from '../../services/deviceSession.service';
import {
  MAX_REDEMPTION_ATTEMPTS,
  PROMOTION_WINDOW_MS,
  redeemDeviceProof,
} from '../../services/platformPromotion.service';
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

/** The platform service's redemption key (R7): 256 random bits, base64url. */
const redemptionKey = () => randomBytes(32).toString('base64url');

async function promoteWithKey(proof: { deviceId: string; deviceSecret: string }, key: string) {
  const device = { deviceId: proof.deviceId, deviceSecret: proof.deviceSecret };
  return post('/session/device/platform', {
    device,
    platformClient: { platform: 'oxyos', clientId: oxyos.clientId },
    redemptionKey: key,
  });
}

async function mintsAppToken(deviceId: string, deviceSecret: string): Promise<number> {
  const minted = await post('/session/device/app-token', {
    deviceId,
    deviceSecret,
    attestation: { platform: 'oxyos', desktopEntryId: dropseaEntry },
  });
  return minted.status;
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

  it("counts a device id's attempts whether or not it exists: three in ten minutes (R8)", async () => {
    const unknown = `dev-${randomUUID()}`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await promote({ deviceId: unknown, deviceSecret: `x${tag()}` })).status);
    }
    // Locked at the fourth, not the sixth as before R8 (five in fifteen minutes).
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
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

describe('POST /session/device/platform — a redemption repeated with its key (R7)', () => {
  const oxyosClient = () => ({
    platform: 'oxyos' as const,
    clientId: oxyos.clientId,
    applicationId: oxyos.applicationId,
    confirms: false,
  });

  it('re-issues for the same proof and key, revoking the credential the first answer carried', async () => {
    const person = await personOnPhone();
    const proof = await claimedQr(person);
    const key = redemptionKey();

    const first = await promoteWithKey(proof, key);
    expect(first.status).toBe(200);
    const lost = first.body.deviceSecret as string;
    // The answer was lost on the way: the platform repeats the redemption.
    await freshBudget(proof.deviceId);
    const repeated = await promoteWithKey(proof, key);
    expect(repeated.status).toBe(200);
    expect((repeated.body.user as Body).id).toBe(person.id);
    const kept = repeated.body.deviceSecret as string;
    expect(kept).toBeTruthy();
    expect(kept).not.toBe(lost);

    // One platform credential, the repetition's; the first's no longer mints.
    const platformRows = (await credentialsOf(proof.deviceId)).filter((row) => row.platform);
    expect(platformRows.map((row) => row.secretHash)).toEqual([sha256Hex(kept)]);
    expect(await mintsAppToken(proof.deviceId, lost)).toBe(401);
    expect(await mintsAppToken(proof.deviceId, kept)).toBe(200);
    // Still one session for the account on the device: the repetition's.
    expect((await liveSessionsOf(person.id, proof.deviceId)).map((row) => row.sessionId)).toEqual([
      repeated.body.sessionId,
    ]);
    // The setup client's proof stays dead: its holder credential is gone.
    expect(
      (await credentialsOf(proof.deviceId)).some(
        (row) => row.secretHash === sha256Hex(proof.deviceSecret),
      ),
    ).toBe(false);
  });

  it('refuses a repetition without the key, or with another, as it refuses an unknown proof', async () => {
    const proof = await claimedQr(await personOnPhone());
    const key = redemptionKey();
    expect((await promoteWithKey(proof, key)).status).toBe(200);
    const unknown = await promote({ deviceId: `dev-${randomUUID()}`, deviceSecret: `x${tag()}` });

    await freshBudget(proof.deviceId);
    const withoutKey = await promote(proof);
    const otherKey = await promoteWithKey(proof, redemptionKey());
    for (const answer of [withoutKey, otherKey]) {
      expect(answer.status).toBe(401);
      expect(answer.body).toEqual(unknown.body);
    }
    // A key alone, with another secret of the device, is no proof either.
    const keyAlone = await promoteWithKey(
      { deviceId: proof.deviceId, deviceSecret: `x${tag()}` },
      key,
    );
    expect(keyAlone.status).toBe(401);
    expect(keyAlone.body).toEqual(unknown.body);
    // None of them disturbed the platform's credential.
    expect((await credentialsOf(proof.deviceId)).filter((row) => row.platform)).toHaveLength(1);
  });

  it('never repeats a redemption that sent no key', async () => {
    const proof = await claimedQr(await personOnPhone());
    expect((await promote(proof)).status).toBe(200);
    await freshBudget(proof.deviceId);
    expect(await promoteWithKey(proof, redemptionKey())).toMatchObject(INVALID);
    const [claim] = await getDb()
      .select({ keyHash: authSessions.redemptionKeyHash })
      .from(authSessions)
      .where(eq(authSessions.sessionToken, proof.sessionToken));
    expect(claim.keyHash).toBeNull();
  });

  it("repeats only within the claim's original ten minutes", async () => {
    const proof = await claimedQr(await personOnPhone());
    const key = redemptionKey();
    expect((await promoteWithKey(proof, key)).status).toBe(200);
    await getDb()
      .update(authSessions)
      .set({ consumedAt: new Date(Date.now() - PROMOTION_WINDOW_MS - 1000) })
      .where(eq(authSessions.sessionToken, proof.sessionToken));
    await freshBudget(proof.deviceId);
    expect(await promoteWithKey(proof, key)).toMatchObject(INVALID);
  });

  it('is refused once the account signed out of the device', async () => {
    const proof = await claimedQr(await personOnPhone());
    const key = redemptionKey();
    expect((await promoteWithKey(proof, key)).status).toBe(200);
    const [device] = await getDb()
      .select({ id: deviceSessions.id })
      .from(deviceSessions)
      .where(eq(deviceSessions.deviceId, proof.deviceId));
    await getDb()
      .update(deviceAccountContexts)
      .set({ revokedAt: new Date() })
      .where(eq(deviceAccountContexts.deviceSessionId, device.id));
    await freshBudget(proof.deviceId);
    expect(await promoteWithKey(proof, key)).toMatchObject(INVALID);
  });

  it('completes a redemption whose issuing failed after the proof was spent', async () => {
    const person = await personOnPhone();
    const proof = await claimedQr(person);
    const key = redemptionKey();
    // The proof spent, nothing issued: what a failure after the redemption's
    // transaction leaves.
    const spent = await redeemDeviceProof(proof, oxyosClient(), { redemptionKey: key });
    expect(spent.redemption.attempt).toBe(1);
    expect((await credentialsOf(proof.deviceId)).filter((row) => row.platform)).toHaveLength(0);
    expect(await promote(proof)).toMatchObject(INVALID);

    await freshBudget(proof.deviceId);
    const repeated = await promoteWithKey(proof, key);
    expect(repeated.status).toBe(200);
    expect(await mintsAppToken(proof.deviceId, repeated.body.deviceSecret as string)).toBe(200);
  });

  it('issues for the latest attempt only: one superseded while in flight issues nothing', async () => {
    const proof = await claimedQr(await personOnPhone());
    const key = redemptionKey();
    const client = oxyosClient();
    const platform = { platform: 'oxyos' as const, applicationId: oxyos.applicationId };
    // Deterministic, not a race: attempts 1 and 2 both pass the redemption's
    // transaction before either issues.
    const stale = await redeemDeviceProof(proof, client, { redemptionKey: key });
    const latest = await redeemDeviceProof(proof, client, { redemptionKey: key });
    expect([stale.redemption.attempt, latest.redemption.attempt]).toEqual([1, 2]);

    await expect(
      deviceSessionService.issuePlatformCredential(
        proof.deviceId,
        platform,
        undefined,
        stale.redemption,
      ),
    ).rejects.toThrow(/superseded/);
    expect((await credentialsOf(proof.deviceId)).filter((row) => row.platform)).toHaveLength(0);

    const secret = await deviceSessionService.issuePlatformCredential(
      proof.deviceId,
      platform,
      undefined,
      latest.redemption,
    );
    expect(secret).toBeTruthy();
    const platformRows = (await credentialsOf(proof.deviceId)).filter((row) => row.platform);
    expect(platformRows.map((row) => row.secretHash)).toEqual([sha256Hex(secret as string)]);
    const [claim] = await getDb()
      .select({ credentialId: authSessions.redemptionCredentialId })
      .from(authSessions)
      .where(eq(authSessions.sessionToken, proof.sessionToken));
    expect(claim.credentialId).toBe(platformRows[0].id);
  });

  it('leaves exactly one live platform credential after concurrent keyed redemptions', async () => {
    const person = await personOnPhone();
    const proof = await claimedQr(person);
    const key = redemptionKey();
    const outcomes = await Promise.all([
      promoteWithKey(proof, key),
      promoteWithKey(proof, key),
      promoteWithKey(proof, key),
    ]);
    const answered = outcomes.filter((outcome) => outcome.status === 200);
    expect(answered.length).toBeGreaterThanOrEqual(1);
    const platformRows = (await credentialsOf(proof.deviceId)).filter((row) => row.platform);
    expect(platformRows).toHaveLength(1);
    // The live one is one of the answers; every other answer's is dead.
    const secrets = answered.map((outcome) => outcome.body.deviceSecret as string);
    const live = secrets.filter((secret) => sha256Hex(secret) === platformRows[0].secretHash);
    expect(live).toHaveLength(1);
    expect(await mintsAppToken(proof.deviceId, live[0])).toBe(200);
    for (const dead of secrets.filter((secret) => secret !== live[0])) {
      expect(await mintsAppToken(proof.deviceId, dead)).toBe(401);
    }
    // Still one session for the account on the device.
    expect(await liveSessionsOf(person.id, proof.deviceId)).toHaveLength(1);
  });
});

describe('a platform that confirms (R8)', () => {
  const confirming = () => ({ platform: 'oxyos', clientId: oxyos.clientId, confirms: true });

  async function promoteConfirming(
    proof: { deviceId: string; deviceSecret: string },
    key?: string,
  ) {
    const device = { deviceId: proof.deviceId, deviceSecret: proof.deviceSecret };
    return post('/session/device/platform', {
      device,
      platformClient: confirming(),
      ...(key ? { redemptionKey: key } : {}),
    });
  }

  async function confirm(deviceId: string, deviceSecret: string) {
    return post('/session/device/platform/confirm', { deviceId, deviceSecret });
  }

  async function freshConfirmBudget(deviceId: string): Promise<void> {
    await clearFailures({ scope: 'device-platform-confirm:device', identifier: deviceId });
  }

  async function mintsToken(deviceId: string, deviceSecret: string): Promise<number> {
    return (await post('/session/device/token', { deviceId, deviceSecret })).status;
  }

  async function pendingOf(deviceId: string, deviceSecret: string) {
    const [row] = await getDb()
      .select({
        pendingUntil: deviceCredentials.pendingUntil,
        replacesCredentialId: deviceCredentials.replacesCredentialId,
      })
      .from(deviceCredentials)
      .innerJoin(deviceSessions, eq(deviceSessions.id, deviceCredentials.deviceSessionId))
      .where(
        and(
          eq(deviceSessions.deviceId, deviceId),
          eq(deviceCredentials.secretHash, sha256Hex(deviceSecret)),
        ),
      );
    return row;
  }

  async function expire(deviceId: string, deviceSecret: string) {
    const [device] = await getDb()
      .select({ id: deviceSessions.id })
      .from(deviceSessions)
      .where(eq(deviceSessions.deviceId, deviceId));
    await getDb()
      .update(deviceCredentials)
      .set({ pendingUntil: new Date(Date.now() - 1000) })
      .where(
        and(
          eq(deviceCredentials.deviceSessionId, device.id),
          eq(deviceCredentials.secretHash, sha256Hex(deviceSecret)),
        ),
      );
  }

  it("issues the QR's credential pending until the claim's window ends: it proves nothing until confirmed", async () => {
    const person = await personOnPhone();
    const proof = await claimedQr(person);
    const promoted = await promoteConfirming(proof, redemptionKey());
    expect(promoted.status).toBe(200);
    const secret = promoted.body.deviceSecret as string;

    const [claim] = await getDb()
      .select({ consumedAt: authSessions.consumedAt })
      .from(authSessions)
      .where(eq(authSessions.sessionToken, proof.sessionToken));
    const pending = await pendingOf(proof.deviceId, secret);
    expect(pending.pendingUntil?.getTime()).toBe(
      (claim.consumedAt as Date).getTime() + PROMOTION_WINDOW_MS,
    );
    // Nothing mints from it, and nothing takes it for the device's proof.
    expect(await mintsAppToken(proof.deviceId, secret)).toBe(401);
    expect(await mintsToken(proof.deviceId, secret)).toBe(401);
    expect(await deviceSessionService.getStateBySecret(proof.deviceId, secret)).toBeNull();
    expect(await deviceSessionService.readCredentialBySecret(proof.deviceId, secret)).toBeNull();

    const confirmed = await confirm(proof.deviceId, secret);
    expect(confirmed).toEqual({ status: 200, body: { confirmed: true } });
    expect((await pendingOf(proof.deviceId, secret)).pendingUntil).toBeNull();
    expect(await mintsAppToken(proof.deviceId, secret)).toBe(200);
    // Idempotent: the same answer for a credential already confirmed.
    expect(await confirm(proof.deviceId, secret)).toEqual(confirmed);
  });

  it('confirms nothing else, with one answer', async () => {
    const person = await personOnPhone();
    const proof = await claimedQr(person);
    const promoted = await promoteConfirming(proof, redemptionKey());
    const secret = promoted.body.deviceSecret as string;
    // An ordinary holder credential (the phone's QR sign-in elsewhere).
    const other = await claimedQr(await personOnPhone());
    const answers = [
      await confirm(proof.deviceId, `x${tag()}`),
      await confirm(`dev-${randomUUID()}`, secret),
      await confirm(other.deviceId, other.deviceSecret),
    ];
    await freshConfirmBudget(proof.deviceId);
    await expire(proof.deviceId, secret);
    answers.push(await confirm(proof.deviceId, secret));
    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(answer.body).toEqual(answers[0].body);
    }
    expect(answers[0].body).toMatchObject({ message: 'invalid_grant' });
  });

  it('takes the confirmation strictly', async () => {
    const answer = await post('/session/device/platform/confirm', {
      deviceId: 'd',
      deviceSecret: 's',
      platformClient: confirming(),
    });
    expect(answer.status).toBe(400);
  });

  it('forgets an expired pending credential, and the sweep signs out the device nothing holds', async () => {
    const person = await personOnPhone();
    const proof = await claimedQr(person);
    const promoted = await promoteConfirming(proof, redemptionKey());
    const secret = promoted.body.deviceSecret as string;
    expect(await liveSessionsOf(person.id, proof.deviceId)).toHaveLength(1);

    await expire(proof.deviceId, secret);
    expect(await mintsAppToken(proof.deviceId, secret)).toBe(401);
    await freshConfirmBudget(proof.deviceId);
    expect((await confirm(proof.deviceId, secret)).status).toBe(401);

    const swept = await deviceSessionService.sweepUnconfirmedPlatformCredentials();
    expect(swept.deleted).toBeGreaterThanOrEqual(1);
    expect(await credentialsOf(proof.deviceId)).toHaveLength(0);
    // The account is not left signed in on a device whose setup never finished.
    expect(await liveSessionsOf(person.id, proof.deviceId)).toHaveLength(0);
  });

  it('never signs out a device something still holds', async () => {
    const person = await personOnPhone();
    const proof = await claimedQr(person);
    const first = await promoteConfirming(proof, redemptionKey());
    expect((await confirm(proof.deviceId, first.body.deviceSecret as string)).status).toBe(200);
    // A pending credential beside the confirmed one (another setup's, say) expires.
    const pendingSecret = await deviceSessionService.issuePlatformCredential(
      proof.deviceId,
      { platform: 'oxyos', applicationId: oxyos.applicationId },
      undefined,
      undefined,
      new Date(Date.now() - 1000),
    );
    expect(pendingSecret).toBeTruthy();
    await deviceSessionService.sweepUnconfirmedPlatformCredentials();
    expect(await pendingOf(proof.deviceId, pendingSecret as string)).toBeUndefined();
    expect(await liveSessionsOf(person.id, proof.deviceId)).toHaveLength(1);
    expect(await mintsAppToken(proof.deviceId, first.body.deviceSecret as string)).toBe(200);
  });

  it("revokes a repeated redemption's previous credential, pending or not", async () => {
    const proof = await claimedQr(await personOnPhone());
    const key = redemptionKey();
    const lost = (await promoteConfirming(proof, key)).body.deviceSecret as string;
    const kept = (await promoteConfirming(proof, key)).body.deviceSecret as string;
    expect(kept).not.toBe(lost);
    expect((await confirm(proof.deviceId, lost)).status).toBe(401);
    expect((await confirm(proof.deviceId, kept)).status).toBe(200);
    expect(await mintsAppToken(proof.deviceId, kept)).toBe(200);
  });

  it("keeps the credential a platform's password sign-in presented until the new one is confirmed", async () => {
    // A machine's account, with its confirmed platform credential: its online
    // check signs in with the password again, presenting it, and rotates it.
    const username = `rot${tag()}`;
    const [row] = await getDb().insert(users).values({ username }).returning({ id: users.id });
    await storePassword(row.id, 'a long enough password');
    const signedIn = await post('/auth/signin/password', {
      identifier: username,
      password: 'a long enough password',
    });
    const holder = {
      deviceId: signedIn.body.deviceId as string,
      deviceSecret: signedIn.body.deviceSecret as string,
    };
    const platformSignIn = (device: typeof holder) =>
      post('/auth/signin/password', {
        identifier: username,
        password: 'a long enough password',
        device,
        platformClient: confirming(),
      });
    const first = await platformSignIn(holder);
    expect(first.status).toBe(200);
    const firstSecret = first.body.deviceSecret as string;
    const pending = await pendingOf(holder.deviceId, firstSecret);
    expect(pending.pendingUntil).not.toBeNull();
    expect(pending.replacesCredentialId).not.toBeNull();
    // Until confirmed, the credential it presented still works, and it does not.
    expect(await mintsToken(holder.deviceId, holder.deviceSecret)).toBe(200);
    expect(await mintsAppToken(holder.deviceId, firstSecret)).toBe(401);
    expect((await confirm(holder.deviceId, firstSecret)).status).toBe(200);
    expect(await mintsToken(holder.deviceId, holder.deviceSecret)).toBe(401);
    expect(await mintsAppToken(holder.deviceId, firstSecret)).toBe(200);

    // The rotation's answer is lost: the platform credential the machine holds keeps working.
    const rotated = await platformSignIn({ deviceId: holder.deviceId, deviceSecret: firstSecret });
    expect(rotated.status).toBe(200);
    const lost = rotated.body.deviceSecret as string;
    expect(await mintsAppToken(holder.deviceId, firstSecret)).toBe(200);
    await expire(holder.deviceId, lost);
    await deviceSessionService.sweepUnconfirmedPlatformCredentials();
    expect(await mintsAppToken(holder.deviceId, firstSecret)).toBe(200);
    expect(await liveSessionsOf(row.id, holder.deviceId)).toHaveLength(1);
  });

  it('issues as before R8 to a platform that does not confirm', async () => {
    const proof = await claimedQr(await personOnPhone());
    const promoted = await promote(proof);
    const secret = promoted.body.deviceSecret as string;
    expect((await pendingOf(proof.deviceId, secret)).pendingUntil).toBeNull();
    expect(await mintsAppToken(proof.deviceId, secret)).toBe(200);
  });
});

describe('the budgets count guesses, never a proof (R8)', () => {
  it('lets a repetition with its key through a device id locked by guesses', async () => {
    const proof = await claimedQr(await personOnPhone());
    const key = redemptionKey();
    expect((await promoteWithKey(proof, key)).status).toBe(200);
    const guesses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      guesses.push((await promote({ deviceId: proof.deviceId, deviceSecret: `x${tag()}` })).status);
    }
    expect(guesses).toEqual([401, 401, 401, 429]);
    // Locked against guesses, still answering the platform that holds both secrets.
    expect((await promoteWithKey(proof, key)).status).toBe(200);
    expect((await promoteWithKey(proof, key)).status).toBe(200);
    // And still refusing a wrong secret.
    const refused = await request(app)
      .post('/session/device/platform')
      .send({
        device: { deviceId: proof.deviceId, deviceSecret: `x${tag()}` },
        platformClient: { platform: 'oxyos', clientId: oxyos.clientId },
      });
    expect(refused.status).toBe(429);
    const wait = Number(refused.headers['retry-after']);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(600);
  });

  it("gives a proven redemption's device attempt back: successes do not count", async () => {
    const proof = await claimedQr(await personOnPhone());
    const statuses: number[] = [];
    statuses.push((await promote({ deviceId: proof.deviceId, deviceSecret: `x${tag()}` })).status);
    statuses.push((await promote({ deviceId: proof.deviceId, deviceSecret: `x${tag()}` })).status);
    statuses.push((await promote(proof)).status);
    statuses.push((await promote({ deviceId: proof.deviceId, deviceSecret: `x${tag()}` })).status);
    statuses.push((await promote({ deviceId: proof.deviceId, deviceSecret: `x${tag()}` })).status);
    // Two guesses, a redemption that gave its attempt back, a third guess, then locked.
    expect(statuses).toEqual([401, 401, 200, 401, 429]);
  });

  it('bounds a claim to ten redemptions, the first included', async () => {
    const proof = await claimedQr(await personOnPhone());
    const key = redemptionKey();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < MAX_REDEMPTION_ATTEMPTS + 1; attempt += 1) {
      statuses.push((await promoteWithKey(proof, key)).status);
    }
    expect(statuses.slice(0, MAX_REDEMPTION_ATTEMPTS).every((status) => status === 200)).toBe(true);
    expect(statuses[MAX_REDEMPTION_ATTEMPTS]).toBe(401);
  });

  it('counts refused confirmations, three to a device id in ten minutes', async () => {
    const unknown = `dev-${randomUUID()}`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push(
        (
          await post('/session/device/platform/confirm', {
            deviceId: unknown,
            deviceSecret: `x${tag()}`,
          })
        ).status,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  });
});

describe('the windows a known proof is told (R9)', () => {
  const confirming = () => ({ platform: 'oxyos', clientId: oxyos.clientId, confirms: true });

  async function claimWindowEnd(sessionToken: string): Promise<number> {
    const [row] = await getDb()
      .select({ consumedAt: authSessions.consumedAt })
      .from(authSessions)
      .where(eq(authSessions.sessionToken, sessionToken));
    return (row.consumedAt as Date).getTime() + PROMOTION_WINDOW_MS;
  }

  function windowOf(body: Body, field: 'redemptionWindow' | 'confirmWindow') {
    return body[field] as { expiresAt: string; expiresInSeconds: number } | undefined;
  }

  it("tells a 200 the claim's window and, to a platform that confirms, the confirmation's", async () => {
    const proof = await claimedQr(await personOnPhone());
    const device = { deviceId: proof.deviceId, deviceSecret: proof.deviceSecret };
    const answered = await post('/session/device/platform', {
      device,
      platformClient: confirming(),
      redemptionKey: redemptionKey(),
    });
    expect(answered.status).toBe(200);
    const end = await claimWindowEnd(proof.sessionToken);
    for (const field of ['redemptionWindow', 'confirmWindow'] as const) {
      const window = windowOf(answered.body, field);
      expect(window).toBeDefined();
      expect(Date.parse((window as { expiresAt: string }).expiresAt)).toBe(end);
      const seconds = (window as { expiresInSeconds: number }).expiresInSeconds;
      expect(Number.isInteger(seconds)).toBe(true);
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(PROMOTION_WINDOW_MS / 1000);
      expect(Math.abs(seconds - (end - Date.now()) / 1000)).toBeLessThanOrEqual(5);
    }
  });

  it('tells a platform that does not confirm no confirmation window', async () => {
    const proof = await claimedQr(await personOnPhone());
    const answered = await promote(proof);
    expect(answered.status).toBe(200);
    expect(windowOf(answered.body, 'redemptionWindow')).toBeDefined();
    expect(windowOf(answered.body, 'confirmWindow')).toBeUndefined();
  });

  it('tells a repetition the same end, counted down', async () => {
    const proof = await claimedQr(await personOnPhone());
    const key = redemptionKey();
    const first = await promoteWithKey(proof, key);
    expect(first.status).toBe(200);
    // Two minutes pass.
    await getDb()
      .update(authSessions)
      .set({
        consumedAt: new Date(
          (await claimWindowEnd(proof.sessionToken)) - PROMOTION_WINDOW_MS - 120_000,
        ),
      })
      .where(eq(authSessions.sessionToken, proof.sessionToken));
    const again = await promoteWithKey(proof, key);
    expect(again.status).toBe(200);
    const before = windowOf(first.body, 'redemptionWindow') as { expiresInSeconds: number };
    const after = windowOf(again.body, 'redemptionWindow') as {
      expiresAt: string;
      expiresInSeconds: number;
    };
    expect(Date.parse(after.expiresAt)).toBe(await claimWindowEnd(proof.sessionToken));
    expect(after.expiresInSeconds).toBeLessThanOrEqual(before.expiresInSeconds - 119);
  });

  it("tells a 429 of the account's budget the window beside its wait", async () => {
    const person = await personOnPhone();
    const proof = await claimedQr(person);
    for (let spent = 0; spent < 6; spent += 1) {
      await reserveAttempt({
        scope: 'device-platform:account',
        identifier: person.id,
        maxAttempts: 6,
        windowSeconds: 600,
      });
    }
    const limited = await request(app)
      .post('/session/device/platform')
      .send({
        device: { deviceId: proof.deviceId, deviceSecret: proof.deviceSecret },
        platformClient: { platform: 'oxyos', clientId: oxyos.clientId },
      });
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(600);
    const window = (limited.body as Body).redemptionWindow as {
      expiresAt: string;
      expiresInSeconds: number;
    };
    expect(Date.parse(window.expiresAt)).toBe(await claimWindowEnd(proof.sessionToken));
    expect(window.expiresInSeconds).toBeGreaterThan(0);
    // The proof was not spent: the budget is asked before.
    await clearFailures({ scope: 'device-platform:account', identifier: person.id });
    expect((await promote(proof)).status).toBe(200);
  });

  it('tells a proof that is not redeemable nothing: the one identical 401', async () => {
    const proof = await claimedQr(await personOnPhone());
    const wrong = await promote({ deviceId: proof.deviceId, deviceSecret: `x${tag()}` });
    const unknown = await promote({ deviceId: `dev-${randomUUID()}`, deviceSecret: `x${tag()}` });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body).not.toHaveProperty('redemptionWindow');
    expect(wrong.body).not.toHaveProperty('confirmWindow');
    // A spent proof repeated without its key, too.
    await freshBudget(proof.deviceId);
    expect((await promote(proof)).status).toBe(200);
    await freshBudget(proof.deviceId);
    const spent = await promote(proof);
    expect(spent.status).toBe(401);
    expect(spent.body).toEqual(unknown.body);
  });
});
