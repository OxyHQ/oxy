/**
 * Key-rotation route tests (b3 Feature 3 — atomic key rotation + last-credential
 * replacement), against a REAL Postgres.
 *
 * Proves the security invariants of `POST /auth/rotate/challenge` +
 * `POST /auth/rotate/complete`:
 *  - `oldPublicKey` is ALWAYS derived from the user row, never the request (a
 *    client-supplied `oldPublicKey` is ignored; a signature from the wrong key
 *    is rejected);
 *  - the `rotate_key` challenge is purpose-scoped (a signin challenge can NEVER
 *    complete a rotation), single-use, and expiry-checked on the READ (not left
 *    to the sweep);
 *  - rotation is an atomic REPLACE — the SAME `user_auth_methods` row is updated
 *    in place, so the account never passes through zero auth methods;
 *  - `newPublicKey` already registered elsewhere is rejected (409);
 *  - `userCache.invalidate` fires, the stale `identity_backups` row is gone, and
 *    the derived DID reflects the new key immediately;
 *  - `signOutEverywhere` revokes other sessions.
 *
 * Every assertion reads the STORED ROW. The previous suite drove an in-memory
 * `Map` standing in for `AuthChallenge` and asserted on the `findOneAndUpdate`
 * FILTER, which proved the query was built as expected but never that the
 * challenge was actually spent — the atomic burn is precisely the thing that
 * cannot be verified that way.
 *
 * The real `SignatureService` and `did.service` run; only the auth middleware,
 * the user cache, the session service and the socket emitter are mocked.
 */

import {
  generateSecp256k1KeyPair,
  normalizeSecp256k1PublicKey,
} from '@oxyhq/protocol/secp256k1';
import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { and, eq } from 'drizzle-orm';

/** The account `authMiddleware` injects for the current test. */
let currentUserId = '';

const mockInvalidate = jest.fn();
const mockDeactivateAll = jest.fn();
const mockEmitSessionUpdate = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { _id: currentUserId };
    next();
  },
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: (...args: unknown[]) => mockInvalidate(...args) },
}));

jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { deactivateAllUserSessions: (...args: unknown[]) => mockDeactivateAll(...args) },
}));

