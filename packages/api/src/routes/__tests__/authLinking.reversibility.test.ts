/**
 * Root authority on auth-method linking (ADR 0024 D8), against a REAL Postgres.
 *
 * Linking is FIRST LINK ONLY: a keyless personal account gains a root only with
 * a one-use root proof AND a fresh assertion by one of its existing passkeys; an
 * account that has a different root is never overwritten; a root is never
 * unlinked back to custodial; and removing a passkey never strands the web
 * holder (its wrap goes with it, and the last wrap stays). The DID flips to
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

import { generateSecp256k1KeyPair } from '@oxy.so/protocol/secp256k1';
import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';

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

const mockVerifyAuthentication = jest.fn();
jest.mock('@simplewebauthn/server', () => ({
  ...jest.requireActual('@simplewebauthn/server'),
  verifyAuthenticationResponse: (...args: unknown[]) => mockVerifyAuthentication(...args),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import { webauthnCredentials } from '../../db/schema/webauthnCredentials';
import authLinkingRouter from '../authLinking';
import SignatureService from '../../services/signature.service';
import { buildDidDocument, buildUserDid, OXY_DID } from '../../services/did.service';
import { mintIdentityProofChallenge } from '../../services/identityProof.service';
import { identityWebEnvelopes } from '../../db/schema/identityWebEnvelopes';
import {
  deriveIdentityFromPrivateKey,
  digestIdentityPayload,
  generateWebIdentity,
  sealWebIdentity,
  signIdentityProof,
  type OpenedWebIdentity,
} from '@oxy.so/core';
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

/** A v2 root proof for `action` on the current account, spending a freshly minted challenge. */
async function rootProof(identity: OpenedWebIdentity, action: IdentityProofAction, overrides: { payloadDigest?: string | null; subject?: string } = {}) {
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

/** A WebAuthn assertion by `credentialId` over `challengeHex`, from `origin`. The signature check is mocked. */
function assertionFor(credentialId: string, challengeHex: string, origin = 'https://accounts.oxy.so') {
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(challengeHex, 'hex').toString('base64url'), origin }),
  ).toString('base64url');
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: { clientDataJSON, authenticatorData: 'AAAA', signature: 'AAAA' },
    clientExtensionResults: {},
  };
}

async function baselineCredentialId(): Promise<string> {
  const [baseline] = await storedAuthMethods(currentUserId);
  return baseline.methodCredentialId as string;
}

