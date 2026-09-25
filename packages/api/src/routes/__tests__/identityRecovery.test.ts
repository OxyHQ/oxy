/**
 * Signed-out recovery (ADR 0024 D5), against a REAL Postgres.
 *
 * The only authority is a signature by the account's CURRENT root: no passkey,
 * no session. A request without the root learns nothing; a root no account uses
 * is told so (its holder is the only one who can ask); every step is one use; a
 * rotation between steps voids the attempt; and completion adds exactly one
 * passkey, replaces the web holder with the root sealed under it, records both
 * readiness facts, and mints a normal session.
 *
 * `@simplewebauthn/server`'s attestation check is mocked at the module boundary;
 * the root proofs and the envelope crypto are real.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const mockVerifyRegistration = jest.fn();
jest.mock('@simplewebauthn/server', () => ({
  ...jest.requireActual('@simplewebauthn/server'),
  verifyRegistrationResponse: (...args: unknown[]) => mockVerifyRegistration(...args),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: {
    createSession: jest.fn(async () => ({ sessionId: `sess-${randomUUID()}`, deviceId: `dev-${randomUUID()}`, expiresAt: new Date('2030-01-01T00:00:00.000Z') })),
    getAccessToken: jest.fn(async () => ({ accessToken: 'access-token-1', expiresAt: new Date('2030-01-01T00:00:00.000Z') })),
  },
}));
jest.mock('../../services/deviceLogin.service', () => ({
  __esModule: true,
  finalizeDeviceLogin: jest.fn(async () => ({ deviceSecret: 'device-secret-1' })),
}));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logSignIn: jest.fn(), logSuspiciousActivity: jest.fn() },
}));
jest.mock('../../utils/userCache', () => ({ __esModule: true, default: { invalidate: jest.fn() } }));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));

import {
  deriveIdentityFromPrivateKey,
  digestIdentityPayload,
  generateWebIdentity,
  sealWebIdentity,
  signIdentityProof,
  type OpenedWebIdentity,
} from '@oxy.so/core';
import { IDENTITY_ERROR_CODES, IDENTITY_PROOF_AUDIENCE, type WebIdentityEnvelope } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { getWebauthnRpId } from '../../config/env';
import { identityRecoveryAttempts } from '../../db/schema/identityRecoveryAttempts';
import { identityWebEnvelopes } from '../../db/schema/identityWebEnvelopes';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import { webauthnCredentials } from '../../db/schema/webauthnCredentials';
import { errorHandler } from '../../middleware/errorHandler';
import identityRecoveryRouter from '../identityRecovery';

const HOLDER = 'https://auth.oxy.so';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;

async function request(path: string, payload?: unknown, origin: string | null = HOLDER): Promise<JsonResponse> {
  const { port } = server.address() as AddressInfo;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  const response = await fetch(`http://127.0.0.1:${port}/identity/recovery${path}`, {
    method: 'POST',
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const raw = await response.text();
  return { status: response.status, body: raw.length > 0 ? JSON.parse(raw) : {} };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/identity/recovery', identityRecoveryRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await closePostgres();
});

beforeEach(() => {
  mockVerifyRegistration.mockReset();
});

async function accountWithRoot(identity: OpenedWebIdentity): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `rc${randomUUID().replace(/-/g, '').slice(0, 16)}`, publicKey: identity.publicKey })
    .returning({ id: users.id });
  await getDb().insert(userAuthMethods).values({ userId: row.id, type: 'identity', methodPublicKey: identity.publicKey });
  return row.id;
}

async function startProof(identity: OpenedWebIdentity, challenge: string, expiresAt: number, claimedRoot = identity.publicKey) {
  return signIdentityProof(identity, {
    action: 'recover_account_start',
    subject: `root:${claimedRoot}`,
    actor: 'anonymous',
    rootPublicKey: identity.publicKey,
    payloadDigest: null,
    expectedRevision: null,
    audience: IDENTITY_PROOF_AUDIENCE,
    challenge,
    expiresAt,
  });
}

async function start(identity: OpenedWebIdentity) {
  const challenge = await request('/challenge');
  const { challenge: value, expiresAt } = challenge.body as { challenge: string; expiresAt: number };
  return request('/start', { publicKey: identity.publicKey, proof: await startProof(identity, value, expiresAt) });
}

function newCredentialId(): string {
  return `recovered${randomUUID().replace(/-/g, '')}`;
}

function registrationFor(credentialId: string, origin = HOLDER) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: 'x', origin })).toString('base64url');
  return { id: credentialId, rawId: credentialId, type: 'public-key', response: { clientDataJSON, attestationObject: 'AAAA' }, clientExtensionResults: {} };
}

function acceptRegistration(credentialId: string) {
  mockVerifyRegistration.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: { id: credentialId, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      userVerified: true,
    },
  });
}

async function completeBody(
  identity: OpenedWebIdentity,
  started: { ticket: string; accountId: string; registrationOptions: { challenge: string } },
  credentialId: string,
  overrides: { envelope?: WebIdentityEnvelope; challengeHex?: string } = {},
) {
  let envelope = overrides.envelope;
  if (!envelope) {
    const sealed = sealWebIdentity(identity, { prfOutput: new Uint8Array(32).fill(8), credentialId, rpId: getWebauthnRpId() });
    sealed.dataKey.fill(0);
    envelope = sealed.envelope;
  }
  const proof = await signIdentityProof(identity, {
    action: 'recover_account_complete',
    subject: started.accountId,
    actor: `credential:${credentialId}`,
    rootPublicKey: identity.publicKey,
    payloadDigest: digestIdentityPayload({ envelope }),
    expectedRevision: null,
    audience: IDENTITY_PROOF_AUDIENCE,
    challenge: overrides.challengeHex ?? Buffer.from(started.registrationOptions.challenge, 'base64url').toString('hex'),
    expiresAt: Date.now() + 4 * 60 * 1000,
  });
  return { ticket: started.ticket, response: registrationFor(credentialId), envelope, proof, deviceName: 'Recovered laptop' };
}

type Started = { ticket: string; accountId: string; username: string; registrationOptions: { challenge: string; user: { id: string } } };

describe('signed-out recovery', () => {
  it('recovers the same account from its phrase alone: one new passkey, the web holder replaced, a session', async () => {
    const identity = generateWebIdentity();
    const userId = await accountWithRoot(identity);
    // A stale web holder from before (a lost passkey).
    const lost = sealWebIdentity(identity, { prfOutput: new Uint8Array(32).fill(1), credentialId: 'lost-passkey-aaaaaaaaaaaa', rpId: getWebauthnRpId() });
    lost.dataKey.fill(0);
    await getDb().insert(identityWebEnvelopes).values({
      userId,
      publicKey: identity.publicKey,
      version: 2,
      algorithm: 'xchacha20poly1305',
      secretKind: 'mnemonic-entropy',
      entropyNonce: lost.envelope.secretNonce,
      sealedEntropy: lost.envelope.sealedSecret,
      wraps: lost.envelope.wraps,
      revision: 4,
    });

    const started = await start(identity);
    expect(started.status).toBe(200);
    const body = started.body as unknown as Started;
    expect(body.accountId).toBe(userId);
    expect(Buffer.from(body.registrationOptions.user.id, 'base64url').toString()).toBe(userId);

    const credentialId = newCredentialId();
    acceptRegistration(credentialId);
    const completed = await request('/complete', await completeBody(identity, body, credentialId));

    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ accessToken: 'access-token-1', deviceSecret: 'device-secret-1', user: { id: userId } });
    expect(mockVerifyRegistration).toHaveBeenCalledWith(expect.objectContaining({ requireUserVerification: true, expectedOrigin: HOLDER }));

    const [credential] = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.credentialID, credentialId));
    expect(credential.userId).toBe(userId);
    const [envelope] = await getDb().select().from(identityWebEnvelopes).where(eq(identityWebEnvelopes.userId, userId));
    expect(envelope.wraps.map((wrap) => wrap.credentialId)).toEqual([credentialId]);
    expect(envelope.revision).toBe(5);
    expect(envelope.phraseConfirmedAt).not.toBeNull();
    expect(envelope.recoveryVerifiedAt).not.toBeNull();
    const [account] = await getDb().select({ publicKey: users.publicKey }).from(users).where(eq(users.id, userId));
    expect(account.publicKey).toBe(identity.publicKey);

    // The ticket is spent.
    expect((await request('/complete', await completeBody(identity, body, newCredentialId()))).status).toBe(401);
  });

  it('recovers a raw-key root without inventing a phrase', async () => {
    const identity = deriveIdentityFromPrivateKey('3c'.repeat(32));
    await getDb().delete(users).where(eq(users.publicKey, identity.publicKey));
    const userId = await accountWithRoot(identity);
    const body = (await start(identity)).body as unknown as Started;
    const credentialId = newCredentialId();
    acceptRegistration(credentialId);

    expect((await request('/complete', await completeBody(identity, body, credentialId))).status).toBe(200);
    const [envelope] = await getDb().select({ secretKind: identityWebEnvelopes.secretKind }).from(identityWebEnvelopes).where(eq(identityWebEnvelopes.userId, userId));
    expect(envelope.secretKind).toBe('raw-private-key');
  });

  it('teaches nothing without the root, and tells a root holder only about its own root', async () => {
    const identity = generateWebIdentity();
    await accountWithRoot(identity);
    const impostor = generateWebIdentity();

    const challenge = (await request('/challenge')).body as { challenge: string; expiresAt: number };
    const forged = await request('/start', { publicKey: identity.publicKey, proof: await startProof(impostor, challenge.challenge, challenge.expiresAt, identity.publicKey) });
    expect(forged.status).toBe(401);
    expect(forged.body).not.toHaveProperty('accountId');

    const unused = await start(generateWebIdentity());
    expect(unused.status).toBe(404);
    expect((unused.body as { error?: string }).error).toBe(IDENTITY_ERROR_CODES.recoveryFailed);
  });

  it('spends a challenge once', async () => {
    const identity = generateWebIdentity();
    await accountWithRoot(identity);
    const challenge = (await request('/challenge')).body as { challenge: string; expiresAt: number };
    const proof = await startProof(identity, challenge.challenge, challenge.expiresAt);
    expect((await request('/start', { publicKey: identity.publicKey, proof })).status).toBe(200);
    expect((await request('/start', { publicKey: identity.publicKey, proof })).status).toBe(401);
  });

  it('voids the attempt if the root rotates between steps', async () => {
    const identity = generateWebIdentity();
    const userId = await accountWithRoot(identity);
    const body = (await start(identity)).body as unknown as Started;
    await getDb().update(users).set({ publicKey: generateWebIdentity().publicKey }).where(eq(users.id, userId));
    const credentialId = newCredentialId();
    acceptRegistration(credentialId);
    expect((await request('/complete', await completeBody(identity, body, credentialId))).status).toBe(401);
    expect(await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.credentialID, credentialId))).toHaveLength(0);
  });

  it('refuses an envelope not sealed for exactly the new passkey, and a proof over another challenge', async () => {
    const identity = generateWebIdentity();
    await accountWithRoot(identity);
    const body = (await start(identity)).body as unknown as Started;
    const credentialId = newCredentialId();
    acceptRegistration(credentialId);

    const other = sealWebIdentity(identity, { prfOutput: new Uint8Array(32).fill(2), credentialId: 'some-other-passkey-aaaaaa', rpId: getWebauthnRpId() });
    other.dataKey.fill(0);
    expect((await request('/complete', await completeBody(identity, body, credentialId, { envelope: other.envelope }))).status).toBe(400);
    expect((await request('/complete', await completeBody(identity, body, credentialId, { challengeHex: 'ab'.repeat(32) }))).status).toBe(401);

    // Still usable with a correct body: refusals roll back, they do not burn the ticket.
    expect((await request('/complete', await completeBody(identity, body, credentialId))).status).toBe(200);
  });

  it('refuses a registration from another origin, or one that does not verify', async () => {
    const identity = generateWebIdentity();
    await accountWithRoot(identity);
    const body = (await start(identity)).body as unknown as Started;
    const credentialId = newCredentialId();

    const elsewhere = await completeBody(identity, body, credentialId);
    elsewhere.response = registrationFor(credentialId, 'https://mention.earth');
    expect((await request('/complete', elsewhere)).status).toBe(401);

    mockVerifyRegistration.mockRejectedValue(new Error('bad attestation'));
    expect((await request('/complete', await completeBody(identity, body, credentialId))).status).toBe(401);
  });

  it('refuses an expired attempt and any origin but the holder', async () => {
    const identity = generateWebIdentity();
    await accountWithRoot(identity);
    const body = (await start(identity)).body as unknown as Started;
    await getDb().update(identityRecoveryAttempts).set({ expiresAt: new Date(Date.now() - 1000) });
    const credentialId = newCredentialId();
    acceptRegistration(credentialId);
    expect((await request('/complete', await completeBody(identity, body, credentialId))).status).toBe(401);

    expect((await request('/challenge', undefined, 'https://mention.earth')).status).toBe(403);
    expect((await request('/challenge', undefined, null)).status).toBe(403);
  });
});
