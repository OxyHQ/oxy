/**
 * The browser bridge END TO END (ADR 0029 D2) — register → join-code → join,
 * then a Commons QR claim and an email/password sign-in that carry the device proof —
 * over the REAL `session.service`, `deviceSession.service` and
 * `deviceJoin.service`, against a real Postgres.
 *
 * The story it pins, in one browser:
 *   1. auth.oxy.so's bridge registers the browser's device (no account yet).
 *   2. App A joins it through a one-use, PKCE-bound code and holds its own
 *      credential, which mints `no_active_session` until someone signs in.
 *   3. A person signs in in app A (Commons QR, or email/password in the dialog) with the
 *      device proof: the account lands on THAT device.
 *   4. App B joins later and is signed in to the same account without a sign-in.
 *   5. Signing the account out in B signs A (and auth.oxy.so) out too.
 */

import express from 'express';
import type { Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';

// The whole subject is which device the minted token names, so the real signer.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

let authenticatedUser: { _id: string; username?: string } | null = null;

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
jest.mock('../../services/loginLockout.service', () => ({
  isLockedOut: jest.fn().mockResolvedValue({ locked: false, attempts: 0 }),
  reserveAttempt: jest.fn().mockResolvedValue({ locked: false, attempts: 1 }),
  recordFailure: jest.fn().mockResolvedValue({ locked: false, attempts: 1 }),
  clearFailures: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn().mockResolvedValue(undefined), logSignIn: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: jest.fn(),
  emitAuthSessionProgress: jest.fn(),
}));
jest.mock('../../utils/socket', () => ({
  broadcastSessionAccountsChanged: jest.fn(),
  broadcastDeviceState: jest.fn(),
}));
// The real `session.controller` (for `buildSessionAuthResponse`) imports the
// socket emitter from `server.ts`; loading that module would boot the app.
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../controllers/session.controller', () => ({
  ...jest.requireActual('../../controllers/session.controller'),
  SessionController: {
    register: jest.fn(),
    requestChallenge: jest.fn(),
    verifyChallenge: jest.fn(),
    getUserByPublicKey: jest.fn(),
  },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { authSessions } from '../../db/schema/authSessions';
import { deviceJoinCodes } from '../../db/schema/deviceJoinCodes';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { rateLimit } from '../../middleware/rateLimiter';
import deviceSessionService from '../../services/deviceSession.service';
import sessionCache from '../../utils/sessionCache';
import userCache from '../../utils/userCache';
import authRouter from '../auth';
import sessionDeviceRouter from '../sessionDevice';
import { mintSignInSession } from '../../services/signInSession.service';

const AUTH_ORIGIN = 'https://auth.oxy.so';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

let app: express.Express;

interface OfficialApp {
  clientId: string;
  redirectUri: string;
  origin: string;
  id: string;
}

async function user(): Promise<{ id: string; username: string }> {
  const username = `u${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const [row] = await getDb().insert(users).values({ username }).returning({ id: users.id });
  return { id: row.id, username };
}

async function registeredApp(official: boolean): Promise<OfficialApp> {
  const owner = await user();
  const origin = `https://app-${randomUUID().slice(0, 8)}.example`;
  const redirectUri = `${origin}/`;
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      ...(official ? { type: 'first_party' as const, isOfficial: true } : {}),
      redirectUris: [redirectUri],
      ownerAccountId: owner.id,
    })
    .returning({ id: applications.id });
  const clientId = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  await getDb().insert(applicationCredentials).values({
    applicationId: row.id,
    name: 'client',
    type: 'public',
    environment: 'production',
    publicKey: clientId,
  });
  return { clientId, redirectUri, origin, id: row.id };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function registerOnAuth(): Promise<{ deviceId: string; deviceSecret: string }> {
  const res = await request(app).post('/session/device/register').set('origin', AUTH_ORIGIN).send({});
  expect(res.status).toBe(201);
  return res.body.data;
}