jest.mock('../../server', () => ({
  __esModule: true,
  emitSessionUpdate: (...args: unknown[]) => mockEmitSessionUpdate(...args),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { authChallenges } from '../../db/schema/authChallenges';
import { identityBackups } from '../../db/schema/identityBackups';
import { sessions } from '../../db/schema/sessions';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import authLinkingRouter from '../authLinking';
import SignatureService from '../../services/signature.service';
import { buildDidDocument } from '../../services/did.service';
import { errorHandler } from '../../middleware/errorHandler';

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

/** A fresh account holding `publicKey` as its identity key, with the matching row. */
async function accountWithIdentity(publicKey: string): Promise<string> {
  const [row] = await getDb().insert(users).values({ publicKey }).returning({ id: users.id });
  await getDb().insert(userAuthMethods).values({
    userId: row.id,
    type: 'identity',
    methodPublicKey: publicKey,
    methodEmail: 'nate@oxy.so',
  });
  return row.id;
}

/** The stored account row. */
async function storedUser(userId: string) {
  const [row] = await getDb()
    .select({ id: users.id, publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row;
}

/** The stored auth-method rows of an account. */
async function storedAuthMethods(userId: string) {
  return getDb()
    .select()
    .from(userAuthMethods)
    .where(eq(userAuthMethods.userId, userId))
    .orderBy(userAuthMethods.linkedAt, userAuthMethods.id);
}

/** The stored challenge row. */
async function storedChallenge(challenge: string) {
  const [row] = await getDb()
    .select()
    .from(authChallenges)
    .where(eq(authChallenges.challenge, challenge))
    .limit(1);
  return row;
}

/** The DID document derived from what is actually stored for `userId`. */
async function storedDidDocument(userId: string) {
  const user = await storedUser(userId);
  const methods = await storedAuthMethods(userId);
  return buildDidDocument({
    _id: userId,
    publicKey: user.publicKey,
    authMethods: methods.map((method) => ({
      type: method.type,
      metadata: { publicKey: method.methodPublicKey },
    })),
  });
}

let server: http.Server;
let oldKeyPair: EC.KeyPair;
let oldPublicKey: string;
let oldPrivateKey: string;

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/auth', authLinkingRouter);
  // Mirror production: convert thrown ApiErrors (e.g. Zod validation via the
  // `validate` middleware) into JSON responses instead of Express's default HTML.
  app.use(errorHandler);
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

beforeEach(async () => {
  jest.clearAllMocks();
  oldKeyPair = generateSecp256k1KeyPair();
  oldPublicKey = oldKeyPair.publicKey;
  oldPrivateKey = oldKeyPair.privateKey;
  currentUserId = await accountWithIdentity(oldPublicKey);
});

/** Mint a rotate_key challenge for the current user via the real endpoint. */
async function mintRotateChallenge(): Promise<string> {
  const res = await request(server, 'POST', '/auth/rotate/challenge');
  expect(res.status).toBe(200);
  return res.body.challenge as string;
}

/** Sign the OLD-key rotation proof with the given private key. */
function signRotation(params: {
  privateKey: string;
  oldPublicKey: string;
  newPublicKey: string;
  challenge: string;
  timestamp: number;
}): string {
  const canonicalOldPublicKey = SignatureService.canonicalizePublicKey(params.oldPublicKey);
  const message = JSON.stringify({
    action: 'rotate_key',
    userId: currentUserId,
    oldPublicKey: canonicalOldPublicKey,
    newPublicKey: params.newPublicKey,
    challenge: params.challenge,
    timestamp: params.timestamp,
  });
  return SignatureService.signMessage(message, params.privateKey);
}

/** Sign the NEW-key proof-of-possession with the NEW private key. */
function signNewKeyProof(params: {
  newPrivateKey: string;
  newPublicKey: string;
  challenge: string;
  timestamp: number;
}): string {
  const message = JSON.stringify({
    action: 'rotate_key_new',
    userId: currentUserId,
    newPublicKey: params.newPublicKey,
    challenge: params.challenge,
    timestamp: params.timestamp,
  });
  return SignatureService.signMessage(message, params.newPrivateKey);
}

/** Build a complete-rotation request body with both proofs signed. */
function buildCompleteBody(params: {
  oldPrivateKey: string;
  newKeyPair: EC.KeyPair;
  oldPublicKey: string;
  newPublicKey?: string; // encoding to send (defaults to uncompressed of newKeyPair)
  challenge: string;
  timestamp: number;
  signOutEverywhere?: boolean;
}): Record<string, unknown> {
  const newPublicKey = params.newPublicKey ?? params.newKeyPair.publicKey;
  const newPrivateKey = params.newKeyPair.privateKey;
  return {
    newPublicKey,
    challenge: params.challenge,
    signature: signRotation({
      privateKey: params.oldPrivateKey,
      oldPublicKey: params.oldPublicKey,
      newPublicKey,
      challenge: params.challenge,
      timestamp: params.timestamp,
    }),
    newKeyProof: signNewKeyProof({ newPrivateKey, newPublicKey, challenge: params.challenge, timestamp: params.timestamp }),
    timestamp: params.timestamp,
    ...(params.signOutEverywhere ? { signOutEverywhere: true } : {}),
  };
}

describe('POST /auth/rotate/challenge', () => {
  it('stores an unspent, rotate_key-purpose challenge bound to the account key', async () => {
    const challenge = await mintRotateChallenge();

    const stored = await storedChallenge(challenge);
    expect(stored.purpose).toBe('rotate_key');
    expect(stored.publicKey).toBe(oldPublicKey);
    expect(stored.used).toBe(false);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects an account with no identity key (400, nothing stored)', async () => {
    await getDb().update(users).set({ publicKey: null }).where(eq(users.id, currentUserId));
    const res = await request(server, 'POST', '/auth/rotate/challenge');
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/rotate/complete — happy path', () => {
  it('replaces the identity key IN PLACE: same row, new key, challenge spent, backup gone', async () => {
    const newKeyPair = generateSecp256k1KeyPair();
    const newPublicKey = newKeyPair.publicKey;
    const [identityBefore] = (await storedAuthMethods(currentUserId)).filter((m) => m.type === 'identity');
    await getDb().insert(identityBackups).values({
      userId: currentUserId,
      lookupIdHash: `hash-${randomUUID()}`,
      publicKeyHint: oldPublicKey.slice(0, 8),
      ciphertext: 'deadbeef',
      nonce: 'cafe',
      algorithm: 'xchacha20poly1305',
      kdfInfo: 'oxy-identity-backup',
      version: 1,
      clientCreatedAt: '2026-01-01T00:00:00.000Z',
    });

    const challenge = await mintRotateChallenge();
    const timestamp = Date.now();
    const res = await request(
      server,
      'POST',
      '/auth/rotate/complete',
      buildCompleteBody({ oldPrivateKey, newKeyPair, oldPublicKey, challenge, timestamp }),
    );

    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe(newPublicKey);
    expect((await storedUser(currentUserId)).publicKey).toBe(newPublicKey);

    // Atomic replace: the SAME row carries the new key — never deleted and
    // re-inserted, so there is no `total === 0` window.
    const methods = await storedAuthMethods(currentUserId);
    expect(methods).toHaveLength(1);
    expect(methods[0].id).toBe(identityBefore.id);
    expect(methods[0].methodPublicKey).toBe(newPublicKey);
    // Untouched metadata survives the in-place update.
    expect(methods[0].methodEmail).toBe('nate@oxy.so');

    // The challenge is spent.
    expect((await storedChallenge(challenge)).used).toBe(true);
    // Cache invalidated.
    expect(mockInvalidate).toHaveBeenCalledWith(currentUserId);
    // The stale encrypted backup — which still held the OLD key under the OLD
    // phrase's locator — is gone.
    const backups = await getDb()
      .select({ id: identityBackups.id })
      .from(identityBackups)
      .where(eq(identityBackups.userId, currentUserId));
    expect(backups).toHaveLength(0);

    // The derived DID reflects the new key IMMEDIATELY.
    const vms = (await storedDidDocument(currentUserId)).verificationMethod as Array<{ publicKeyHex?: string }>;
    expect(vms.some((vm) => vm.publicKeyHex === newPublicKey)).toBe(true);
    expect(vms.some((vm) => vm.publicKeyHex === oldPublicKey)).toBe(false);
  });

  it('adds the identity row when the account had a key but no method row (legacy account)', async () => {
    await getDb()
      .delete(userAuthMethods)
      .where(and(eq(userAuthMethods.userId, currentUserId), eq(userAuthMethods.type, 'identity')));

    const newKeyPair = generateSecp256k1KeyPair();
    const challenge = await mintRotateChallenge();
    const res = await request(
      server,
      'POST',
      '/auth/rotate/complete',
      buildCompleteBody({ oldPrivateKey, newKeyPair, oldPublicKey, challenge, timestamp: Date.now() }),
    );

    expect(res.status).toBe(200);
    const methods = await storedAuthMethods(currentUserId);
    expect(methods).toHaveLength(1);
    expect(methods[0].methodPublicKey).toBe(newKeyPair.publicKey);
  });
});

describe('security invariant — proof-of-possession of the new key', () => {
  it('rejects a request missing newKeyProof (schema validation, 400)', async () => {
    const newKeyPair = generateSecp256k1KeyPair();
    const newPublicKey = newKeyPair.publicKey;
    const challenge = await mintRotateChallenge();
    const timestamp = Date.now();
    const signature = signRotation({ privateKey: oldPrivateKey, oldPublicKey, newPublicKey, challenge, timestamp });

    // No newKeyProof field.
    const res = await request(server, 'POST', '/auth/rotate/complete', { newPublicKey, challenge, signature, timestamp });

    expect(res.status).toBe(400);
    expect((await storedUser(currentUserId)).publicKey).toBe(oldPublicKey);
  });

  it('rejects a newKeyProof NOT signed by the new key (400, nothing written, challenge unspent)', async () => {
    const newKeyPair = generateSecp256k1KeyPair();
    const newPublicKey = newKeyPair.publicKey;
    const impostor = generateSecp256k1KeyPair();
    const challenge = await mintRotateChallenge();
    const timestamp = Date.now();

    const signature = signRotation({ privateKey: oldPrivateKey, oldPublicKey, newPublicKey, challenge, timestamp });
    // Proof signed by a DIFFERENT key than newPublicKey.
    const newKeyProof = signNewKeyProof({ newPrivateKey: impostor.privateKey, newPublicKey, challenge, timestamp });

    const res = await request(server, 'POST', '/auth/rotate/complete', { newPublicKey, challenge, signature, newKeyProof, timestamp });

    expect(res.status).toBe(400);
    expect((await storedUser(currentUserId)).publicKey).toBe(oldPublicKey);
    expect((await storedChallenge(challenge)).used).toBe(false);
  });
});

describe('security invariant — key re-encoding is canonicalized', () => {
  it('stores the canonical (uncompressed, lowercased) key even when a compressed/uppercased form is sent', async () => {
    const newKeyPair = generateSecp256k1KeyPair();
    const compressed = normalizeSecp256k1PublicKey(newKeyPair.publicKey, true).toUpperCase(); // compressed + uppercased
    const canonical = newKeyPair.publicKey.toLowerCase(); // uncompressed + lowercased

    const challenge = await mintRotateChallenge();
    const timestamp = Date.now();
    const res = await request(
      server,
      'POST',
      '/auth/rotate/complete',
      buildCompleteBody({ oldPrivateKey, newKeyPair, oldPublicKey, newPublicKey: compressed, challenge, timestamp }),
    );

    expect(res.status).toBe(200);
    // Stored + returned in canonical form, NOT the re-encoding that was sent.
    expect(res.body.publicKey).toBe(canonical);
    expect((await storedUser(currentUserId)).publicKey).toBe(canonical);
    const [identity] = (await storedAuthMethods(currentUserId)).filter((m) => m.type === 'identity');
    expect(identity.methodPublicKey).toBe(canonical);
  });

  it('rejects rotating to a re-encoding (compressed) of a key already registered to another account (409)', async () => {
    // A key some OTHER account already holds, stored canonically.
    const victimKeyPair = generateSecp256k1KeyPair();
    const victimCanonical = victimKeyPair.publicKey.toLowerCase();
    const victimCompressed = normalizeSecp256k1PublicKey(victimKeyPair.publicKey, true);
    await accountWithIdentity(victimCanonical);

    const challenge = await mintRotateChallenge();
    const timestamp = Date.now();
    // The caller controls the victim key (has its private key) so proof-of-possession passes;
    // only the canonicalization before the uniqueness query catches the re-encoding.
    const res = await request(
      server,
      'POST',
      '/auth/rotate/complete',
      buildCompleteBody({ oldPrivateKey, newKeyPair: victimKeyPair, oldPublicKey, newPublicKey: victimCompressed, challenge, timestamp }),
    );

    expect(res.status).toBe(409);
    expect((await storedUser(currentUserId)).publicKey).toBe(oldPublicKey);
  });
});

describe('security invariant — oldPublicKey is server-derived', () => {
  it('ignores a client-supplied oldPublicKey and validates against the user row', async () => {
    const newKeyPair = generateSecp256k1KeyPair();
    const attacker = generateSecp256k1KeyPair();
    const challenge = await mintRotateChallenge();
    const timestamp = Date.now();
    const body = buildCompleteBody({ oldPrivateKey, newKeyPair, oldPublicKey, challenge, timestamp });

    const res = await request(server, 'POST', '/auth/rotate/complete', {
      ...body,
      oldPublicKey: attacker.publicKey, // ignored by the server
    });

    expect(res.status).toBe(200);
    expect((await storedUser(currentUserId)).publicKey).toBe(newKeyPair.publicKey);
  });

  it('rejects a signature made with a key other than the account key (proving control of X but rotating Y)', async () => {
    const newKeyPair = generateSecp256k1KeyPair();
    const newPublicKey = newKeyPair.publicKey;
    const attacker = generateSecp256k1KeyPair();
    const challenge = await mintRotateChallenge();
    const timestamp = Date.now();

    // Old-key signature by the WRONG key; new-key proof is valid.
    const signature = signRotation({ privateKey: attacker.privateKey, oldPublicKey, newPublicKey, challenge, timestamp });
    const newKeyProof = signNewKeyProof({ newPrivateKey: newKeyPair.privateKey, newPublicKey, challenge, timestamp });

    const res = await request(server, 'POST', '/auth/rotate/complete', { newPublicKey, challenge, signature, newKeyProof, timestamp });

    expect(res.status).toBe(400);
    expect((await storedUser(currentUserId)).publicKey).toBe(oldPublicKey);
    expect(mockInvalidate).not.toHaveBeenCalled();
    // Invalid signature must NOT burn the challenge — the caller can retry.
    expect((await storedChallenge(challenge)).used).toBe(false);
  });

  it('rotates when the account stores a compressed identity key but the client signs with the uncompressed form', async () => {
    const compressedOld = normalizeSecp256k1PublicKey(oldKeyPair.publicKey, true);
    currentUserId = await accountWithIdentity(compressedOld);

    const newKeyPair = generateSecp256k1KeyPair();
    const challenge = await mintRotateChallenge();
    const res = await request(
      server,
      'POST',
      '/auth/rotate/complete',
      buildCompleteBody({ oldPrivateKey, newKeyPair, oldPublicKey, challenge, timestamp: Date.now() }),
    );

    expect(res.status).toBe(200);
    expect((await storedUser(currentUserId)).publicKey).toBe(newKeyPair.publicKey.toLowerCase());
  });
});

describe('security invariant — purpose scoping', () => {
  it('a signin challenge (default purpose) can NOT complete a rotation', async () => {
    const newKeyPair = generateSecp256k1KeyPair();
    // Seed a SIGNIN-purpose challenge directly (as the signin flow would).
    const challenge = `signin-${randomUUID()}`;
    await getDb().insert(authChallenges).values({
      publicKey: oldPublicKey,
      challenge,
      purpose: 'signin',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      used: false,
    });

    const res = await request(
      server,
      'POST',
      '/auth/rotate/complete',
      buildCompleteBody({ oldPrivateKey, newKeyPair, oldPublicKey, challenge, timestamp: Date.now() }),
    );

    expect(res.status).toBe(401);
    expect((await storedUser(currentUserId)).publicKey).toBe(oldPublicKey);
    // The signin challenge must remain UNUSED (rotation never touched it).
    expect((await storedChallenge(challenge)).used).toBe(false);
  });

  it("a rotate challenge minted for ANOTHER account's key cannot rotate this one", async () => {
    const strangerKeyPair = generateSecp256k1KeyPair();
    const strangerPublicKey = strangerKeyPair.publicKey;
    const challenge = `foreign-${randomUUID()}`;
    await getDb().insert(authChallenges).values({
      publicKey: strangerPublicKey,
      challenge,
      purpose: 'rotate_key',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      used: false,
    });

    const newKeyPair = generateSecp256k1KeyPair();
    const res = await request(
      server,
      'POST',
      '/auth/rotate/complete',
      buildCompleteBody({ oldPrivateKey, newKeyPair, oldPublicKey, challenge, timestamp: Date.now() }),
    );

    expect(res.status).toBe(401);
    expect((await storedUser(currentUserId)).publicKey).toBe(oldPublicKey);
    expect((await storedChallenge(challenge)).used).toBe(false);
  });
});

describe('security invariant — single-use challenge', () => {
  it('rejects a second rotation with an already-burned challenge', async () => {
    const firstKeyPair = generateSecp256k1KeyPair();
    const first = firstKeyPair.publicKey;
    const challenge = await mintRotateChallenge();
    const timestamp = Date.now();

    const res1 = await request(
      server,
      'POST',
      '/auth/rotate/complete',
      buildCompleteBody({ oldPrivateKey, newKeyPair: firstKeyPair, oldPublicKey, challenge, timestamp }),
    );
    expect(res1.status).toBe(200);

    // Replay with the same (now burned) challenge — the account key is now `first`.
    const secondKeyPair = generateSecp256k1KeyPair();
    const res2 = await request(
      server,
      'POST',
      '/auth/rotate/complete',
      buildCompleteBody({ oldPrivateKey: firstKeyPair.privateKey, newKeyPair: secondKeyPair, oldPublicKey: first, challenge, timestamp }),
    );

    expect(res2.status).toBe(401);
    // The account still holds the key from the FIRST rotation.
    expect((await storedUser(currentUserId)).publicKey).toBe(first);
  });

  it('rejects an EXPIRED challenge with 401 (the read filters the deadline; it does not wait for the sweep)', async () => {
    const newKeyPair = generateSecp256k1KeyPair();
    const challenge = await mintRotateChallenge();
    await getDb()
      .update(authChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authChallenges.challenge, challenge));

    const res = await request(
      server,
      'POST',
      '/auth/rotate/complete',
      buildCompleteBody({ oldPrivateKey, newKeyPair, oldPublicKey, challenge, timestamp: Date.now() }),
    );

    expect(res.status).toBe(401);
    expect((await storedUser(currentUserId)).publicKey).toBe(oldPublicKey);
    // Rejected, not consumed.
    expect((await storedChallenge(challenge)).used).toBe(false);
  });
});

describe('security invariant — stale request does not self-burn its challenge', () => {
  it('rejects a stale timestamp BEFORE burning the challenge', async () => {
    const newKeyPair = generateSecp256k1KeyPair();
    const challenge = await mintRotateChallenge();
    // 10 minutes old — beyond the 5-minute freshness window.
    const timestamp = Date.now() - 10 * 60 * 1000;

    const res = await request(
      server,
      'POST',
      '/auth/rotate/complete',
      buildCompleteBody({ oldPrivateKey, newKeyPair, oldPublicKey, challenge, timestamp }),
    );

    expect(res.status).toBe(400);
    expect((await storedUser(currentUserId)).publicKey).toBe(oldPublicKey);
    // The challenge was NOT consumed — a fresh retry can still use it.
    expect((await storedChallenge(challenge)).used).toBe(false);
  });
});

describe('conflict + validation guards', () => {
  it('rejects a newPublicKey already registered to another account (409)', async () => {
    const newKeyPair = generateSecp256k1KeyPair();
    await accountWithIdentity(newKeyPair.publicKey.toLowerCase());

    const challenge = await mintRotateChallenge();
    const res = await request(
      server,
      'POST',
      '/auth/rotate/complete',
      buildCompleteBody({ oldPrivateKey, newKeyPair, oldPublicKey, challenge, timestamp: Date.now() }),
    );

    expect(res.status).toBe(409);
    expect((await storedUser(currentUserId)).publicKey).toBe(oldPublicKey);
  });

  it('rejects rotating to the SAME key (400)', async () => {
    const challenge = await mintRotateChallenge();
    const timestamp = Date.now();
    const signature = signRotation({ privateKey: oldPrivateKey, oldPublicKey, newPublicKey: oldPublicKey, challenge, timestamp });
    const newKeyProof = signNewKeyProof({ newPrivateKey: oldPrivateKey, newPublicKey: oldPublicKey, challenge, timestamp });

    const res = await request(server, 'POST', '/auth/rotate/complete', { newPublicKey: oldPublicKey, challenge, signature, newKeyProof, timestamp });

    expect(res.status).toBe(400);
    expect((await storedChallenge(challenge)).used).toBe(false);
  });

  it('rejects an invalid newPublicKey (400)', async () => {
    const challenge = await mintRotateChallenge();
    const timestamp = Date.now();
    const signature = signRotation({ privateKey: oldPrivateKey, oldPublicKey, newPublicKey: 'not-a-key', challenge, timestamp });

    const res = await request(server, 'POST', '/auth/rotate/complete', { newPublicKey: 'not-a-key', challenge, signature, newKeyProof: 'deadbeef', timestamp });

    expect(res.status).toBe(400);
    expect((await storedUser(currentUserId)).publicKey).toBe(oldPublicKey);
  });
});

describe('signOutEverywhere', () => {
  /** An active session row for the account (both token columns are unique + NOT NULL). */
  async function activeSession(sessionId: string): Promise<void> {
    await getDb().insert(sessions).values({
      sessionId,
      userId: currentUserId,
      deviceId: `dev-${randomUUID()}`,
      deviceType: 'web',
      platform: 'web',
      accessToken: `at-${randomUUID()}`,
      refreshToken: `rt-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  }

  it('revokes other sessions and pushes a sessions_removed event on success', async () => {
    const s2 = `s2-${randomUUID()}`;
    const s3 = `s3-${randomUUID()}`;
    await activeSession(s2);
    await activeSession(s3);
    mockDeactivateAll.mockResolvedValue(2);

    const newKeyPair = generateSecp256k1KeyPair();
    const challenge = await mintRotateChallenge();
    const res = await request(
      server,
      'POST',
      '/auth/rotate/complete',
      buildCompleteBody({ oldPrivateKey, newKeyPair, oldPublicKey, challenge, timestamp: Date.now(), signOutEverywhere: true }),
    );

    expect(res.status).toBe(200);
    expect(mockDeactivateAll).toHaveBeenCalledWith(currentUserId, undefined);
    const [userId, payload] = mockEmitSessionUpdate.mock.calls[0] as [string, { type: string; sessionIds: string[] }];
    expect(userId).toBe(currentUserId);
    expect(payload.type).toBe('sessions_removed');
    expect([...payload.sessionIds].sort()).toEqual([s2, s3].sort());
  });

  it('ignores INACTIVE and EXPIRED sessions when listing what was revoked', async () => {
    const live = `live-${randomUUID()}`;
    await activeSession(live);
    // One deactivated and one expired session must not appear in the event.
    const dead = `dead-${randomUUID()}`;
    await activeSession(dead);
    await getDb().update(sessions).set({ isActive: false }).where(eq(sessions.sessionId, dead));
    const stale = `stale-${randomUUID()}`;
    await activeSession(stale);
    await getDb()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.sessionId, stale));

    const newKeyPair = generateSecp256k1KeyPair();
    const challenge = await mintRotateChallenge();
    const res = await request(
      server,
      'POST',
      '/auth/rotate/complete',
      buildCompleteBody({ oldPrivateKey, newKeyPair, oldPublicKey, challenge, timestamp: Date.now(), signOutEverywhere: true }),
    );

    expect(res.status).toBe(200);
    const [, payload] = mockEmitSessionUpdate.mock.calls[0] as [string, { sessionIds: string[] }];
    expect(payload.sessionIds).toEqual([live]);
  });

  it('does NOT revoke other sessions when the flag is absent', async () => {
    await activeSession(`s-${randomUUID()}`);

    const newKeyPair = generateSecp256k1KeyPair();
    const challenge = await mintRotateChallenge();
    const res = await request(
      server,
      'POST',
      '/auth/rotate/complete',
      buildCompleteBody({ oldPrivateKey, newKeyPair, oldPublicKey, challenge, timestamp: Date.now() }),
    );

    expect(res.status).toBe(200);
    expect(mockDeactivateAll).not.toHaveBeenCalled();
    expect(mockEmitSessionUpdate).not.toHaveBeenCalled();
  });
});
