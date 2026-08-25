/**
 * WebAuthn authentication ceremony against a REAL Postgres.
 *
 * Covers login/options (username-first, decoy, usernameless) and login/verify: the
 * credential resolution by public id, the atomic challenge burn and its owner
 * binding, the signature counter-regression guard (including the
 * `newCounter === 0` NON-regression), and the assertion that a successful login
 * mints a session whose response shape is byte-identical to `POST /auth/verify`.
 *
 * Every assertion reads the STORED ROW rather than a mocked model's call shape —
 * the previous suite asserted on the `findOneAndUpdate` FILTER object, which
 * proved the query was built as expected and never that the challenge was
 * actually spent (or not).
 *
 * `@simplewebauthn/server` is mocked at the module boundary to drive the verify
 * RESULT — real assertion verification is NOT weakened (production calls the real
 * verifier). `session.service` / `deviceLogin.service` / `securityActivityService`
 * are collaborators, not the subject. The session response shape is NOT mocked.
 */

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';

const OXY_ORIGIN = 'https://accounts.oxy.so';

// The username-first decoy is keyed on DEVICE_ID_SALT (fail-closed if empty — see
// `decoyAllowCredentials`). Pin a fixed, non-empty salt so the decoy is
// deterministic under test and the count/length/transports assertions below are
// stable rather than dependent on the ambient environment.
process.env.DEVICE_ID_SALT = 'test-device-id-salt-for-webauthn-decoy-anti-enum';

/** The challenge BOTH the generated options and the signed clientData carry. */
let currentChallenge = '';
/** The credential id the assertion payload presents. */
let presentedCredentialId = '';

const mockGenerateAuthOptions = jest.fn();
const mockVerifyAuthentication = jest.fn();
const mockCreateSession = jest.fn();
const mockFinalizeDeviceLogin = jest.fn();
const mockLogSignIn = jest.fn();
const mockLogSuspicious = jest.fn();

jest.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: jest.fn(),
  verifyRegistrationResponse: jest.fn(),
  generateAuthenticationOptions: (...args: unknown[]) => mockGenerateAuthOptions(...args),
  verifyAuthenticationResponse: (...args: unknown[]) => mockVerifyAuthentication(...args),
}));

jest.mock('@simplewebauthn/server/helpers', () => ({
  decodeClientDataJSON: () => ({ origin: OXY_ORIGIN, challenge: currentChallenge, type: 'webauthn.get' }),
  isoUint8Array: { fromUTF8String: (s: string) => new TextEncoder().encode(s) },
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/authUtils', () => ({
  extractTokenFromRequest: () => undefined,
  decodeToken: () => null,
}));

jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { createSession: (...args: unknown[]) => mockCreateSession(...args) },
}));

jest.mock('../../services/deviceLogin.service', () => ({
  __esModule: true,
  finalizeDeviceLogin: (...args: unknown[]) => mockFinalizeDeviceLogin(...args),
}));

jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: {
    logSignIn: (...args: unknown[]) => mockLogSignIn(...args),
    logSuspiciousActivity: (...args: unknown[]) => mockLogSuspicious(...args),
  },
}));

jest.mock('../../utils/userCache', () => ({ __esModule: true, default: { invalidate: jest.fn() } }));