async function joinCode(auth: { deviceId: string; deviceSecret: string }, target: OfficialApp, challenge: string) {
  return request(app)
    .post('/session/device/join-code')
    .set('origin', AUTH_ORIGIN)
    .send({
      ...auth,
      clientId: target.clientId,
      redirectUri: target.redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });
}

function redeem(target: OfficialApp, code: string, verifier: string, origin = target.origin) {
  return request(app)
    .post('/session/device/join')
    .set('origin', origin)
    .send({ code, codeVerifier: verifier, clientId: target.clientId, redirectUri: target.redirectUri });
}

/** The whole bridge run for one app: a code from auth.oxy.so, redeemed by the app. */
async function bridge(auth: { deviceId: string; deviceSecret: string }, target: OfficialApp) {
  const { verifier, challenge } = pkce();
  const issued = await joinCode(auth, target, challenge);
  expect(issued.status).toBe(200);
  expect(issued.body.data.expiresIn).toBe(60);
  const joined = await redeem(target, issued.body.data.code, verifier);
  expect(joined.status).toBe(200);
  return joined.body.data as { deviceId: string; deviceSecret: string };
}

function mint(credential: { deviceId: string; deviceSecret: string }) {
  return request(app).post('/session/device/token').send(credential);
}

/** A Commons QR sign-in for `target`, approved by `signer`, claimed with an optional device proof. */
async function qrSignIn(
  target: OfficialApp,
  signer: { id: string; username: string },
  device?: { deviceId: string; deviceSecret: string },
) {
  const sessionToken = `at_${randomUUID().replace(/-/g, '')}`;
  await getDb().insert(authSessions).values({
    sessionToken,
    authorizeCode: randomUUID().replace(/-/g, ''),
    applicationId: target.id,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    status: 'pending',
  });
  authenticatedUser = { _id: signer.id, username: signer.username };
  const approved = await request(app)
    .post(`/auth/session/authorize/${sessionToken}`)
    .set('user-agent', USER_AGENT)
    .send({});
  expect(approved.status).toBe(200);
  authenticatedUser = null;
  const claimed = await request(app)
    .post('/auth/session/claim')
    .set('user-agent', USER_AGENT)
    .send({ sessionToken, ...(device ? { device } : {}) });
  expect(claimed.status).toBe(200);
  return claimed.body.data as { accessToken: string; deviceId: string; deviceSecret?: string; sessionId: string };
}

function tokenDeviceId(accessToken: string): unknown {
  const jwt = jest.requireActual<typeof import('jsonwebtoken')>('jsonwebtoken');
  return (jwt.decode(accessToken) as Record<string, unknown>).deviceId;
}

beforeAll(async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  delete process.env.AUTH_WEB_ORIGIN;
  app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use('/session/device', sessionDeviceRouter);
  // The first factor itself is `signIn.test.ts`'s; this is the session tail every sign-in shares.
  app.post('/test/signin-mint', rateLimit({ prefix: 'rl:test:signin-mint:', windowMs: 60_000, max: 100 }), (req: Request, res: Response, next) => {
    const { account, device } = req.body as { account: { id: string; username: string }; device?: unknown };
    mintSignInSession(req, { id: account.id, username: account.username, avatar: null }, {
      ...(device ? { device: device as { deviceId: string; deviceSecret: string } } : {}),
    })
      .then((result) => res.json(result))
      .catch(next);
  });
  app.use(errorHandler);
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  sessionCache.clear();
  userCache.clear();
  authenticatedUser = null;
});

describe('POST /session/device/register', () => {
  it('creates an empty device with one credential, for auth.oxy.so only', async () => {
    const auth = await registerOnAuth();
    const minted = await mint(auth);
    expect(minted.status).toBe(401);
    expect(minted.body.error).toBe('no_active_session');

    expect((await request(app).post('/session/device/register').send({})).status).toBe(403);
    const foreign = await request(app).post('/session/device/register').set('origin', 'https://evil.example').send({});
    expect(foreign.status).toBe(403);
    // Loopback is the auth web origin in every environment.
    expect((await request(app).post('/session/device/register').set('origin', 'http://localhost:3000').send({})).status).toBe(201);
  });
});

