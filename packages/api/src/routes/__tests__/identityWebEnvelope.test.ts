/**
 * Web identity carrier routes, against a REAL Postgres.
 *
 * The guarantees are about who can read or change the sealed web copy of an
 * identity, and about the bytes that end up stored:
 *  - only the identity origin (or loopback) is served, even with a valid bearer;
 *  - every write needs a one-use root proof bound to ITS action, account, root,
 *    envelope digest, revision and audience — a bearer alone, a replay, a
 *    different envelope, a stale revision or another action is refused;
 *  - an envelope can only ever seal the account's linked identity, and one that
 *    no longer matches it (rotated or moved) reads as absent;
 *  - the stored row is the ciphertext the client produced and nothing more;
 *  - confirming the phrase survives re-wrapping, and the row dies with the account.
 *
 * The envelopes are produced by the real `@oxy.so/core` carrier crypto, so a
 * drift between what the client seals and what the server accepts fails here.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import {
  addWrap,
  deriveIdentityFromPrivateKey,
  digestIdentityPayload,
  generateWebIdentity,
  sealWebIdentity,
  signIdentityProof,
  type OpenedWebIdentity,
} from '@oxy.so/core';
import { IDENTITY_ERROR_CODES, IDENTITY_PROOF_AUDIENCE, type IdentityProofAction, type WebIdentityEnvelope } from '@oxy.so/contracts';
import { mintIdentityProofChallenge } from '../../services/identityProof.service';
import { webauthnCredentials } from '../../db/schema/webauthnCredentials';

let currentUserId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { _id: string; id: string } }, _res: unknown, next: () => void) => {
    req.user = { _id: currentUserId, id: currentUserId };
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
const mockVerifyAuthentication = jest.fn();
jest.mock('@simplewebauthn/server', () => ({
  ...jest.requireActual('@simplewebauthn/server'),
  verifyAuthenticationResponse: (...args: unknown[]) => mockVerifyAuthentication(...args),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { identityWebEnvelopes } from '../../db/schema/identityWebEnvelopes';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import identityWebEnvelopeRouter from '../identityWebEnvelope';

const IDENTITY_ORIGIN = 'https://id.oxy.so';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;

async function request(
  method: string,
  path: string,
  payload?: unknown,
  origin: string | null = IDENTITY_ORIGIN,
): Promise<JsonResponse> {
  const { port } = server.address() as AddressInfo;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  const response = await fetch(`http://127.0.0.1:${port}/identity/web-envelope${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const raw = await response.text();
  return { status: response.status, body: raw.length > 0 ? JSON.parse(raw) : {} };
}

/** An account with a freshly generated, linked identity. */
async function accountWithIdentity(): Promise<{ userId: string; identity: OpenedWebIdentity }> {
  const identity = generateWebIdentity();
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal', publicKey: identity.publicKey })
    .returning({ id: users.id });
  return { userId: row.id, identity };
}

const prf = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/identity/web-envelope', identityWebEnvelopeRouter);
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

describe('origin', () => {
  it('serves no origin but the identity carrier’s, even to a signed-in caller', async () => {
    const { userId } = await accountWithIdentity();
    currentUserId = userId;

    expect((await request('GET', '/', undefined, 'https://accounts.oxy.so')).status).toBe(403);
    expect((await request('GET', '/', undefined, 'https://mention.earth')).status).toBe(403);
    expect((await request('GET', '/', undefined, null)).status).toBe(403);
    expect((await request('GET', '/')).status).toBe(200);
  });

  it('accepts loopback origins in every environment', async () => {
    const { userId } = await accountWithIdentity();
    currentUserId = userId;
    expect((await request('GET', '/', undefined, 'http://localhost:8110')).status).toBe(200);
  });
});

/* ------------------------------------------------------------------------- */
/* Version-2 proofs (ADR 0024 D7): payload-bound, revision-bound, one use.    */
/* ------------------------------------------------------------------------- */