describe('first link only (ADR 0024 D8)', () => {
  beforeEach(() => {
    mockVerifyAuthentication.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 0, userVerified: true } });
  });

  it('links a keyless account’s first root with a root proof and a fresh passkey assertion', async () => {
    const identity = generateWebIdentity();
    expect((await storedDidDocument(currentUserId)).controller).toEqual([OXY_DID]);

    const proof = await rootProof(identity, 'link_identity');
    const res = await request(server, 'POST', '/auth/link', {
      type: 'identity',
      publicKey: identity.publicKey,
      proof,
      assertion: assertionFor(await baselineCredentialId(), proof.challenge),
    });

    expect(res.body).toMatchObject({ success: true });
    expect(res.status).toBe(200);
    expect((await storedUser(currentUserId)).publicKey).toBe(identity.publicKey);
    expect((await storedAuthMethods(currentUserId)).filter((m) => m.type === 'identity')).toHaveLength(1);
    expect(mockInvalidate).toHaveBeenCalledWith(currentUserId);
    // Self-sovereign: controlled by the person, not co-controlled by Oxy.
    expect((await storedDidDocument(currentUserId)).controller).toEqual([buildUserDid(currentUserId)]);
  });

  it('refuses a keyless account’s first link carried by a bearer and a new key alone', async () => {
    const identity = generateWebIdentity();
    const noAssertion = await request(server, 'POST', '/auth/link', { type: 'identity', publicKey: identity.publicKey, proof: await rootProof(identity, 'link_identity') });
    expect(noAssertion.status).toBe(401);

    expect((noAssertion.body as { error?: string }).error).toBe(IDENTITY_ERROR_CODES.freshFactorRequired);
    expect((await storedUser(currentUserId)).publicKey).toBeNull();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('refuses an assertion made over a different challenge, and a replayed proof', async () => {
    const identity = generateWebIdentity();
    const proof = await rootProof(identity, 'link_identity');
    const elsewhere = await request(server, 'POST', '/auth/link', {
      type: 'identity',
      publicKey: identity.publicKey,
      proof,
      assertion: assertionFor(await baselineCredentialId(), 'ff'.repeat(32)),
    });
    expect(elsewhere.status).toBe(401);
    expect((await storedUser(currentUserId)).publicKey).toBeNull();

    const body = { type: 'identity', publicKey: identity.publicKey, proof, assertion: assertionFor(await baselineCredentialId(), proof.challenge) };
    expect((await request(server, 'POST', '/auth/link', body)).status).toBe(200);
    const other = await account();
    await addPasskey(other);
    currentUserId = other;
    expect((await request(server, 'POST', '/auth/link', body)).status).toBe(401);
  });

  it('never replaces an existing different root, whatever proofs come with the request', async () => {
    const existing = deriveIdentityFromPrivateKey('11'.repeat(32));
    await addIdentity(currentUserId, existing.publicKey);
    const intruder = generateWebIdentity();

    const proof = await rootProof(existing, 'link_identity');
    const res = await request(server, 'POST', '/auth/link', {
      type: 'identity',
      publicKey: intruder.publicKey,
      proof,
      assertion: assertionFor(await baselineCredentialId(), proof.challenge),
    });

    expect(res.status).toBe(409);
    expect((res.body as { error?: string }).error).toBe(IDENTITY_ERROR_CODES.rootAlreadyLinked);
    expect((await storedUser(currentUserId)).publicKey).toBe(existing.publicKey);
  });

  it('heals a missing identity method row for the SAME root, with a root proof, without adding a second', async () => {
    const identity = generateWebIdentity();
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
    const taken = generateWebIdentity();
    const other = await account();
    await addIdentity(other, taken.publicKey);

    const proof = await rootProof(taken, 'link_identity');
    const res = await request(server, 'POST', '/auth/link', {
      type: 'identity',
      publicKey: taken.publicKey,
      proof,
      assertion: assertionFor(await baselineCredentialId(), proof.challenge),
    });

    expect(res.status).toBe(409);
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

describe('removing a passkey that holds the root on the web (ADR 0024 D6)', () => {
  async function webHolder(credentialIds: string[]) {
    const identity = generateWebIdentity();
    await addIdentity(currentUserId, identity.publicKey);
    const sealed = sealWebIdentity(identity, { prfOutput: new Uint8Array(32).fill(1), credentialId: credentialIds[0], rpId: 'oxy.so' });
    let envelope = sealed.envelope;
    const dataKey = sealed.dataKey;
    for (const [index, credentialId] of credentialIds.slice(1).entries()) {
      const { addWrap } = await import('@oxy.so/core');
      envelope = addWrap(envelope, dataKey, { prfOutput: new Uint8Array(32).fill(index + 2), credentialId, rpId: 'oxy.so' });
    }
    dataKey.fill(0);
    await getDb().insert(identityWebEnvelopes).values({
      userId: currentUserId,
      publicKey: identity.publicKey,
      version: 2,
      algorithm: 'xchacha20poly1305',
      secretKind: envelope.secretKind,
      entropyNonce: envelope.secretNonce,
      sealedEntropy: envelope.sealedSecret,
      wraps: envelope.wraps,
      revision: 3,
    });
    return digestIdentityPayload(envelope);
  }

  async function storedEnvelope() {
    const [row] = await getDb().select().from(identityWebEnvelopes).where(eq(identityWebEnvelopes.userId, currentUserId));
    return row;
  }

  it('refuses to remove the passkey whose wrap is the LAST one', async () => {
    const credentialId = await baselineCredentialId();
    await webHolder([credentialId]);

    const res = await request(server, 'DELETE', `/auth/link/webauthn/${credentialId}`);

    expect(res.status).toBe(409);
    expect((res.body as { error?: string }).error).toBe(IDENTITY_ERROR_CODES.lastWebHolder);
    expect((await storedEnvelope()).wraps).toHaveLength(1);
    expect((await storedAuthMethods(currentUserId)).some((m) => m.methodCredentialId === credentialId)).toBe(true);
  });

  it('removes the passkey AND its wrap when another wrap remains, bumping the revision', async () => {
    const baseline = await baselineCredentialId();
    const second = await addPasskey(currentUserId, 'Second');
    await webHolder([baseline, second]);

    const res = await request(server, 'DELETE', `/auth/link/webauthn/${second}`);

    expect(res.status).toBe(200);
    const envelope = await storedEnvelope();
    expect(envelope.wraps.map((wrap) => wrap.credentialId)).toEqual([baseline]);
    expect(envelope.revision).toBe(4);
  });
});

describe('rotation retires the old root’s web holder', () => {
  it('deletes the envelope sealing the old root in the same swap', async () => {
    const oldRoot = generateSecp256k1KeyPair();
    await addIdentity(currentUserId, oldRoot.publicKey.toLowerCase());
    await getDb().insert(identityWebEnvelopes).values({
      userId: currentUserId,
      publicKey: oldRoot.publicKey.toLowerCase(),
      version: 2,
      algorithm: 'xchacha20poly1305',
      secretKind: 'mnemonic-entropy',
      entropyNonce: 'aa'.repeat(24),
      sealedEntropy: 'bb'.repeat(32),
      wraps: [{ credentialId: 'credential-aaaaaaaaaaaaaaaa', nonce: 'cc'.repeat(24), wrappedKey: 'dd'.repeat(48), createdAt: new Date().toISOString(), rpId: 'oxy.so' }],
    });

    const challengeRes = await request(server, 'POST', '/auth/rotate/challenge');
    expect(challengeRes.status).toBe(200);
    const challenge = challengeRes.body.challenge as string;
    const newRoot = generateSecp256k1KeyPair();
    const timestamp = Date.now();
    const signature = SignatureService.signMessage(
      JSON.stringify({ action: 'rotate_key', userId: currentUserId, oldPublicKey: SignatureService.canonicalizePublicKey(oldRoot.publicKey), newPublicKey: newRoot.publicKey, challenge, timestamp }),
      oldRoot.privateKey,
    );
    const newKeyProof = SignatureService.signMessage(
      JSON.stringify({ action: 'rotate_key_new', userId: currentUserId, newPublicKey: newRoot.publicKey, challenge, timestamp }),
      newRoot.privateKey,
    );

    const res = await request(server, 'POST', '/auth/rotate/complete', { newPublicKey: newRoot.publicKey, challenge, signature, newKeyProof, timestamp });

    expect(res.status).toBe(200);
    const rows = await getDb().select({ id: identityWebEnvelopes.id }).from(identityWebEnvelopes).where(eq(identityWebEnvelopes.userId, currentUserId));
    expect(rows).toHaveLength(0);
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