describe('POST /session/device/join-code and /join', () => {
  it('issues codes only to auth.oxy.so, for a proven device, an official app and its exact redirect URI', async () => {
    const auth = await registerOnAuth();
    const official = await registeredApp(true);
    const thirdParty = await registeredApp(false);
    const { challenge } = pkce();

    const fromApp = await request(app)
      .post('/session/device/join-code')
      .set('origin', official.origin)
      .send({ ...auth, clientId: official.clientId, redirectUri: official.redirectUri, codeChallenge: challenge, codeChallengeMethod: 'S256' });
    expect(fromApp.status).toBe(403);

    const wrongSecret = await joinCode({ deviceId: auth.deviceId, deviceSecret: 'nope' }, official, challenge);
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.body.error).toBe('invalid_device_secret');

    const notOfficial = await joinCode(auth, thirdParty, challenge);
    expect(notOfficial.status).toBe(400);
    expect(notOfficial.body.error).toBe('invalid_client');

    const unregistered = await joinCode(auth, { ...official, redirectUri: `${official.origin}/other` }, challenge);
    expect(unregistered.status).toBe(400);
    expect(unregistered.body.error).toBe('invalid_redirect_uri');

    const plain = await request(app)
      .post('/session/device/join-code')
      .set('origin', AUTH_ORIGIN)
      .send({ ...auth, clientId: official.clientId, redirectUri: official.redirectUri, codeChallenge: challenge, codeChallengeMethod: 'plain' });
    expect(plain.status).toBe(400);
  });

  it('a code is one-use, PKCE-bound, app-bound, origin-bound and short-lived', async () => {
    const auth = await registerOnAuth();
    const target = await registeredApp(true);
    const other = await registeredApp(true);

    // Wrong verifier: refused, and the code is spent by the attempt.
    let { verifier, challenge } = pkce();
    let code = (await joinCode(auth, target, challenge)).body.data.code as string;
    expect((await redeem(target, code, pkce().verifier)).status).toBe(400);
    expect((await redeem(target, code, verifier)).status).toBe(400);

    // Replay.
    ({ verifier, challenge } = pkce());
    code = (await joinCode(auth, target, challenge)).body.data.code as string;
    const first = await redeem(target, code, verifier);
    expect(first.status).toBe(200);
    expect(first.body.data.deviceId).toBe(auth.deviceId);
    const replay = await redeem(target, code, verifier);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');

    // Another application cannot redeem it.
    ({ verifier, challenge } = pkce());
    code = (await joinCode(auth, target, challenge)).body.data.code as string;
    const stolen = await request(app)
      .post('/session/device/join')
      .set('origin', other.origin)
      .send({ code, codeVerifier: verifier, clientId: other.clientId, redirectUri: target.redirectUri });
    expect(stolen.status).toBe(403);
    const stolenNoOrigin = await request(app)
      .post('/session/device/join')
      .send({ code, codeVerifier: verifier, clientId: other.clientId, redirectUri: target.redirectUri });
    expect(stolenNoOrigin.status).toBe(400);
    expect(stolenNoOrigin.body.error).toBe('invalid_client');

    // A browser caller must be the redirect URI's own origin.
    ({ verifier, challenge } = pkce());
    code = (await joinCode(auth, target, challenge)).body.data.code as string;
    expect((await redeem(target, code, verifier, 'https://evil.example')).status).toBe(403);
    expect((await redeem(target, code, verifier)).status).toBe(200);

    // Expired.
    ({ verifier, challenge } = pkce());
    code = (await joinCode(auth, target, challenge)).body.data.code as string;
    await getDb()
      .update(deviceJoinCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deviceJoinCodes.codeHash, createHash('sha256').update(code).digest('hex')));
    expect((await redeem(target, code, verifier)).status).toBe(400);
  });
});