async function v2Proof(
  identity: OpenedWebIdentity,
  userId: string,
  action: IdentityProofAction,
  claims: { payload?: unknown; expectedRevision?: number | null } = {},
) {
  const minted = await mintIdentityProofChallenge(userId, action);
  return signIdentityProof(identity, {
    action,
    subject: userId,
    actor: userId,
    rootPublicKey: identity.publicKey,
    payloadDigest: claims.payload === undefined ? null : digestIdentityPayload(claims.payload),
    expectedRevision: claims.expectedRevision ?? null,
    audience: IDENTITY_PROOF_AUDIENCE,
    challenge: minted.challenge,
    expiresAt: minted.expiresAt,
  });
}

function sealV2(identity: OpenedWebIdentity, credentialId = 'credential-aaaaaaaaaaaaaaaa', fill = 5): WebIdentityEnvelope {
  const { envelope, dataKey } = sealWebIdentity(identity, { prfOutput: prf(fill), credentialId, rpId: 'oxy.so' }, new Date(), { version: 2 });
  dataKey.fill(0);
  return envelope;
}

async function putV2(identity: OpenedWebIdentity, userId: string, envelope: WebIdentityEnvelope, expectedRevision: number) {
  const proof = await v2Proof(identity, userId, 'web_envelope_put', { payload: envelope, expectedRevision });
  return request('PUT', '/', { envelope, expectedRevision, proof });
}

const errorCode = (res: JsonResponse) => (res.body as { error?: string }).error;

