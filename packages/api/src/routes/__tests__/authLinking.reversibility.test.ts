/**
 * Reversibility + cache-invalidation tests for auth-method linking (B4), against
 * a REAL Postgres.
 *
 * Proves the self-sovereign ↔ custodial round trip the DID layer depends on:
 * linking an `identity` key flips the account to self-sovereign (DID controlled
 * by `[userDid, OXY_DID]`); unlinking it reverts to custodial (`[OXY_DID]`); and
 * `userCache.invalidate` fires after BOTH writes (without it the DID document
 * would serve stale state). Also locks the `GET /auth/methods` contract shape and
 * the two unlink guards.
 *
 * Every assertion reads the STORED ROWS — `users.public_key` and the
 * `user_auth_methods` child table that replaced the `authMethods[]` subdocument
 * array — and the DID document is derived FROM those rows, so "the DID flipped"
 * means the persisted state flipped rather than an in-memory mock document.
 *
 * The real `SignatureService` and `did.service` run. Only genuine collaborators
 * are mocked: the auth middleware (identity injection), the user cache, the
 * session service, and the socket emitter.
 */

import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { and, eq } from 'drizzle-orm';

/** The account `authMiddleware` injects for the current test. */
let currentUserId = '';

const mockInvalidate = jest.fn();

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
  default: { deactivateAllUserSessions: jest.fn() },
}));

jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import { webauthnCredentials } from '../../db/schema/webauthnCredentials';
import authLinkingRouter from '../authLinking';
import SignatureService from '../../services/signature.service';
import { buildDidDocument, buildUserDid, OXY_DID } from '../../services/did.service';
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

/** A base64url-ish credential id unique to one test. */
function freshCredentialId(): string {
  return `cred${randomUUID().replace(/-/g, '')}`;
}

/** A fresh account row. */
async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/** Register a passkey (credential row + its auth-method row) on an account. */
async function addPasskey(userId: string, name = 'Laptop'): Promise<string> {
  const credentialID = freshCredentialId();
  await getDb().insert(webauthnCredentials).values({
    userId,
    credentialID,
    credentialPublicKey: Buffer.from([1, 2, 3]),
    counter: 0,
    deviceType: 'multiDevice',
    backedUp: true,
    userVerified: true,
    name,
  });
  await getDb().insert(userAuthMethods).values({
    userId,
    type: 'webauthn',
    methodCredentialId: credentialID,
    methodName: name,
  });
  return credentialID;
}

/** Link an identity key directly (bypassing the route), as a fixture. */
async function addIdentity(userId: string, publicKey: string): Promise<void> {
  await getDb().update(users).set({ publicKey }).where(eq(users.id, userId));
  await getDb().insert(userAuthMethods).values({
    userId,
    type: 'identity',
    methodPublicKey: publicKey,
  });
}

/** The stored account row. */
async function storedUser(userId: string) {
  const [row] = await getDb()
    .select({ id: users.id, publicKey: users.publicKey, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row;
}

/** The stored auth-method rows of an account, oldest first. */
async function storedAuthMethods(userId: string) {
  return getDb()
    .select()
    .from(userAuthMethods)
    .where(eq(userAuthMethods.userId, userId))
    .orderBy(userAuthMethods.linkedAt, userAuthMethods.id);
}

/**
 * The DID document derived from what is actually STORED for `userId` — the
 * builder still reads the `metadata.publicKey` shape the subdocument had, so the
 * child-table rows are adapted to it here exactly as the route does.
 */
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
  currentUserId = await account();
  // Custodial baseline: a passkey-only account (no identity key). Keeping one
  // passkey means the identity link/unlink round trip is not blocked by the
  // "keep ≥1 auth method" guard when the identity is later removed.
  await addPasskey(currentUserId, 'Baseline');
});

