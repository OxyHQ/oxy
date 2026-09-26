/**
 * WebAuthn registration ceremony against a REAL Postgres.
 *
 * Every assertion below reads the STORED ROW — `users`, `webauthn_credentials`,
 * `user_auth_methods`, `webauthn_challenges` — rather than a mocked model's call
 * shape. The previous suite mocked the Mongoose models and asserted on the
 * `findOneAndUpdate` filter object, which proved the query was BUILT as expected
 * and never that the row ended up correct; the rollback case in particular
 * asserted only that a compensating delete was CALLED.
 *
 * `@simplewebauthn/server` is mocked at the MODULE BOUNDARY so the test can drive
 * the verification RESULT — production still calls the real verifier; nothing
 * about real attestation verification is weakened here. `session.service`,
 * `deviceLogin.service` and `securityActivityService` are mocked because they are
 * collaborators (each ported in its own file), not the subject. The session
 * response shape is NOT mocked: the real `buildSessionAuthResponse` runs, so the
 * `AuthSuccess` wire shape is genuinely locked.
 *
 * Every test mints its own username and credential id, so no assertion depends on
 * a table being empty — the suite shares one database with the rest of the run.
 */

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';

/** auth.oxy.so: the one origin that creates and recovers accounts (ADR 0029). */
const AUTH_ORIGIN = 'https://auth.oxy.so';

// ---- controllable mock state ----------------------------------------------
/** The bearer the route resolves; null = unauthenticated (signup lane). */
let mockBearerUserId: string | null = null;
/** The challenge BOTH the generated options and the signed clientData carry. */
let currentChallenge = '';
/** The credential id the mocked verifier reports for this ceremony. */
let currentCredentialId = '';
let mockRegisterUserVerified = true;
/** The origin the signed clientData reports. */
let mockClientOrigin = AUTH_ORIGIN;

const mockGenerateRegistration = jest.fn();
const mockVerifyRegistration = jest.fn();
const mockCreateSession = jest.fn();
const mockGetAccessToken = jest.fn();
const mockFinalizeDeviceLogin = jest.fn();
const mockLogSignIn = jest.fn();
const mockInvalidate = jest.fn();

jest.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: (...args: unknown[]) => mockGenerateRegistration(...args),
  verifyRegistrationResponse: (...args: unknown[]) => mockVerifyRegistration(...args),
  generateAuthenticationOptions: jest.fn(),
  verifyAuthenticationResponse: jest.fn(),
}));

jest.mock('@simplewebauthn/server/helpers', () => ({
  decodeClientDataJSON: () => ({ origin: mockClientOrigin, challenge: currentChallenge, type: 'webauthn.create' }),
  isoUint8Array: { fromUTF8String: (s: string) => new TextEncoder().encode(s) },
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/authUtils', () => ({
  extractTokenFromRequest: (req: { headers: Record<string, string> }) =>
    req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined,
  decodeToken: () => (mockBearerUserId ? { userId: mockBearerUserId, type: 'access' } : null),
}));

jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
  },
}));

jest.mock('../../services/deviceLogin.service', () => ({
  __esModule: true,
  finalizeDeviceLogin: (...args: unknown[]) => mockFinalizeDeviceLogin(...args),
}));

jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logSignIn: (...args: unknown[]) => mockLogSignIn(...args), logSuspiciousActivity: jest.fn() },
}));

jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: (...args: unknown[]) => mockInvalidate(...args) },
}));

// `session.controller` (the real one, for `buildSessionAuthResponse`) imports the
// socket emitter from `server.ts`; loading that module would boot the app.
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));