describe('v2: writing the envelope', () => {
  it('stores a version-2 envelope at revision 1, then replaces it at revision 2', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;

    const first = sealV2(identity);
    const created = await putV2(identity, userId, first, 0);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ envelope: first, revision: 1, rootLinked: true });
    expect(created.body.holders).toEqual([{ credentialId: 'credential-aaaaaaaaaaaaaaaa', rpId: 'oxy.so', verifiedAt: null, createdAt: first.wraps[0].createdAt }]);

    const second = sealV2(identity, 'credential-bbbbbbbbbbbbbbbb', 7);
    const replaced = await putV2(identity, userId, second, 1);
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ envelope: second, revision: 2 });
  });

  it('stores a raw-key root without inventing a phrase', async () => {
    const identity = deriveIdentityFromPrivateKey('2a'.repeat(32));
    const [row] = await getDb().insert(users).values({ color: 'teal', publicKey: identity.publicKey }).returning({ id: users.id });
    currentUserId = row.id;
    const envelope = sealV2(identity);
    const res = await putV2(identity, row.id, envelope, 0);
    expect(res.status).toBe(200);
    expect(res.body.envelope).toEqual(envelope);
    expect((res.body.envelope as { secretKind: string }).secretKind).toBe('raw-private-key');
  });

  it('refuses different envelope bytes under a valid proof', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const signed = sealV2(identity);
    const proof = await v2Proof(identity, userId, 'web_envelope_put', { payload: signed, expectedRevision: 0 });
    const swapped = sealV2(identity, 'credential-cccccccccccccccc', 9);

    const res = await request('PUT', '/', { envelope: swapped, expectedRevision: 0, proof });
    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe(IDENTITY_ERROR_CODES.proofInvalid);
    expect((await request('GET', '/')).body.envelope).toBeNull();
  });

  it('refuses a replayed proof even for the exact same write', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const envelope = sealV2(identity);
    const proof = await v2Proof(identity, userId, 'web_envelope_put', { payload: envelope, expectedRevision: 0 });

    expect((await request('PUT', '/', { envelope, expectedRevision: 0, proof })).status).toBe(200);
    const replay = await request('PUT', '/', { envelope, expectedRevision: 0, proof });
    expect(replay.status).toBe(401);
  });

  it('refuses a proof for another action, account, revision or audience', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const envelope = sealV2(identity);

    const wrongAction = await v2Proof(identity, userId, 'web_envelope_delete', { payload: envelope, expectedRevision: 0 });
    expect((await request('PUT', '/', { envelope, expectedRevision: 0, proof: wrongAction })).status).toBe(401);

    const wrongRevision = await v2Proof(identity, userId, 'web_envelope_put', { payload: envelope, expectedRevision: 5 });
    expect((await request('PUT', '/', { envelope, expectedRevision: 0, proof: wrongRevision })).status).toBe(401);

    const minted = await mintIdentityProofChallenge(userId, 'web_envelope_put');
    const wrongAudience = await signIdentityProof(identity, {
      action: 'web_envelope_put',
      subject: userId,
      actor: userId,
      rootPublicKey: identity.publicKey,
      payloadDigest: digestIdentityPayload(envelope),
      expectedRevision: 0,
      audience: 'somewhere-else',
      challenge: minted.challenge,
      expiresAt: minted.expiresAt,
    });
    expect((await request('PUT', '/', { envelope, expectedRevision: 0, proof: wrongAudience })).status).toBe(401);

    const other = await accountWithIdentity();
    const otherChallenge = await v2Proof(identity, other.userId, 'web_envelope_put', { payload: envelope, expectedRevision: 0 });
    expect((await request('PUT', '/', { envelope, expectedRevision: 0, proof: otherChallenge })).status).toBe(401);

    expect((await request('GET', '/')).body.envelope).toBeNull();
  });

  it('lets exactly one of two concurrent holder changes win; the other must re-read', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const base = sealWebIdentity(identity, { prfOutput: prf(1), credentialId: 'credential-aaaaaaaaaaaaaaaa', rpId: 'oxy.so' }, new Date(), { version: 2 });
    expect((await putV2(identity, userId, base.envelope, 0)).status).toBe(200);

    const withB = addWrap(base.envelope, base.dataKey, { prfOutput: prf(2), credentialId: 'credential-bbbbbbbbbbbbbbbb', rpId: 'oxy.so' });
    const withC = addWrap(base.envelope, base.dataKey, { prfOutput: prf(3), credentialId: 'credential-cccccccccccccccc', rpId: 'oxy.so' });
    base.dataKey.fill(0);

    const [a, b] = await Promise.all([putV2(identity, userId, withB, 1), putV2(identity, userId, withC, 1)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(errorCode(loser)).toBe(IDENTITY_ERROR_CODES.revisionConflict);
    expect((await request('GET', '/')).body.revision).toBe(2);
  });

  it('removes the web holder only for the revision the proof names', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    expect((await putV2(identity, userId, sealV2(identity), 0)).status).toBe(200);

    const stale = await v2Proof(identity, userId, 'web_envelope_delete', { expectedRevision: 7 });
    expect((await request('DELETE', '/', { expectedRevision: 7, proof: stale })).status).toBe(409);
    expect((await request('GET', '/')).body.envelope).not.toBeNull();

    const current = await v2Proof(identity, userId, 'web_envelope_delete', { expectedRevision: 1 });
    expect((await request('DELETE', '/', { expectedRevision: 1, proof: current })).status).toBe(200);
    expect((await request('GET', '/')).body.envelope).toBeNull();
  });

  it('records the recovery facts separately, and only with a v2 proof', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    expect((await putV2(identity, userId, sealV2(identity), 0)).status).toBe(200);

    const verified = await request('POST', '/recovery-verified', {
      expectedRevision: 1,
      proof: await v2Proof(identity, userId, 'web_envelope_recovery_verified', { expectedRevision: 1 }),
    });
    expect(verified.status).toBe(200);
    expect(typeof verified.body.recoveryVerifiedAt).toBe('string');
    expect(verified.body.phraseConfirmedAt).toBeNull();
    expect(verified.body.revision).toBe(1);

    const v1 = await request('POST', '/recovery-verified', { signature: 'ab', timestamp: Date.now() });
    expect(v1.status).toBe(400);
  });
});