describe('identity link/unlink reversibility', () => {
  it('links → self-sovereign DID, unlinks → custodial DID, invalidating cache each step', async () => {
    const keyPair = generateSecp256k1KeyPair();
    const publicKey = keyPair.publicKey;
    const privateKey = keyPair.privateKey;
    const timestamp = Date.now();
    const signature = SignatureService.signMessage(
      JSON.stringify({ action: 'link_identity', userId: currentUserId, timestamp }),
      privateKey,
    );

    // Before: custodial — controlled solely by Oxy.
    expect((await storedDidDocument(currentUserId)).controller).toEqual([OXY_DID]);

    const linkRes = await request(server, 'POST', '/auth/link', { type: 'identity', publicKey, signature, timestamp });
    expect(linkRes.status).toBe(200);

    const linked = await storedUser(currentUserId);
    expect(linked.publicKey).toBe(publicKey.toLowerCase());
    const afterLink = await storedAuthMethods(currentUserId);
    expect(afterLink.filter((m) => m.type === 'identity')).toHaveLength(1);
    expect(afterLink.find((m) => m.type === 'identity')?.methodPublicKey).toBe(publicKey.toLowerCase());
    expect(mockInvalidate).toHaveBeenCalledWith(currentUserId);

    // After link: self-sovereign — controlled by [userDid, OXY_DID].
    expect((await storedDidDocument(currentUserId)).controller).toEqual([buildUserDid(currentUserId), OXY_DID]);

    mockInvalidate.mockClear();

    const unlinkRes = await request(server, 'DELETE', '/auth/link/identity');
    expect(unlinkRes.status).toBe(200);
    expect((await storedUser(currentUserId)).publicKey).toBeNull();
    expect((await storedAuthMethods(currentUserId)).some((m) => m.type === 'identity')).toBe(false);
    expect(mockInvalidate).toHaveBeenCalledWith(currentUserId);

    // Back to custodial.
    expect((await storedDidDocument(currentUserId)).controller).toEqual([OXY_DID]);
  });

  it('re-linking the SAME key does not add a second identity row', async () => {
    const keyPair = generateSecp256k1KeyPair();
    const publicKey = keyPair.publicKey;
    const privateKey = keyPair.privateKey;
    const sign = () => {
      const timestamp = Date.now();
      return {
        type: 'identity',
        publicKey,
        timestamp,
        signature: SignatureService.signMessage(
          JSON.stringify({ action: 'link_identity', userId: currentUserId, timestamp }),
          privateKey,
        ),
      };
    };

    expect((await request(server, 'POST', '/auth/link', sign())).status).toBe(200);
    expect((await request(server, 'POST', '/auth/link', sign())).status).toBe(200);

    expect((await storedAuthMethods(currentUserId)).filter((m) => m.type === 'identity')).toHaveLength(1);
  });

  it('stores the key LOWERCASED (the Mongoose `lowercase` setter has no Postgres counterpart)', async () => {
    const keyPair = generateSecp256k1KeyPair();
    const publicKey = keyPair.publicKey.toUpperCase();
    const privateKey = keyPair.privateKey;
    const timestamp = Date.now();
    const signature = SignatureService.signMessage(
      JSON.stringify({ action: 'link_identity', userId: currentUserId, timestamp }),
      privateKey,
    );

    const res = await request(server, 'POST', '/auth/link', { type: 'identity', publicKey, signature, timestamp });

    expect(res.status).toBe(200);
    expect((await storedUser(currentUserId)).publicKey).toBe(publicKey.toLowerCase());
  });

  it('rejects an identity link with an invalid signature (no write, no invalidate)', async () => {
    const publicKey = generateSecp256k1KeyPair().publicKey;
    const res = await request(server, 'POST', '/auth/link', {
      type: 'identity',
      publicKey,
      signature: 'deadbeef',
      timestamp: Date.now(),
    });
    expect(res.status).toBe(400);
    expect((await storedUser(currentUserId)).publicKey).toBeNull();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('rejects a key already linked to ANOTHER account (409, no write)', async () => {
    const keyPair = generateSecp256k1KeyPair();
    const publicKey = keyPair.publicKey.toLowerCase();
    const other = await account();
    await addIdentity(other, publicKey);

    const timestamp = Date.now();
    const signature = SignatureService.signMessage(
      JSON.stringify({ action: 'link_identity', userId: currentUserId, timestamp }),
      keyPair.privateKey,
    );

    const res = await request(server, 'POST', '/auth/link', { type: 'identity', publicKey, signature, timestamp });

    expect(res.status).toBe(409);
    expect((await storedUser(currentUserId)).publicKey).toBeNull();
    expect((await storedUser(other)).publicKey).toBe(publicKey);
  });

  it('refuses to unlink the identity when it is the LAST auth method', async () => {
    // Drop the baseline passkey so the identity key is the only method left.
    await getDb()
      .delete(userAuthMethods)
      .where(and(eq(userAuthMethods.userId, currentUserId), eq(userAuthMethods.type, 'webauthn')));
    const publicKey = generateSecp256k1KeyPair().publicKey.toLowerCase();
    await addIdentity(currentUserId, publicKey);

    const res = await request(server, 'DELETE', '/auth/link/identity');

    expect(res.status).toBe(400);
    expect((await storedUser(currentUserId)).publicKey).toBe(publicKey);
    expect((await storedAuthMethods(currentUserId)).some((m) => m.type === 'identity')).toBe(true);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});

describe('DELETE /auth/link/webauthn/:credentialID (keep ≥1 auth method)', () => {
  it('unlinks a passkey when other auth methods remain (removes the method row, the credential row, and invalidates)', async () => {
    // identity + one passkey → two methods; unlinking the passkey is allowed.
    await addIdentity(currentUserId, generateSecp256k1KeyPair().publicKey.toLowerCase());
    const credentialID = await addPasskey(currentUserId, 'Second');

    const res = await request(server, 'DELETE', `/auth/link/webauthn/${credentialID}`);

    expect(res.status).toBe(200);
    const methods = await storedAuthMethods(currentUserId);
    expect(methods.some((m) => m.methodCredentialId === credentialID)).toBe(false);
    const [credential] = await getDb()
      .select({ id: webauthnCredentials.id })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialID, credentialID))
      .limit(1);
    expect(credential).toBeUndefined();
    expect(mockInvalidate).toHaveBeenCalledWith(currentUserId);
  });

  it('refuses to unlink the LAST auth method — a passkey-only account (no write, no delete)', async () => {
    // The baseline passkey is the ONLY auth method: no identity key.
    const [baseline] = await storedAuthMethods(currentUserId);

    const res = await request(server, 'DELETE', `/auth/link/webauthn/${baseline.methodCredentialId}`);

    expect(res.status).toBe(400);
    expect(await storedAuthMethods(currentUserId)).toHaveLength(1);
    const [credential] = await getDb()
      .select({ id: webauthnCredentials.id })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialID, baseline.methodCredentialId))
      .limit(1);
    expect(credential).toBeDefined();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("rejects unlinking a passkey the account does not own — and the OWNER's rows survive", async () => {
    // The caller has two methods, so the guard would not block a legitimate unlink;
    // only the ownership scoping stands between them and someone else's passkey.
    await addIdentity(currentUserId, generateSecp256k1KeyPair().publicKey.toLowerCase());
    const victim = await account();
    const victimCredentialId = await addPasskey(victim, 'Victim Key');

    const res = await request(server, 'DELETE', `/auth/link/webauthn/${victimCredentialId}`);

    expect(res.status).toBe(400);
    // The victim keeps both their credential row and their auth-method row.
    const [credential] = await getDb()
      .select({ id: webauthnCredentials.id })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialID, victimCredentialId))
      .limit(1);
    expect(credential).toBeDefined();
    expect((await storedAuthMethods(victim)).some((m) => m.methodCredentialId === victimCredentialId)).toBe(true);
  });

  it('rejects an unknown credential id with 400', async () => {
    await addIdentity(currentUserId, generateSecp256k1KeyPair().publicKey.toLowerCase());
    const res = await request(server, 'DELETE', `/auth/link/webauthn/${freshCredentialId()}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /auth/methods contract (B4)', () => {
  it('returns the account DID plus contract-shaped methods built from the child table', async () => {
    const publicKey = generateSecp256k1KeyPair().publicKey.toLowerCase();
    await addIdentity(currentUserId, publicKey);

    const res = await request(server, 'GET', '/auth/methods');

    expect(res.status).toBe(200);
    expect(res.body.did).toBe(buildUserDid(currentUserId));
    const methods = res.body.methods as Array<{
      type: string;
      verificationMethodId?: string;
      credentialId?: string;
      name?: string;
    }>;
    const identity = methods.find((m) => m.type === 'identity');
    const passkey = methods.find((m) => m.type === 'webauthn');
    expect(identity?.verificationMethodId).toBe('#key-1');
    expect(passkey).toBeDefined();
    // The passkey entry carries its child-table columns…
    expect(passkey?.name).toBe('Baseline');
    expect(typeof passkey?.credentialId).toBe('string');
    // …and is NOT a DID verification method.
    expect(passkey?.verificationMethodId).toBeUndefined();
    // The legacy free-form `identifier` field is gone — the response is exactly
    // the `authMethodsResponseSchema` shape.
    expect((methods[0] as Record<string, unknown>).identifier).toBeUndefined();
  });

  it('omits the identity entry entirely for a custodial (passkey-only) account', async () => {
    const res = await request(server, 'GET', '/auth/methods');

    expect(res.status).toBe(200);
    const methods = res.body.methods as Array<{ type: string }>;
    expect(methods.some((m) => m.type === 'identity')).toBe(false);
    expect(methods.filter((m) => m.type === 'webauthn')).toHaveLength(1);
  });
});
