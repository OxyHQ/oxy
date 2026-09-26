/**
 * Root authority on auth-method linking (ADR 0024 D8), against a REAL Postgres.
 *
 * Linking is FIRST LINK ONLY: a keyless personal account gains a root only with
 * a one-use root proof AND a code just sent to its email, through
 * `/identity/link` (never this route); an account that has a different root is never overwritten; a root is never
 * unlinked back to custodial. The DID flips to
 * self-sovereign — controlled by the person alone — and `userCache.invalidate`
 * fires after the write. Also locks the `GET /auth/methods` contract shape.
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

import { deriveSecp256k1PublicKey, generateSecp256k1KeyPair } from '@oxy.so/protocol/secp256k1';
import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';

/** The account `authMiddleware` injects for the current test. */
let currentUserId = '';

const mockInvalidate = jest.fn();

let mockApplicationId: string | undefined;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown; oxyToken?: { applicationId?: string } }, _res: unknown, next: () => void) => {
    req.user = { _id: currentUserId };
    if (mockApplicationId) req.oxyToken = { applicationId: mockApplicationId };
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
import { applications } from '../../db/schema/applications';
import authLinkingRouter from '../authLinking';
import SignatureService from '../../services/signature.service';
import { buildDidDocument, buildUserDid, OXY_DID } from '../../services/did.service';
import { mintIdentityProofChallenge } from '../../services/identityProof.service';
import { signIdentityProof } from '@oxy.so/core';
import { IDENTITY_ERROR_CODES, IDENTITY_PROOF_AUDIENCE, type IdentityProofAction } from '@oxy.so/contracts';
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
        res.on('end', () => {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = raw.length ? JSON.parse(raw) : {};
          } catch {
            parsed = {};
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A fresh account row. */
async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
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
  // Custodial baseline: an account with no identity key.
  currentUserId = await account();
});

interface KeyIdentity {
  privateKey: string;
  publicKey: string;
}

/** A root as Commons holds it: a secp256k1 key, its public half canonical (lowercase, uncompressed). */
function keyIdentity(privateKey?: string): KeyIdentity {
  const pair = privateKey ? { privateKey, publicKey: deriveSecp256k1PublicKey(privateKey) } : generateSecp256k1KeyPair();
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.toLowerCase() };
}

/** A v2 root proof for `action` on the current account, spending a freshly minted challenge. */
async function rootProof(identity: KeyIdentity, action: IdentityProofAction, overrides: { payloadDigest?: string | null; subject?: string } = {}) {
  const minted = await mintIdentityProofChallenge(currentUserId, action);
  return signIdentityProof(identity, {
    action,
    subject: overrides.subject ?? currentUserId,
    actor: currentUserId,
    rootPublicKey: identity.publicKey,
    payloadDigest: overrides.payloadDigest ?? null,
    expectedRevision: null,
    audience: IDENTITY_PROOF_AUDIENCE,
    challenge: minted.challenge,
    expiresAt: minted.expiresAt,
  });
}