describe('v2: establishing a keyless account’s first root', () => {
  const credentialId = 'passkey-establish-aaaaaaaa';

  async function keylessWithPasskey(): Promise<string> {
    const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
    await getDb().insert(webauthnCredentials).values({
      userId: row.id,
      credentialID: `${credentialId}${row.id.replace(/-/g, '')}`,
      credentialPublicKey: Buffer.from([1, 2, 3]),
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
      userVerified: true,
      name: 'Passkey',
    });
    return row.id;
  }

  function assertion(userId: string, challengeHex: string, origin = IDENTITY_ORIGIN) {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(challengeHex, 'hex').toString('base64url'), origin }),
    ).toString('base64url');
    const id = `${credentialId}${userId.replace(/-/g, '')}`;
    return { id, rawId: id, type: 'public-key', response: { clientDataJSON, authenticatorData: 'AAAA', signature: 'AAAA' } };
  }

  beforeEach(() => {
    mockVerifyAuthentication.mockReset();
    mockVerifyAuthentication.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 0, userVerified: true } });
  });

  it('links the root and stores its envelope with a fresh assertion over the proof challenge', async () => {
    const userId = await keylessWithPasskey();
    currentUserId = userId;
    const identity = generateWebIdentity();
    const envelope = sealV2(identity);
    const rootProof = await v2Proof(identity, userId, 'web_envelope_establish', { payload: envelope });

    const res = await request('POST', '/establish', { envelope, proof: rootProof, assertion: assertion(userId, rootProof.challenge) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ envelope, revision: 1, rootLinked: true });
    const [row] = await getDb().select({ publicKey: users.publicKey }).from(users).where(eq(users.id, userId));
    expect(row.publicKey).toBe(identity.publicKey);
    const methods = await getDb()
      .select({ type: userAuthMethods.type, methodPublicKey: userAuthMethods.methodPublicKey })
      .from(userAuthMethods)
      .where(eq(userAuthMethods.userId, userId));
    expect(methods).toEqual([{ type: 'identity', methodPublicKey: identity.publicKey }]);
    expect(mockVerifyAuthentication).toHaveBeenCalledWith(expect.objectContaining({ requireUserVerification: true }));
  });

  it('never replaces an identity the account already has, nor claims one linked elsewhere', async () => {
    const userId = await keylessWithPasskey();
    currentUserId = userId;
    const existing = generateWebIdentity();
    await getDb().update(users).set({ publicKey: existing.publicKey }).where(eq(users.id, userId));
    const intruder = generateWebIdentity();
    const envelope = sealV2(intruder);
    await expect(v2Proof(intruder, userId, 'web_envelope_establish', { payload: envelope })).resolves.toBeDefined();
    const minted = await mintIdentityProofChallenge(userId, 'web_envelope_establish');
    const proof = await signIdentityProof(intruder, {
      action: 'web_envelope_establish', subject: userId, actor: userId, rootPublicKey: intruder.publicKey,
      payloadDigest: digestIdentityPayload(envelope), expectedRevision: null, audience: IDENTITY_PROOF_AUDIENCE,
      challenge: minted.challenge, expiresAt: minted.expiresAt,
    });
    const replaced = await request('POST', '/establish', { envelope, proof, assertion: assertion(userId, proof.challenge) });
    expect(replaced.status).toBe(409);
    const [row] = await getDb().select({ publicKey: users.publicKey }).from(users).where(eq(users.id, userId));
    expect(row.publicKey).toBe(existing.publicKey);

    const other = await keylessWithPasskey();
    currentUserId = other;
    const taken = sealV2(existing);
    const takenProof = await v2Proof(existing, other, 'web_envelope_establish', { payload: taken });
    const claimed = await request('POST', '/establish', { envelope: taken, proof: takenProof, assertion: assertion(other, takenProof.challenge) });
    expect(claimed.status).toBe(409);
  });

  it('refuses an assertion from another origin, over another challenge, or that does not verify', async () => {
    const userId = await keylessWithPasskey();
    currentUserId = userId;
    const identity = generateWebIdentity();
    const envelope = sealV2(identity);

    const p1 = await v2Proof(identity, userId, 'web_envelope_establish', { payload: envelope });
    const otherOrigin = await request('POST', '/establish', { envelope, proof: p1, assertion: assertion(userId, p1.challenge, 'https://mention.earth') });
    expect(otherOrigin.status).toBe(401);
    expect(errorCode(otherOrigin)).toBe(IDENTITY_ERROR_CODES.freshFactorRequired);

    const p2 = await v2Proof(identity, userId, 'web_envelope_establish', { payload: envelope });
    const otherChallenge = await request('POST', '/establish', { envelope, proof: p2, assertion: assertion(userId, 'ee'.repeat(32)) });
    expect(otherChallenge.status).toBe(401);

    mockVerifyAuthentication.mockResolvedValueOnce({ verified: false, authenticationInfo: { newCounter: 0, userVerified: false } });
    const p3 = await v2Proof(identity, userId, 'web_envelope_establish', { payload: envelope });
    const unverified = await request('POST', '/establish', { envelope, proof: p3, assertion: assertion(userId, p3.challenge) });
    expect(unverified.status).toBe(401);

    const [row] = await getDb().select({ publicKey: users.publicKey }).from(users).where(eq(users.id, userId));
    expect(row.publicKey).toBeNull();
  });

  it('refuses a missing assertion at validation', async () => {
    const userId = await keylessWithPasskey();
    currentUserId = userId;
    const identity = generateWebIdentity();
    const envelope = sealV2(identity);
    const rootProof = await v2Proof(identity, userId, 'web_envelope_establish', { payload: envelope });
    expect((await request('POST', '/establish', { envelope, proof: rootProof })).status).toBe(400);
  });
});