// `session.controller` (the real one, for `buildSessionAuthResponse`) imports the
// socket emitter from `server.ts`; loading that module would boot the app.
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { webauthnChallenges } from '../../db/schema/webauthnChallenges';
import { webauthnCredentials } from '../../db/schema/webauthnCredentials';
import webauthnRouter from '../webauthn';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function request(server: http.Server, method: string, path: string, payload?: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: body !== undefined
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
          : {},
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

/** Decoded byte length of a base64url credential id. */
function decodedByteLength(id: string): number {
  return Buffer.from(id, 'base64url').length;
}

/** A username unique to one test, and alphanumeric, so `usernameSchema` accepts it. */
function freshUsername(): string {
  return `wl${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** A base64url-ish credential id unique to one test. */
function freshCredentialId(): string {
  return `cred${randomUUID().replace(/-/g, '')}`;
}

/** A real account, optionally with one passkey. Returns both ids. */
async function accountWithPasskey(options?: {
  username?: string;
  counter?: number;
  transports?: string[];
  userVerified?: boolean;
  kind?: 'personal' | 'organization';
}): Promise<{ userId: string; username: string; credentialID: string }> {
  const username = options?.username ?? freshUsername();
  const [row] = await getDb().insert(users).values({ username, kind: options?.kind ?? 'personal' }).returning({ id: users.id });
  const credentialID = freshCredentialId();
  await getDb().insert(webauthnCredentials).values({
    userId: row.id,
    credentialID,
    credentialPublicKey: Buffer.from([1, 2, 3, 4]),
    counter: options?.counter ?? 5,
    transports: options?.transports ?? ['internal'],
    deviceType: 'multiDevice',
    backedUp: true,
    userVerified: options?.userVerified ?? false,
    name: 'Test Passkey',
  });
  return { userId: row.id, username, credentialID };
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

/** A minimal AuthenticationResponseJSON-shaped payload; the verifier is mocked. */
function authenticationResponse() {
  return {
    id: presentedCredentialId,
    rawId: presentedCredentialId,
    type: 'public-key',
    clientExtensionResults: {},
    response: { clientDataJSON: 'stub', authenticatorData: 'stub', signature: 'stub' },
  };
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
  currentChallenge = `auth-${randomUUID()}`;
  presentedCredentialId = '';

  mockGenerateAuthOptions.mockImplementation(async () => ({
    challenge: currentChallenge,
    allowCredentials: [],
    rpId: 'localhost',
  }));
  // The FLAT `sessions` row shape `session.service` returns post-port.
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
  mockFinalizeDeviceLogin.mockResolvedValue({ deviceSecret: 'device-secret-1' });
  mockLogSignIn.mockResolvedValue(undefined);
  mockLogSuspicious.mockResolvedValue(undefined);
  mockVerifyAuthentication.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 6, userVerified: true } });
});

interface AuthOptionsArg {
  allowCredentials: { id: string; transports?: string[] }[];
  userVerification?: string;
}

describe('POST /webauthn/login/options', () => {
  it('treats a managed account like an account with no directly usable passkey', async () => {
    const { username, credentialID } = await accountWithPasskey({ kind: 'organization' });

    const res = await request(server, 'POST', '/webauthn/login/options', { username });

    expect(res.status).toBe(200);
    const opts = mockGenerateAuthOptions.mock.calls[0][0] as AuthOptionsArg;
    expect(opts.allowCredentials.map((credential) => credential.id)).not.toContain(credentialID);
    expect((await storedChallenge(currentChallenge)).used).toBe(true);
  });

  it("username-first (KNOWN username with a passkey): returns that user's real allowCredentials and binds the challenge to the account", async () => {
    const { userId, username, credentialID } = await accountWithPasskey({ transports: ['usb', 'nfc'] });

    const res = await request(server, 'POST', '/webauthn/login/options', { username });

    expect(res.status).toBe(200);
    const opts = mockGenerateAuthOptions.mock.calls[0][0] as AuthOptionsArg;
    // The user's real credential id is surfaced so a non-discoverable hardware key
    // can be invoked by the browser.
    expect(opts.allowCredentials).toEqual([{ id: credentialID, transports: ['usb', 'nfc'] }]);
    expect(opts.userVerification).toBe('preferred');

    // The stored challenge is bound to the resolved account and is SPENDABLE.
    const stored = await storedChallenge(currentChallenge);
    expect(stored.type).toBe('authentication');
    expect(stored.userId).toBe(userId);
    expect(stored.used).toBe(false);
  });

  it('username-first (UNKNOWN username): returns a decoy allow-list of the same shape — never empty, no non-existence tell', async () => {
    const res = await request(server, 'POST', '/webauthn/login/options', { username: `ghost${randomUUID().replace(/-/g, '').slice(0, 15)}` });

    expect(res.status).toBe(200);
    const opts = mockGenerateAuthOptions.mock.calls[0][0] as AuthOptionsArg;
    // Non-empty and masked to 1 OR 2 entries (a real account with 1–2 passkeys must
    // be indistinguishable — a fixed count-of-1 would leak "≥2 passkeys" via count).
    expect(opts.allowCredentials.length).toBeGreaterThanOrEqual(1);
    expect(opts.allowCredentials.length).toBeLessThanOrEqual(2);
    for (const cred of opts.allowCredentials) {
      expect(typeof cred.id).toBe('string');
      // Realistic credential-id length (16–64 bytes), covering both short platform
      // passkeys and long roaming/hardware-key ids — no fixed tell-tale size.
      expect(decodedByteLength(cred.id)).toBeGreaterThanOrEqual(16);
      expect(decodedByteLength(cred.id)).toBeLessThanOrEqual(64);
      // transports is either a real-looking array or omitted entirely (like real
      // credentials that advertise none) — never some other shape.
      if (cred.transports !== undefined) {
        expect(Array.isArray(cred.transports)).toBe(true);
        expect(cred.transports.length).toBeGreaterThan(0);
      }
    }
    if (opts.allowCredentials.length === 2) {
      expect(opts.allowCredentials[0].id).not.toBe(opts.allowCredentials[1].id);
    }

    // A challenge row IS stored (same write as the found path, so no timing tell) —
    // but already spent, which is what makes it unsatisfiable now that
    // `webauthn_challenges.user_id` carries a real foreign key and can no longer
    // hold a throwaway id that maps to no account.
    const stored = await storedChallenge(currentChallenge);
    expect(stored).toBeDefined();
    expect(stored.type).toBe('authentication');
    expect(stored.userId).toBeNull();
    expect(stored.used).toBe(true);
  });

  it('username-first (KNOWN account with NO passkey): returns a decoy, not an empty allow-list', async () => {
    // A real account that simply has not enrolled a passkey must look identical to
    // an unknown username — otherwise the empty allow-list would leak "exists".
    const username = freshUsername();
    await getDb().insert(users).values({ username });

    const res = await request(server, 'POST', '/webauthn/login/options', { username });

    expect(res.status).toBe(200);
    const opts = mockGenerateAuthOptions.mock.calls[0][0] as AuthOptionsArg;
    expect(opts.allowCredentials.length).toBeGreaterThanOrEqual(1);
    expect(opts.allowCredentials.length).toBeLessThanOrEqual(2);
    // Same unsatisfiable challenge as the unknown-username case.
    const stored = await storedChallenge(currentChallenge);
    expect(stored.userId).toBeNull();
    expect(stored.used).toBe(true);
  });

  it('the decoy COUNT is masked (not always 1): across a spread of usernames both 1- and 2-entry decoys appear', async () => {
    // A fixed count-of-1 decoy made `count === 2` a clean "this public username has
    // ≥2 passkeys" oracle. The count is now a deterministic 1 OR 2 keyed on the salt,
    // so surveying enough usernames must surface BOTH lengths.
    const observedCounts = new Set<number>();
    for (let i = 0; i < 16; i += 1) {
      currentChallenge = `auth-${randomUUID()}`;
      await request(server, 'POST', '/webauthn/login/options', { username: `probe${i}` });
    }
    for (const call of mockGenerateAuthOptions.mock.calls) {
      observedCounts.add((call[0] as AuthOptionsArg).allowCredentials.length);
    }
    // Deterministic under the fixed test salt: probe0..15 yield both 1 and 2.
    expect(observedCounts.has(1)).toBe(true);
    expect(observedCounts.has(2)).toBe(true);
  });

  it('the decoy sometimes OMITS transports (deterministically) so [{id}] vs [{id,transports}] is not a tell', async () => {
    let sawOmitted = false;
    let sawPresent = false;
    for (let i = 0; i < 30 && !(sawOmitted && sawPresent); i += 1) {
      currentChallenge = `auth-${randomUUID()}`;
      await request(server, 'POST', '/webauthn/login/options', { username: `shape${i}` });
    }
    for (const call of mockGenerateAuthOptions.mock.calls) {
      for (const cred of (call[0] as AuthOptionsArg).allowCredentials) {
        if (cred.transports === undefined) sawOmitted = true;
        else sawPresent = true;
      }
    }
    expect(sawOmitted).toBe(true);
    expect(sawPresent).toBe(true);
  });

  it('fails closed (500) when DEVICE_ID_SALT is empty — never emits an attacker-computable decoy', async () => {
    // An empty salt would make the decoy precomputable, defeating anti-enumeration.
    const original = process.env.DEVICE_ID_SALT;
    delete process.env.DEVICE_ID_SALT;
    try {
      const res = await request(server, 'POST', '/webauthn/login/options', { username: 'ghostuser' });
      expect(res.status).toBe(500);
      // No challenge is stored on the fail-closed path.
      expect(await storedChallenge(currentChallenge)).toBeUndefined();
    } finally {
      process.env.DEVICE_ID_SALT = original;
    }
  });

  it('the decoy is DETERMINISTIC: the same unknown username yields the same decoy id across requests', async () => {
    const username = `ghost${randomUUID().replace(/-/g, '').slice(0, 15)}`;
    await request(server, 'POST', '/webauthn/login/options', { username });
    currentChallenge = `auth-${randomUUID()}`;
    await request(server, 'POST', '/webauthn/login/options', { username });

    const first = (mockGenerateAuthOptions.mock.calls[0][0] as AuthOptionsArg).allowCredentials[0].id;
    const second = (mockGenerateAuthOptions.mock.calls[1][0] as AuthOptionsArg).allowCredentials[0].id;
    // Stable across polls (a per-request-random decoy would itself be the tell).
    expect(second).toBe(first);
  });

  it('usernameless (discoverable): empty allowCredentials and an unbound, spendable challenge', async () => {
    const res = await request(server, 'POST', '/webauthn/login/options', {});

    expect(res.status).toBe(200);
    const opts = mockGenerateAuthOptions.mock.calls[0][0] as AuthOptionsArg;
    expect(opts.allowCredentials).toHaveLength(0);
    const stored = await storedChallenge(currentChallenge);
    expect(stored.userId).toBeNull();
    // Unlike a decoy, a real discoverable challenge is spendable.
    expect(stored.used).toBe(false);
  });
});

describe('POST /webauthn/login/verify', () => {
  it('never mints a direct session for a managed account credential', async () => {
    const { credentialID } = await accountWithPasskey({ kind: 'organization' });
    presentedCredentialId = credentialID;
    await request(server, 'POST', '/webauthn/login/options', {});

    const res = await request(server, 'POST', '/webauthn/login/verify', { response: authenticationResponse() });

    expect(res.status).toBe(401);
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockFinalizeDeviceLogin).not.toHaveBeenCalled();
  });

  it('mints a session with the byte-identical AuthSuccess shape of /auth/verify', async () => {
    const { userId, username, credentialID } = await accountWithPasskey({ counter: 5 });
    presentedCredentialId = credentialID;
    await request(server, 'POST', '/webauthn/login/options', { username });

    const res = await request(server, 'POST', '/webauthn/login/verify', { response: authenticationResponse() });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'deviceId', 'deviceSecret', 'expiresAt', 'sessionId', 'user']);
    expect(res.body.deviceSecret).toBe('device-secret-1');
    expect(res.body.accessToken).toBe('access-token-1');
    expect(res.body.user).toMatchObject({ id: userId, username });

    // Counter advanced and PERSISTED; assurance level refreshed (stored false → true).
    const credential = await storedCredential(credentialID);
    expect(credential.counter).toBe(6);
    expect(credential.userVerified).toBe(true);
    expect(credential.lastUsedAt).toBeInstanceOf(Date);
    // The challenge is spent.
    expect((await storedChallenge(currentChallenge)).used).toBe(true);
    // The mint ran against the FLAT session row.
    expect(mockLogSignIn.mock.calls[0][3]).toEqual({
      deviceName: 'Test Device',
      deviceType: 'web',
      platform: 'web',
    });
    // Possession-only assertions are accepted — UV is not required at verify.
    const verifyArg = mockVerifyAuthentication.mock.calls[0][0] as { requireUserVerification: boolean };
    expect(verifyArg.requireUserVerification).toBe(false);
  });

  it('feeds the verifier the STORED public key, counter and transports', async () => {
    const { username, credentialID } = await accountWithPasskey({ counter: 11, transports: ['usb'] });
    presentedCredentialId = credentialID;
    await request(server, 'POST', '/webauthn/login/options', { username });
    mockVerifyAuthentication.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 12, userVerified: true } });

    await request(server, 'POST', '/webauthn/login/verify', { response: authenticationResponse() });

    const arg = mockVerifyAuthentication.mock.calls[0][0] as {
      credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] };
    };
    expect(arg.credential.id).toBe(credentialID);
    expect(arg.credential.counter).toBe(11);
    expect(arg.credential.transports).toEqual(['usb']);
    expect(Buffer.from(arg.credential.publicKey)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('accepts a discoverable (usernameless) assertion from any owner', async () => {
    const { userId, credentialID } = await accountWithPasskey();
    presentedCredentialId = credentialID;
    await request(server, 'POST', '/webauthn/login/options', {});

    const res = await request(server, 'POST', '/webauthn/login/verify', { response: authenticationResponse() });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: userId });
  });

  it('accepts a possession-only (userVerified:false) assertion and records the flag', async () => {
    // A stored credential that had verified previously authenticates presence-only
    // now (e.g. a U2F key with no PIN) → still succeeds, flag refreshed to false.
    const { username, credentialID } = await accountWithPasskey({ userVerified: true });
    presentedCredentialId = credentialID;
    await request(server, 'POST', '/webauthn/login/options', { username });
    mockVerifyAuthentication.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 6, userVerified: false } });

    const res = await request(server, 'POST', '/webauthn/login/verify', { response: authenticationResponse() });

    expect(res.status).toBe(200);
    expect((await storedCredential(credentialID)).userVerified).toBe(false);
  });

  it('accepts a platform authenticator that never increments (newCounter === 0, stored 0)', async () => {
    const { username, credentialID } = await accountWithPasskey({ counter: 0 });
    presentedCredentialId = credentialID;
    await request(server, 'POST', '/webauthn/login/options', { username });
    mockVerifyAuthentication.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 0, userVerified: true } });

    const res = await request(server, 'POST', '/webauthn/login/verify', { response: authenticationResponse() });

    expect(res.status).toBe(200);
    expect((await storedCredential(credentialID)).counter).toBe(0);
    expect(mockLogSuspicious).not.toHaveBeenCalled();
  });

  it('rejects a genuine counter regression (401 + security log, stored counter untouched, no session)', async () => {
    const { username, credentialID } = await accountWithPasskey({ counter: 10 });
    presentedCredentialId = credentialID;
    await request(server, 'POST', '/webauthn/login/options', { username });
    mockVerifyAuthentication.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 4 } });

    const res = await request(server, 'POST', '/webauthn/login/verify', { response: authenticationResponse() });

    expect(res.status).toBe(401);
    expect(mockLogSuspicious).toHaveBeenCalledTimes(1);
    expect(mockCreateSession).not.toHaveBeenCalled();
    const credential = await storedCredential(credentialID);
    expect(credential.counter).toBe(10);
    expect(credential.lastUsedAt).toBeNull();
  });

  it('rejects an unknown credential with 401', async () => {
    presentedCredentialId = freshCredentialId();
    const res = await request(server, 'POST', '/webauthn/login/verify', { response: authenticationResponse() });
    expect(res.status).toBe(401);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('rejects a non-string credential id with 400 before any lookup or burn', async () => {
    const { username, credentialID } = await accountWithPasskey();
    presentedCredentialId = credentialID;
    await request(server, 'POST', '/webauthn/login/options', { username });

    const malicious = authenticationResponse();
    // A crafted operator object instead of the base64url id.
    (malicious as { id: unknown }).id = { $ne: null };
    const res = await request(server, 'POST', '/webauthn/login/verify', { response: malicious });

    expect(res.status).toBe(400);
    // Rejected BEFORE anything could be spent.
    expect((await storedChallenge(currentChallenge)).used).toBe(false);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('rejects a burned challenge with 401 — the same assertion cannot be replayed', async () => {
    const { username, credentialID } = await accountWithPasskey({ counter: 5 });
    presentedCredentialId = credentialID;
    await request(server, 'POST', '/webauthn/login/options', { username });

    const first = await request(server, 'POST', '/webauthn/login/verify', { response: authenticationResponse() });
    expect(first.status).toBe(200);

    mockVerifyAuthentication.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 7, userVerified: true } });
    const replay = await request(server, 'POST', '/webauthn/login/verify', { response: authenticationResponse() });

    expect(replay.status).toBe(401);
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    // The replay never advanced the counter.
    expect((await storedCredential(credentialID)).counter).toBe(6);
  });

  it('rejects an EXPIRED challenge with 401 (the read filters the deadline; it does not wait for the sweep)', async () => {
    const { username, credentialID } = await accountWithPasskey();
    presentedCredentialId = credentialID;
    await request(server, 'POST', '/webauthn/login/options', { username });
    await getDb()
      .update(webauthnChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(webauthnChallenges.challenge, currentChallenge));

    const res = await request(server, 'POST', '/webauthn/login/verify', { response: authenticationResponse() });

    expect(res.status).toBe(401);
    expect(mockVerifyAuthentication).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    // Rejected, not consumed.
    expect((await storedChallenge(currentChallenge)).used).toBe(false);
  });

  it('rejects a credential whose owner does NOT match a username-bound challenge (cross-user)', async () => {
    // The challenge is issued for user A (who has a passkey); user B presents theirs.
    const victim = await accountWithPasskey();
    const attacker = await accountWithPasskey();
    await request(server, 'POST', '/webauthn/login/options', { username: victim.username });

    presentedCredentialId = attacker.credentialID;
    const res = await request(server, 'POST', '/webauthn/login/verify', { response: authenticationResponse() });

    expect(res.status).toBe(401);
    expect(mockVerifyAuthentication).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    // A's challenge is untouched — A can still complete their own ceremony.
    expect((await storedChallenge(currentChallenge)).used).toBe(false);
  });

  it('a DECOY challenge cannot be redeemed by ANY real passkey — the account-existence oracle stays closed', async () => {
    // This is the property the pre-burned decoy exists for. If the decoy challenge
    // were merely stored unbound (`user_id = null`), the discoverable-fallback burn
    // would accept it from ANY owner: an attacker holding their own passkey would
    // get 200 for an unknown/passkey-less username and 401 for a real account with
    // passkeys, which is exactly the enumeration answer the decoy hides.
    const attacker = await accountWithPasskey();
    await request(server, 'POST', '/webauthn/login/options', {
      username: `ghost${randomUUID().replace(/-/g, '').slice(0, 15)}`,
    });

    presentedCredentialId = attacker.credentialID;
    const res = await request(server, 'POST', '/webauthn/login/verify', { response: authenticationResponse() });

    expect(res.status).toBe(401);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('rejects when the assertion does not verify', async () => {
    const { username, credentialID } = await accountWithPasskey();
    presentedCredentialId = credentialID;
    await request(server, 'POST', '/webauthn/login/options', { username });
    mockVerifyAuthentication.mockResolvedValue({ verified: false, authenticationInfo: { newCounter: 6 } });

    const res = await request(server, 'POST', '/webauthn/login/verify', { response: authenticationResponse() });

    expect(res.status).toBe(401);
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect((await storedCredential(credentialID)).counter).toBe(5);
  });
});