describe('first link only (ADR 0024 D8)', () => {
  it('keeps the email of a keyless account whose link it refuses', async () => {
    const email = `linked-${randomUUID()}@example.test`;
    await getDb().update(users).set({ email }).where(eq(users.id, currentUserId));
    const identity = keyIdentity();

    const proof = await rootProof(identity, 'link_identity');
    const res = await request(server, 'POST', '/auth/link', {
      type: 'identity',
      publicKey: identity.publicKey,
      proof,
    });

    expect(res.status).toBe(401);
    const [row] = await getDb().select({ email: users.email, publicKey: users.publicKey }).from(users).where(eq(users.id, currentUserId));
    expect(row).toEqual({ email, publicKey: null });
  });

  it('refuses a keyless account’s first link carried by a bearer and a new key alone', async () => {
    const identity = keyIdentity();
    const bearerOnly = await request(server, 'POST', '/auth/link', { type: 'identity', publicKey: identity.publicKey, proof: await rootProof(identity, 'link_identity') });
    expect(bearerOnly.status).toBe(401);

    expect((bearerOnly.body as { error?: string }).error).toBe(IDENTITY_ERROR_CODES.freshFactorRequired);
    expect((await storedUser(currentUserId)).publicKey).toBeNull();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('never replaces an existing different root, whatever proofs come with the request', async () => {
    const existing = keyIdentity('11'.repeat(32));
    await addIdentity(currentUserId, existing.publicKey);
    const intruder = keyIdentity();

    const proof = await rootProof(existing, 'link_identity');
    const res = await request(server, 'POST', '/auth/link', {
      type: 'identity',
      publicKey: intruder.publicKey,
      proof,
    });

    expect(res.status).toBe(409);
    expect((res.body as { error?: string }).error).toBe(IDENTITY_ERROR_CODES.rootAlreadyLinked);
    expect((await storedUser(currentUserId)).publicKey).toBe(existing.publicKey);
  });

  it('heals a missing identity method row for the SAME root, with a root proof, without adding a second', async () => {
    const identity = keyIdentity();
    await getDb().update(users).set({ publicKey: identity.publicKey }).where(eq(users.id, currentUserId));
    const body = async () => ({ type: 'identity', publicKey: identity.publicKey.toUpperCase(), proof: await rootProof(identity, 'link_identity') });

    expect((await request(server, 'POST', '/auth/link', await body())).status).toBe(200);
    expect((await request(server, 'POST', '/auth/link', await body())).status).toBe(200);
    const identityRows = (await storedAuthMethods(currentUserId)).filter((m) => m.type === 'identity');
    expect(identityRows).toHaveLength(1);
    expect(identityRows[0].methodPublicKey).toBe(identity.publicKey);
  });

  it('refuses a timestamp signature in place of a root proof, even for the same root', async () => {
    const keyPair = generateSecp256k1KeyPair();
    await getDb().update(users).set({ publicKey: keyPair.publicKey.toLowerCase() }).where(eq(users.id, currentUserId));
    const timestamp = Date.now();
    const signature = SignatureService.signMessage(JSON.stringify({ action: 'link_identity', userId: currentUserId, timestamp }), keyPair.privateKey);
    expect((await request(server, 'POST', '/auth/link', { type: 'identity', publicKey: keyPair.publicKey, signature, timestamp })).status).toBe(400);
  });

  it('rejects a key already linked to ANOTHER account (409, no write)', async () => {
    const taken = keyIdentity();
    const other = await account();
    await addIdentity(other, taken.publicKey);

    const proof = await rootProof(taken, 'link_identity');
    const res = await request(server, 'POST', '/auth/link', {
      type: 'identity',
      publicKey: taken.publicKey,
      proof,
    });

    // Refused before the key is even looked at: a keyless account's first
    // link is never made here (security review of #1421).
    expect(res.status).toBe(401);
    expect((await storedUser(currentUserId)).publicKey).toBeNull();
    expect((await storedUser(other)).publicKey).toBe(taken.publicKey);
  });
});

describe('a root is never unlinked (ADR 0024 D8)', () => {
  it('offers no route to unlink it', async () => {
    const publicKey = generateSecp256k1KeyPair().publicKey.toLowerCase();
    await addIdentity(currentUserId, publicKey);

    const res = await request(server, 'DELETE', '/auth/link/identity');

    expect(res.status).toBe(404);
    expect((await storedUser(currentUserId)).publicKey).toBe(publicKey);
    expect((await storedAuthMethods(currentUserId)).some((m) => m.type === 'identity')).toBe(true);
    expect((await storedDidDocument(currentUserId)).controller).toEqual([buildUserDid(currentUserId)]);
  });
});

describe("a third-party application's token", () => {
  it('links no root, but still reads', async () => {
    await addIdentity(currentUserId, generateSecp256k1KeyPair().publicKey.toLowerCase());
    const [app] = await getDb()
      .insert(applications)
      .values({ name: 'Third party', type: 'third_party', ownerAccountId: currentUserId, createdByUserId: currentUserId })
      .returning({ id: applications.id });
    mockApplicationId = app.id;
    try {
      expect((await request(server, 'POST', '/auth/link', { type: 'identity', publicKey: '04'.padEnd(130, 'a') })).status).toBe(403);
      expect((await request(server, 'GET', '/auth/methods')).status).toBe(200);
    } finally {
      mockApplicationId = undefined;
    }
  });
});

describe('GET /auth/methods contract (B4)', () => {
  it('returns the account DID plus contract-shaped methods built from the child table', async () => {
    const publicKey = generateSecp256k1KeyPair().publicKey.toLowerCase();
    await addIdentity(currentUserId, publicKey);

    const res = await request(server, 'GET', '/auth/methods');

    expect(res.status).toBe(200);
    expect(res.body.did).toBe(buildUserDid(currentUserId));
    const methods = res.body.methods as Array<{ type: string; verificationMethodId?: string }>;
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({ type: 'identity', verificationMethodId: '#key-1' });
    // The legacy free-form `identifier` field is gone — the response is exactly
    // the `authMethodsResponseSchema` shape.
    expect((methods[0] as Record<string, unknown>).identifier).toBeUndefined();
  });

  it('lists no method for an account without a key', async () => {
    const res = await request(server, 'GET', '/auth/methods');

    expect(res.status).toBe(200);
    expect(res.body.methods).toEqual([]);
  });
});