describe('minting proof challenges', () => {
  it('refuses challenges for holder writes on an account with no root, and for non-personal accounts', async () => {
    const [keyless] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
    await expect(mintIdentityProofChallenge(keyless.id, 'web_envelope_put')).rejects.toMatchObject({ code: IDENTITY_ERROR_CODES.noRoot });
    await expect(mintIdentityProofChallenge(keyless.id, 'web_envelope_establish')).resolves.toMatchObject({ audience: IDENTITY_PROOF_AUDIENCE });

    const [organization] = await getDb().insert(users).values({ color: 'teal', kind: 'organization' }).returning({ id: users.id });
    await expect(mintIdentityProofChallenge(organization.id, 'web_envelope_establish')).rejects.toMatchObject({ code: IDENTITY_ERROR_CODES.notPersonal });
  });

  it('never mints enrollment or recovery challenges through the bearer lane', async () => {
    const { userId } = await accountWithIdentity();
    await expect(mintIdentityProofChallenge(userId, 'enroll_identity')).rejects.toMatchObject({ statusCode: 400 });
    await expect(mintIdentityProofChallenge(userId, 'recover_account_start')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('binds the challenge to the root linked when it was minted', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const envelope = sealV2(identity);
    const proof = await v2Proof(identity, userId, 'web_envelope_put', { payload: envelope, expectedRevision: 0 });
    // The root changes between mint and use (a rotation elsewhere).
    const rotated = generateWebIdentity();
    await getDb().update(users).set({ publicKey: rotated.publicKey }).where(eq(users.id, userId));
    const res = await request('PUT', '/', { envelope, expectedRevision: 0, proof });
    expect(res.status).toBe(401);
  });
});

describe('storing the envelope', () => {
  it('stores the ciphertext only — no phrase, no private key', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const envelope = sealV2(identity);
    expect((await putV2(identity, userId, envelope, 0)).status).toBe(200);

    const [row] = await getDb().select().from(identityWebEnvelopes).where(eq(identityWebEnvelopes.userId, userId));
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(identity.privateKey);
    for (const word of new Set((identity.mnemonic as string).split(' '))) {
      expect(serialized).not.toMatch(new RegExp(`\\b${word}\\b`));
    }
  });

  it('refuses a write carried by a bearer alone, or a version-1 proof', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    expect((await request('PUT', '/', { envelope: sealV2(identity) })).status).toBe(400);
    expect((await request('PUT', '/', { envelope: sealV2(identity), signature: 'ab', timestamp: Date.now() })).status).toBe(400);
  });

  it('refuses a proof signed by a different key', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const envelope = sealV2(identity);
    const minted = await mintIdentityProofChallenge(userId, 'web_envelope_put');
    const forged = await signIdentityProof(generateWebIdentity(), {
      action: 'web_envelope_put',
      subject: userId,
      actor: userId,
      rootPublicKey: identity.publicKey,
      payloadDigest: digestIdentityPayload(envelope),
      expectedRevision: 0,
      audience: IDENTITY_PROOF_AUDIENCE,
      challenge: minted.challenge,
      expiresAt: minted.expiresAt,
    }).catch(() => null);
    // The signer refuses to sign for a root it does not hold; a raw forgery is refused by the API.
    expect(forged).toBeNull();
    const res = await request('PUT', '/', { envelope, expectedRevision: 0, proof: { v: 2, challenge: minted.challenge, expiresAt: minted.expiresAt, signature: 'deadbeef' } });
    expect(res.status).toBe(401);
  });

  it('refuses an envelope that seals any identity but the account’s own', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const foreign = sealV2(generateWebIdentity());
    const res = await putV2(identity, userId, foreign, 0);
    expect(res.status).toBe(400);
  });

  it('refuses an account with no linked identity', async () => {
    const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
    currentUserId = row.id;
    await expect(mintIdentityProofChallenge(row.id, 'web_envelope_put')).rejects.toMatchObject({ code: IDENTITY_ERROR_CODES.noRoot });
  });

  it('replaces rather than accumulates, and a re-wrap keeps the saved-phrase state', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    expect((await putV2(identity, userId, sealV2(identity), 0)).status).toBe(200);
    const confirmed = await request('POST', '/phrase-confirmed', {
      expectedRevision: 1,
      proof: await v2Proof(identity, userId, 'web_envelope_phrase_confirmed', { expectedRevision: 1 }),
    });
    expect(confirmed.status).toBe(200);
    expect(typeof confirmed.body.phraseConfirmedAt).toBe('string');

    const rewrapped = sealV2(identity, 'credential-bbbbbbbbbbbbbbbb', 9);
    const put = await putV2(identity, userId, rewrapped, 1);
    expect(put.body.envelope).toEqual(rewrapped);
    expect(put.body.phraseConfirmedAt).toBe(confirmed.body.phraseConfirmedAt);

    const rows = await getDb().select({ id: identityWebEnvelopes.id }).from(identityWebEnvelopes).where(eq(identityWebEnvelopes.userId, userId));
    expect(rows).toHaveLength(1);
  });
});