describe('one browser, one session through the bridge', () => {
  it('QR sign-in in A lands on the shared device; B joins signed in; sign-out in B signs A out', async () => {
    const appA = await registeredApp(true);
    const appB = await registeredApp(true);
    const alice = await user();

    const auth = await registerOnAuth();
    const inA = await bridge(auth, appA);
    expect(inA.deviceId).toBe(auth.deviceId);
    expect(inA.deviceSecret).not.toBe(auth.deviceSecret);
    // Joined, nobody signed in yet: the credential is kept and mints nothing.
    const empty = await mint(inA);
    expect(empty.status).toBe(401);
    expect(empty.body.error).toBe('no_active_session');

    const claimed = await qrSignIn(appA, alice, inA);
    expect(claimed.deviceId).toBe(auth.deviceId);
    expect(tokenDeviceId(claimed.accessToken)).toBe(auth.deviceId);

    for (const holder of [inA, auth]) {
      const res = await mint(holder);
      expect(res.status).toBe(200);
      expect(res.body.data.state.activeAccountId).toBe(alice.id);
      expect(tokenDeviceId(res.body.data.accessToken)).toBe(auth.deviceId);
    }

    // App B: the bridge, then the ordinary mint — signed in without a sign-in.
    const inB = await bridge(auth, appB);
    const inBMint = await mint(inB);
    expect(inBMint.status).toBe(200);
    expect(inBMint.body.data.state.activeAccountId).toBe(alice.id);

    // Sign-out in B: the device ends with nobody signed in, so every holder goes.
    await deviceSessionService.signout(inB.deviceId, { accountId: alice.id });
    for (const holder of [inA, inB, auth]) {
      const res = await mint(holder);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_device_secret');
    }
  });

  it('a sign-in with the device proof adds the account to that device', async () => {
    const appA = await registeredApp(true);
    const alice = await user();
    const bob = await user();
    const auth = await registerOnAuth();
    const inA = await bridge(auth, appA);

    await qrSignIn(appA, alice, inA);
    const signedIn = await request(app)
      .post('/test/signin-mint')
      .set('user-agent', USER_AGENT)
      .send({ account: bob, device: auth });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.deviceId).toBe(auth.deviceId);

    const res = await mint(inA);
    expect(res.status).toBe(200);
    const accounts = (res.body.data.state.accounts as { accountId: string }[]).map((a) => a.accountId).sort();
    expect(accounts).toEqual([alice.id, bob.id].sort());
    // Add-only: a second sign-in never steals the device's active account.
    expect(res.body.data.state.activeAccountId).toBe(alice.id);
  });

  it('an invalid proof never fails a sign-in; it just keeps its own device', async () => {
    const appA = await registeredApp(true);
    const alice = await user();
    const auth = await registerOnAuth();
    const forged = { deviceId: auth.deviceId, deviceSecret: 'forged' };

    const claimed = await qrSignIn(appA, alice, forged);
    expect(claimed.deviceId).not.toBe(auth.deviceId);

    const signedIn = await request(app)
      .post('/test/signin-mint')
      .set('user-agent', USER_AGENT)
      .send({ account: alice, device: forged });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.deviceId).not.toBe(auth.deviceId);

    expect((await mint(auth)).body.error).toBe('no_active_session');
  });

  it('a third-party claim keeps its isolated device even with a valid proof', async () => {
    const thirdParty = await registeredApp(false);
    const alice = await user();
    const auth = await registerOnAuth();

    const claimed = await qrSignIn(thirdParty, alice, auth);
    expect(claimed.deviceId).not.toBe(auth.deviceId);
    expect((await mint(auth)).body.error).toBe('no_active_session');
  });
});