import { createHash } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { emailVerifications } from '../../db/schema/emailVerifications';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import { webauthnChallenges } from '../../db/schema/webauthnChallenges';
import { webauthnCredentials } from '../../db/schema/webauthnCredentials';
import { userTotp } from '../../db/schema/userTotp';
import webauthnRouter from '../webauthn';
import { hashEmail } from '../../utils/contactHash';
import { randomBytes } from 'node:crypto';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function request(
  server: http.Server,
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          ...(body !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A username unique to one test, and alphanumeric, so `usernameSchema` accepts it. */
function freshUsername(): string {
  return `wa${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** A base64url-ish credential id unique to one test. */
function freshCredentialId(): string {
  return `cred${randomUUID().replace(/-/g, '')}`;
}

/** A real `users` row — every `user_id` in this suite carries a foreign key. */
async function account(
  username?: string,
  kind: 'personal' | 'organization' = 'personal',
  extra: { email?: string; publicKey?: string } = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ ...(username === undefined ? {} : { username }), kind, ...extra })
    .returning({ id: users.id });
  return row.id;
}

function freshEmail(): string {
  return `${randomUUID()}@example.com`;
}

/**
 * A CONFIRMED verification and its live ticket, written the way
 * `POST /auth/email/verify/confirm` leaves them.
 */
async function confirmedTicket(purpose: 'signup' | 'recovery', email: string, userId: string | null = null): Promise<string> {
  const ticket = randomBytes(32).toString('base64url');
  await getDb().insert(emailVerifications).values({
    purpose,
    emailHash: hashEmail(email),
    userId,
    codeHash: 'ab'.repeat(32),
    attempts: 1,
    confirmedAt: new Date(),
    ticketHash: createHash('sha256').update(ticket).digest('hex'),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  return ticket;
}

async function storedTicket(ticket: string) {
  const [row] = await getDb()
    .select()
    .from(emailVerifications)
    .where(eq(emailVerifications.ticketHash, createHash('sha256').update(ticket).digest('hex')))
    .limit(1);
  return row;
}

/** The stored challenge row, read straight from Postgres. */
async function storedChallenge(challenge: string) {
  const [row] = await getDb()
    .select()
    .from(webauthnChallenges)
    .where(eq(webauthnChallenges.challenge, challenge))
    .limit(1);
  return row;
}

/** The stored credential row for a public credential id. */
async function storedCredential(credentialID: string) {
  const [row] = await getDb()
    .select()
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.credentialID, credentialID))
    .limit(1);
  return row;
}

/** The stored auth-method rows of an account. */
async function storedAuthMethods(userId: string) {
  return getDb()
    .select()
    .from(userAuthMethods)
    .where(eq(userAuthMethods.userId, userId));
}

/** The stored account for a username, matched the way the route matches it. */
async function storedUserByUsername(username: string) {
  const [row] = await getDb()
    .select({ id: users.id, username: users.username, email: users.email, publicKey: users.publicKey })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return row;
}

/** A minimal RegistrationResponseJSON-shaped payload; the verifier is mocked. */
function registrationResponse() {
  return {
    id: currentCredentialId,
    rawId: currentCredentialId,
    type: 'public-key',
    clientExtensionResults: {},
    response: { clientDataJSON: 'stub', attestationObject: 'stub' },
  };
}

/** A real registration challenge shape: 32 random bytes, base64url. */
function realChallenge(): string {
  return randomBytes(32).toString('base64url');
}

/** A sign-up body for the current ceremony: the username, and its confirmed recovery email. */
async function signupBody(username: string, extras: Record<string, unknown> = {}) {
  const email = freshEmail();
  return { username, email, emailTicket: await confirmedTicket('signup', email), response: registrationResponse(), ...extras };
}

let server: http.Server;

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/webauthn', webauthnRouter);
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
  mockBearerUserId = null;
  mockRegisterUserVerified = true;
  mockClientOrigin = AUTH_ORIGIN;
  currentChallenge = realChallenge();
  currentCredentialId = freshCredentialId();

  mockGenerateRegistration.mockImplementation(async () => ({
    challenge: currentChallenge,
    rp: { name: 'Oxy', id: 'localhost' },
    user: { id: 'x', name: 'x', displayName: '' },
    pubKeyCredParams: [],
    excludeCredentials: [],
  }));
  mockVerifyRegistration.mockImplementation(async () => ({
    verified: true,
    registrationInfo: {
      credential: {
        id: currentCredentialId,
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        transports: ['internal'],
      },
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      userVerified: mockRegisterUserVerified,
    },
  }));
  // The FLAT `sessions` row shape `session.service` returns post-port: device
  // fields are columns, never a nested `deviceInfo` subdocument.
  mockCreateSession.mockResolvedValue({
    sessionId: `sess-${randomUUID()}`,
    deviceId: `dev-${randomUUID()}`,
    accessToken: 'access-token-1',
    expiresAt: new Date('2026-08-01T00:00:00.000Z'),
    createdAt: new Date(),
    deviceName: 'Test Device',
    deviceType: 'web',
    platform: 'web',
  });
  mockGetAccessToken.mockResolvedValue({
    accessToken: 'access-token-1',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  });
  mockFinalizeDeviceLogin.mockResolvedValue({ deviceSecret: 'device-secret-1' });
  mockLogSignIn.mockResolvedValue(undefined);
});

describe('POST /webauthn/register/options', () => {
  it('signup branch: stores an UNBOUND, unspent registration challenge', async () => {
    const username = freshUsername();
    const res = await request(server, 'POST', '/webauthn/register/options', { username });

    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe(currentChallenge);

    const stored = await storedChallenge(currentChallenge);
    expect(stored.type).toBe('registration');
    // A signup challenge belongs to no account yet.
    expect(stored.userId).toBeNull();
    expect(stored.used).toBe(false);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // No account was created at options time.
    expect(await storedUserByUsername(username)).toBeUndefined();
  });

  it('rejects a taken username with 409 (no challenge stored)', async () => {
    const username = freshUsername();
    await account(username);

    const res = await request(server, 'POST', '/webauthn/register/options', { username });

    expect(res.status).toBe(409);
    expect(await storedChallenge(currentChallenge)).toBeUndefined();
  });

  it('rejects a username that differs only by CASE (the lookup is case-insensitive)', async () => {
    const username = freshUsername();
    await account(username);

    const res = await request(server, 'POST', '/webauthn/register/options', {
      username: username.toUpperCase(),
    });

    expect(res.status).toBe(409);
    expect(await storedChallenge(currentChallenge)).toBeUndefined();
  });

  it('requires a username in the signup branch', async () => {
    const res = await request(server, 'POST', '/webauthn/register/options', {});
    expect(res.status).toBe(400);
  });

  it('linking branch: binds the challenge to the bearer and excludes their existing passkeys', async () => {
    const userId = await account(freshUsername());
    const existingCredentialId = freshCredentialId();
    await getDb().insert(webauthnCredentials).values({
      userId,
      credentialID: existingCredentialId,
      credentialPublicKey: Buffer.from([9, 9, 9]),
      counter: 3,
      transports: ['usb', 'nfc'],
      deviceType: 'singleDevice',
      backedUp: false,
      userVerified: true,
      name: 'Old Key',
    });
    mockBearerUserId = userId;

    const res = await request(
      server,
      'POST',
      '/webauthn/register/options',
      {},
      { authorization: 'Bearer valid-token' },
    );

    expect(res.status).toBe(200);
    const options = mockGenerateRegistration.mock.calls[0][0] as {
      excludeCredentials: { id: string; transports?: string[] }[];
    };
    // Read back out of the real table, transports included.
    expect(options.excludeCredentials).toEqual([
      { id: existingCredentialId, transports: ['usb', 'nfc'] },
    ]);

    const stored = await storedChallenge(currentChallenge);
    expect(stored.userId).toBe(userId);
    expect(stored.used).toBe(false);
  });

  it('rejects linking a passkey to a managed account bearer', async () => {
    mockBearerUserId = await account(freshUsername(), 'organization');

    const res = await request(
      server,
      'POST',
      '/webauthn/register/options',
      {},
      { authorization: 'Bearer valid-token' },
    );

    expect(res.status).toBe(403);
    expect(await storedChallenge(currentChallenge)).toBeUndefined();
  });

  it('offers residentKey:preferred + UV:preferred and does NOT pin authenticatorAttachment (roaming/hardware keys can enrol)', async () => {
    const res = await request(server, 'POST', '/webauthn/register/options', { username: freshUsername() });
    expect(res.status).toBe(200);
    const opts = mockGenerateRegistration.mock.calls[0][0] as {
      authenticatorSelection: {
        residentKey?: string;
        userVerification?: string;
        authenticatorAttachment?: string;
      };
    };
    // `preferred` (not `required`) is what lets a Google Titan / roaming key with no
    // resident-key support still register a non-discoverable credential.
    expect(opts.authenticatorSelection.residentKey).toBe('preferred');
    // UV is `preferred` (owner possession-credential policy): UV-capable keys still
    // verify; a UV-incapable U2F key falls back to presence-only.
    expect(opts.authenticatorSelection.userVerification).toBe('preferred');
    // Attachment is unpinned so both platform and cross-platform authenticators show.
    expect(opts.authenticatorSelection.authenticatorAttachment).toBeUndefined();
  });
});

describe('POST /webauthn/register/verify — signup branch', () => {
  it('refuses a sign-up without a confirmed recovery email, before spending the challenge (ADR 0029 D3)', async () => {
    const username = freshUsername();
    await request(server, 'POST', '/webauthn/register/options', { username });

    const res = await request(server, 'POST', '/webauthn/register/verify', { username, response: registrationResponse() });

    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toBe('EMAIL_TICKET_REQUIRED');
    expect(await storedUserByUsername(username)).toBeUndefined();
    expect((await storedChallenge(currentChallenge)).used).toBe(false);
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
  });

  it('refuses a sign-up ceremony from any origin but auth.oxy.so', async () => {
    mockClientOrigin = 'https://accounts.oxy.so';
    const username = freshUsername();
    await request(server, 'POST', '/webauthn/register/options', { username });

    const res = await request(server, 'POST', '/webauthn/register/verify', await signupBody(username));

    expect(res.status).toBe(400);
    expect(await storedUserByUsername(username)).toBeUndefined();
    expect((await storedChallenge(currentChallenge)).used).toBe(false);
  });

  it('creates account + credential + webauthn auth method in one go and returns the AuthSuccess mint shape', async () => {
    const username = freshUsername();
    await request(server, 'POST', '/webauthn/register/options', { username });

    const body = await signupBody(username, { deviceName: 'My Laptop' });
    const res = await request(server, 'POST', '/webauthn/register/verify', body);

    expect(res.status).toBe(200);
    // Byte-identical shape to POST /auth/verify: buildSessionAuthResponse + deviceSecret.
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'deviceId', 'deviceSecret', 'expiresAt', 'sessionId', 'user']);
    expect(res.body.deviceSecret).toBe('device-secret-1');
    expect(res.body.accessToken).toBe('access-token-1');

    const created = await storedUserByUsername(username);
    expect(created).toBeDefined();
    expect(res.body.user).toMatchObject({ id: created.id, username });
    // A passkey account: its confirmed recovery email, and no key.
    expect(created.email).toBe(body.email);
    expect(created.publicKey).toBeNull();
    // The email's ticket is spent with the account.
    expect((await storedTicket(body.emailTicket)).usedAt).toBeInstanceOf(Date);

    // The credential row carries the ceremony's real values.
    const credential = await storedCredential(currentCredentialId);
    expect(credential.userId).toBe(created.id);
    expect(credential.name).toBe('My Laptop');
    expect(credential.counter).toBe(0);
    expect(credential.deviceType).toBe('multiDevice');
    expect(credential.backedUp).toBe(true);
    // Assurance level captured at enrollment (this ceremony did real UV).
    expect(credential.userVerified).toBe(true);
    expect(credential.transports).toEqual(['internal']);
    // bytea round-trips as the exact COSE bytes the verifier reported.
    expect(Buffer.from(credential.credentialPublicKey)).toEqual(Buffer.from([1, 2, 3, 4]));

    // The auth method is a ROW in the child table, not an array entry.
    const methods = await storedAuthMethods(created.id);
    expect(methods.map((m) => m.type)).toEqual(['webauthn']);
    const passkeyMethod = methods.find((m) => m.type === 'webauthn');
    expect(passkeyMethod?.methodCredentialId).toBe(currentCredentialId);
    expect(passkeyMethod?.methodName).toBe('My Laptop');
    expect(passkeyMethod?.methodPublicKey).toBeNull();

    // The challenge is spent.
    expect((await storedChallenge(currentChallenge)).used).toBe(true);

    // The mint ran against the FLAT session row (a `deviceInfo` regression would
    // silently drop these three).
    expect(mockLogSignIn).toHaveBeenCalledTimes(1);
    expect(mockLogSignIn.mock.calls[0][3]).toEqual({
      deviceName: 'My Laptop',
      deviceType: 'web',
      platform: 'web',
    });
    // Possession-only credentials are accepted — UV is not required at verify.
    const verifyArg = mockVerifyRegistration.mock.calls[0][0] as { requireUserVerification: boolean };
    expect(verifyArg.requireUserVerification).toBe(false);
  });

  it('creates NOTHING with a ticket confirmed for another email', async () => {
    const username = freshUsername();
    await request(server, 'POST', '/webauthn/register/options', { username });
    const body = await signupBody(username);

    const res = await request(server, 'POST', '/webauthn/register/verify', { ...body, email: freshEmail() });

    expect(res.status).toBe(401);
    expect((res.body as { error?: string }).error).toBe('EMAIL_TICKET_INVALID');
    expect(await storedUserByUsername(username)).toBeUndefined();
    expect(await storedCredential(currentCredentialId)).toBeUndefined();
    // The ticket stays spendable by its own email.
    expect((await storedTicket(body.emailTicket)).usedAt).toBeNull();
  });

  it('creates NOTHING with a recovery ticket in place of a sign-up one', async () => {
    const username = freshUsername();
    const email = freshEmail();
    await request(server, 'POST', '/webauthn/register/options', { username });

    const res = await request(server, 'POST', '/webauthn/register/verify', {
      username,
      email,
      emailTicket: await confirmedTicket('recovery', email),
      response: registrationResponse(),
    });

    expect(res.status).toBe(401);
    expect(await storedUserByUsername(username)).toBeUndefined();
  });

  it('spends a sign-up ticket once: a second account cannot be made with it', async () => {
    const username = freshUsername();
    await request(server, 'POST', '/webauthn/register/options', { username });
    const body = await signupBody(username);
    expect((await request(server, 'POST', '/webauthn/register/verify', body)).status).toBe(200);

    currentChallenge = realChallenge();
    currentCredentialId = freshCredentialId();
    const second = freshUsername();
    await request(server, 'POST', '/webauthn/register/options', { username: second });
    const res = await request(server, 'POST', '/webauthn/register/verify', {
      ...body,
      username: second,
      response: registrationResponse(),
    });

    expect(res.status).toBe(401);
    expect(await storedUserByUsername(second)).toBeUndefined();
  });

  it('answers 409 for an email another account took meanwhile, and leaves the ticket unspent', async () => {
    const username = freshUsername();
    await request(server, 'POST', '/webauthn/register/options', { username });
    const body = await signupBody(username);
    await account(freshUsername(), 'personal', { email: body.email.toUpperCase() });

    const res = await request(server, 'POST', '/webauthn/register/verify', body);

    expect(res.status).toBe(409);
    expect(await storedUserByUsername(username)).toBeUndefined();
    expect((await storedTicket(body.emailTicket)).usedAt).toBeNull();
  });

  it('defaults the credential name when the client sends none', async () => {
    const username = freshUsername();
    await request(server, 'POST', '/webauthn/register/options', { username });
    await request(server, 'POST', '/webauthn/register/verify', await signupBody(username));

    expect((await storedCredential(currentCredentialId)).name).toBe('Passkey');
  });

  it('records userVerified:false for a possession-only (no-UV) enrollment and still creates the account', async () => {
    mockRegisterUserVerified = false;
    const username = freshUsername();
    await request(server, 'POST', '/webauthn/register/options', { username });

    const res = await request(server, 'POST', '/webauthn/register/verify', await signupBody(username, { deviceName: 'Titan Key' }));

    expect(res.status).toBe(200);
    // Presence-only assertion → recorded as an unverified (possession-only) credential.
    expect((await storedCredential(currentCredentialId)).userVerified).toBe(false);
    expect(await storedUserByUsername(username)).toBeDefined();
  });

  it('leaves NO account behind when the credential collides — the whole signup rolls back (409)', async () => {
    // Someone else already registered this exact passkey.
    const otherUserId = await account(freshUsername());
    await getDb().insert(webauthnCredentials).values({
      userId: otherUserId,
      credentialID: currentCredentialId,
      credentialPublicKey: Buffer.from([7]),
      counter: 1,
      deviceType: 'singleDevice',
      backedUp: false,
      userVerified: false,
      name: 'Theirs',
    });

    const username = freshUsername();
    await request(server, 'POST', '/webauthn/register/options', { username });
    const res = await request(server, 'POST', '/webauthn/register/verify', await signupBody(username));

    expect(res.status).toBe(409);
    // The row itself is gone — not "a compensating delete was called".
    expect(await storedUserByUsername(username)).toBeUndefined();
    // The pre-existing credential still belongs to its original owner.
    expect((await storedCredential(currentCredentialId)).userId).toBe(otherUserId);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('rejects a burned challenge with 401 — a replay creates no second account', async () => {
    const username = freshUsername();
    await request(server, 'POST', '/webauthn/register/options', { username });
    const first = await request(server, 'POST', '/webauthn/register/verify', await signupBody(username));
    expect(first.status).toBe(200);

    // Replay the SAME (now burned) challenge with a different username.
    const replayUsername = freshUsername();
    currentCredentialId = freshCredentialId();
    const replay = await request(server, 'POST', '/webauthn/register/verify', await signupBody(replayUsername));

    expect(replay.status).toBe(401);
    expect(await storedUserByUsername(replayUsername)).toBeUndefined();
    expect(await storedCredential(currentCredentialId)).toBeUndefined();
  });

  it('rejects an EXPIRED challenge with 401 (the read filters the deadline; it does not wait for the sweep)', async () => {
    const username = freshUsername();
    await request(server, 'POST', '/webauthn/register/options', { username });
    // Age the row past its deadline — the sweep has not run, so only the read-side
    // predicate can reject it.
    await getDb()
      .update(webauthnChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(webauthnChallenges.challenge, currentChallenge));

    const res = await request(server, 'POST', '/webauthn/register/verify', await signupBody(username));

    expect(res.status).toBe(401);
    expect(await storedUserByUsername(username)).toBeUndefined();
    // Still unspent: an expired challenge is rejected, not consumed.
    expect((await storedChallenge(currentChallenge)).used).toBe(false);
  });

  it('rejects an unknown challenge with 401 (no account created)', async () => {
    const username = freshUsername();
    // No options call at all — nothing was ever stored for this challenge.
    const res = await request(server, 'POST', '/webauthn/register/verify', await signupBody(username));

    expect(res.status).toBe(401);
    expect(await storedUserByUsername(username)).toBeUndefined();
  });

  it('rejects when the attestation does not verify (challenge already burned, nothing written)', async () => {
    mockVerifyRegistration.mockResolvedValue({ verified: false });
    const username = freshUsername();
    await request(server, 'POST', '/webauthn/register/options', { username });

    const res = await request(server, 'POST', '/webauthn/register/verify', await signupBody(username));

    expect(res.status).toBe(400);
    expect(await storedUserByUsername(username)).toBeUndefined();
    expect(await storedCredential(currentCredentialId)).toBeUndefined();
  });

  it('refuses a signup challenge that was minted for a LINKING flow', async () => {
    // Mint a challenge bound to an account…
    const userId = await account(freshUsername());
    mockBearerUserId = userId;
    mockClientOrigin = 'https://accounts.oxy.so';
    await request(server, 'POST', '/webauthn/register/options', {}, { authorization: 'Bearer valid-token' });

    // …then try to spend it on the unauthenticated signup lane.
    mockBearerUserId = null;
    mockClientOrigin = AUTH_ORIGIN;
    const username = freshUsername();
    const res = await request(server, 'POST', '/webauthn/register/verify', await signupBody(username));

    expect(res.status).toBe(401);
    expect(await storedUserByUsername(username)).toBeUndefined();
    // The linking challenge is untouched — it can still be spent by its own flow.
    expect((await storedChallenge(currentChallenge)).used).toBe(false);
  });
});

describe('POST /webauthn/register/verify — linking branch', () => {
  it('rejects a managed account even if a linking challenge already exists', async () => {
    const managedId = await account(freshUsername(), 'organization');
    mockBearerUserId = managedId;
    await getDb().insert(webauthnChallenges).values({
      challenge: currentChallenge,
      type: 'registration',
      userId: managedId,
      expiresAt: new Date(Date.now() + 60_000),
      used: false,
    });

    const res = await request(
      server,
      'POST',
      '/webauthn/register/verify',
      { response: registrationResponse() },
      { authorization: 'Bearer valid-token' },
    );

    expect(res.status).toBe(403);
    expect(await storedCredential(currentCredentialId)).toBeUndefined();
    expect(await storedAuthMethods(managedId)).toHaveLength(0);
  });

  it('links the passkey to the bearer account (credential row + auth-method row + cache invalidate)', async () => {
    const userId = await account(freshUsername());
    mockBearerUserId = userId;
    mockClientOrigin = 'https://accounts.oxy.so';
    await request(server, 'POST', '/webauthn/register/options', {}, { authorization: 'Bearer valid-token' });

    const res = await request(
      server,
      'POST',
      '/webauthn/register/verify',
      { deviceName: 'YubiKey', response: registrationResponse() },
      { authorization: 'Bearer valid-token' },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const credential = await storedCredential(currentCredentialId);
    expect(credential.userId).toBe(userId);
    expect(credential.name).toBe('YubiKey');
    // The linked credential records its enrollment assurance level.
    expect(credential.userVerified).toBe(true);

    const methods = await storedAuthMethods(userId);
    expect(methods).toHaveLength(1);
    expect(methods[0].type).toBe('webauthn');
    expect(methods[0].methodCredentialId).toBe(currentCredentialId);

    expect(mockInvalidate).toHaveBeenCalledWith(userId);
    // Linking does NOT mint a new session.
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('refuses a linking challenge minted for a DIFFERENT account (cross-account redirect)', async () => {
    const victimId = await account(freshUsername());
    const attackerId = await account(freshUsername());

    // The challenge is minted for the victim…
    mockBearerUserId = victimId;
    await request(server, 'POST', '/webauthn/register/options', {}, { authorization: 'Bearer valid-token' });

    // …and presented by the attacker.
    mockBearerUserId = attackerId;
    const res = await request(
      server,
      'POST',
      '/webauthn/register/verify',
      { response: registrationResponse() },
      { authorization: 'Bearer valid-token' },
    );

    expect(res.status).toBe(401);
    expect(await storedCredential(currentCredentialId)).toBeUndefined();
    expect(await storedAuthMethods(attackerId)).toHaveLength(0);
    // The victim's challenge is still unspent.
    expect((await storedChallenge(currentChallenge)).used).toBe(false);
  });

  it('rejects a duplicate passkey on link with 409 and writes no auth-method row', async () => {
    const otherUserId = await account(freshUsername());
    await getDb().insert(webauthnCredentials).values({
      userId: otherUserId,
      credentialID: currentCredentialId,
      credentialPublicKey: Buffer.from([7]),
      counter: 1,
      deviceType: 'singleDevice',
      backedUp: false,
      userVerified: false,
      name: 'Theirs',
    });

    const userId = await account(freshUsername());
    mockBearerUserId = userId;
    await request(server, 'POST', '/webauthn/register/options', {}, { authorization: 'Bearer valid-token' });

    const res = await request(
      server,
      'POST',
      '/webauthn/register/verify',
      { response: registrationResponse() },
      { authorization: 'Bearer valid-token' },
    );

    expect(res.status).toBe(409);
    expect(await storedAuthMethods(userId)).toHaveLength(0);
    expect((await storedCredential(currentCredentialId)).userId).toBe(otherUserId);
  });
});

describe('recovery: a new passkey for the account a recovery code was confirmed for (ADR 0029 D3)', () => {
  async function recoverable() {
    const email = freshEmail();
    const username = freshUsername();
    const userId = await account(username, 'personal', { email });
    return { userId, username, email, ticket: await confirmedTicket('recovery', email, userId) };
  }

  it('options: binds the challenge to the account and excludes its passkeys, without spending the ticket', async () => {
    const { userId, username, ticket } = await recoverable();
    const oldCredentialId = freshCredentialId();
    await getDb().insert(webauthnCredentials).values({
      userId,
      credentialID: oldCredentialId,
      credentialPublicKey: Buffer.from([9]),
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
      userVerified: true,
      name: 'Lost phone',
    });

    const res = await request(server, 'POST', '/webauthn/register/options', { recoveryTicket: ticket });

    expect(res.status).toBe(200);
    const options = mockGenerateRegistration.mock.calls[0][0] as { userName: string; excludeCredentials: { id: string }[] };
    expect(options.userName).toBe(username);
    expect(options.excludeCredentials.map((credential) => credential.id)).toEqual([oldCredentialId]);
    expect((await storedChallenge(currentChallenge)).userId).toBe(userId);
    expect((await storedTicket(ticket)).usedAt).toBeNull();
  });

  it('options: refuses an unknown ticket', async () => {
    const res = await request(server, 'POST', '/webauthn/register/options', { recoveryTicket: randomBytes(32).toString('base64url') });
    expect(res.status).toBe(401);
    expect(await storedChallenge(currentChallenge)).toBeUndefined();
  });

  it('verify: adds the passkey, spends the ticket and signs in', async () => {
    const { userId, username, ticket } = await recoverable();
    await request(server, 'POST', '/webauthn/register/options', { recoveryTicket: ticket });

    const res = await request(server, 'POST', '/webauthn/register/verify', {
      recoveryTicket: ticket,
      deviceName: 'New laptop',
      response: registrationResponse(),
    });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: userId, username });
    expect(res.body.accessToken).toBe('access-token-1');
    const credential = await storedCredential(currentCredentialId);
    expect(credential.userId).toBe(userId);
    expect(credential.name).toBe('New laptop');
    expect((await storedAuthMethods(userId)).map((method) => method.type)).toEqual(['webauthn']);
    expect((await storedTicket(ticket)).usedAt).toBeInstanceOf(Date);
    expect(mockInvalidate).toHaveBeenCalledWith(userId);
  });

  it('verify: an account with an authenticator gets the second-factor challenge, never a session', async () => {
    // (A ticket for such an account already needed the authenticator's code at
    // confirm; this is the second, independent gate on the session itself.)
    const { userId, ticket } = await recoverable();
    await getDb().insert(userTotp).values({ userId, secretCiphertext: 'v1.x.x.x', enabledAt: new Date() });
    await request(server, 'POST', '/webauthn/register/options', { recoveryTicket: ticket });

    const res = await request(server, 'POST', '/webauthn/register/verify', { recoveryTicket: ticket, response: registrationResponse() });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['challengeId', 'expiresAt', 'secondFactorRequired']);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('verify: a spent ticket recovers nothing a second time', async () => {
    const { ticket } = await recoverable();
    await request(server, 'POST', '/webauthn/register/options', { recoveryTicket: ticket });
    const first = await request(server, 'POST', '/webauthn/register/verify', { recoveryTicket: ticket, response: registrationResponse() });
    expect(first.status).toBe(200);

    currentChallenge = realChallenge();
    currentCredentialId = freshCredentialId();
    const res = await request(server, 'POST', '/webauthn/register/verify', { recoveryTicket: ticket, response: registrationResponse() });

    expect(res.status).toBe(401);
    expect(await storedCredential(currentCredentialId)).toBeUndefined();
  });

  it('verify: refuses a challenge minted for another account', async () => {
    const victim = await recoverable();
    const other = await recoverable();
    await request(server, 'POST', '/webauthn/register/options', { recoveryTicket: other.ticket });

    const res = await request(server, 'POST', '/webauthn/register/verify', { recoveryTicket: victim.ticket, response: registrationResponse() });

    expect(res.status).toBe(401);
    expect(await storedCredential(currentCredentialId)).toBeUndefined();
    expect((await storedTicket(victim.ticket)).usedAt).toBeNull();
  });

  it('verify: an account that linked Commons meanwhile recovers in Commons, not here', async () => {
    const { userId, ticket } = await recoverable();
    await request(server, 'POST', '/webauthn/register/options', { recoveryTicket: ticket });
    await getDb().update(users).set({ publicKey: `04${'a'.repeat(128)}` }).where(eq(users.id, userId));

    const res = await request(server, 'POST', '/webauthn/register/verify', { recoveryTicket: ticket, response: registrationResponse() });

    expect(res.status).toBe(401);
    expect(await storedCredential(currentCredentialId)).toBeUndefined();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('verify: a deleted account kept for its records is not recovered', async () => {
    const { userId, ticket } = await recoverable();
    await request(server, 'POST', '/webauthn/register/options', { recoveryTicket: ticket });
    await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, userId));

    const res = await request(server, 'POST', '/webauthn/register/verify', { recoveryTicket: ticket, response: registrationResponse() });

    expect(res.status).toBe(401);
    expect(await storedCredential(currentCredentialId)).toBeUndefined();
  });

  it('verify: refuses a recovery ceremony from any origin but auth.oxy.so', async () => {
    const { ticket } = await recoverable();
    await request(server, 'POST', '/webauthn/register/options', { recoveryTicket: ticket });
    mockClientOrigin = 'https://mention.oxy.so';

    const res = await request(server, 'POST', '/webauthn/register/verify', { recoveryTicket: ticket, response: registrationResponse() });

    expect(res.status).toBe(400);
    expect((await storedTicket(ticket)).usedAt).toBeNull();
  });
});