describe('an identity that moved on', () => {
  it('reads as absent once the account’s identity key is no longer the one sealed', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    expect((await putV2(identity, userId, sealV2(identity), 0)).status).toBe(200);
    await getDb().update(users).set({ publicKey: generateWebIdentity().publicKey }).where(eq(users.id, userId));
    expect((await request('GET', '/')).body.envelope).toBeNull();
  });
});

describe('confirming the phrase', () => {
  it('needs an envelope to confirm, and a version-2 proof', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const res = await request('POST', '/phrase-confirmed', {
      expectedRevision: 0,
      proof: await v2Proof(identity, userId, 'web_envelope_phrase_confirmed', { expectedRevision: 0 }),
    });
    expect(res.status).toBe(400);
    expect((await request('POST', '/phrase-confirmed', { signature: 'ab', timestamp: Date.now() })).status).toBe(400);
  });
});

describe('removing the web holder', () => {
  it('deletes only with a proof for the delete action, and is idempotent', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    expect((await putV2(identity, userId, sealV2(identity), 0)).status).toBe(200);

    const wrongAction = await v2Proof(identity, userId, 'web_envelope_put', { expectedRevision: 1 });
    expect((await request('DELETE', '/', { expectedRevision: 1, proof: wrongAction })).status).toBe(401);
    expect((await request('GET', '/')).body.envelope).not.toBeNull();

    expect((await request('DELETE', '/', { expectedRevision: 1, proof: await v2Proof(identity, userId, 'web_envelope_delete', { expectedRevision: 1 }) })).status).toBe(200);
    expect((await request('GET', '/')).body.envelope).toBeNull();
    expect((await request('DELETE', '/', { expectedRevision: 0, proof: await v2Proof(identity, userId, 'web_envelope_delete', { expectedRevision: 0 }) })).status).toBe(200);
  });

  it('dies with the account', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    expect((await putV2(identity, userId, sealV2(identity), 0)).status).toBe(200);
    await getDb().delete(users).where(eq(users.id, userId));
    const rows = await getDb().select({ id: identityWebEnvelopes.id }).from(identityWebEnvelopes).where(eq(identityWebEnvelopes.userId, userId));
    expect(rows).toHaveLength(0);
  });
});
