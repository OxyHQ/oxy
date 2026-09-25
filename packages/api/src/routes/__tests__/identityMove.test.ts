/**
 * The identity move relay, against a REAL Postgres.
 *
 * The guarantees are about a move that can only go one way, once, and that a
 * dishonest relay cannot steer:
 *  - only the holder origin (or loopback) may start, reveal, seal or cancel a move;
 *  - a move publishes only a commitment until a device joined, and accepts
 *    exactly the committed key after;
 *  - the first device to join wins; nothing is sealed before the key is revealed;
 *  - sealing needs a one-use root proof over this move and these exact bytes;
 *  - the relay hands out the ciphertext only while sealed, and forgets it once a
 *    receipt by the moved root over the relayed ciphertext arrives;
 *  - a forged or replayed receipt changes nothing, and nothing survives expiry.
 *
 * Both sides run the real `@oxy.so/core` move crypto.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import {
  createMoveCommitment,
  deriveMoveKey,
  deriveMoveSas,
  digestIdentityPayload,
  digestMoveCiphertext,
  generateMoveEphemeralKeyPair,
  generateWebIdentity,
  openMovedIdentity,
  sealIdentityForMove,
  signIdentityProof,
  signMoveReceipt,
  verifyMoveCommitment,
  verifyMoveReceipt,
  type OpenedMnemonicIdentity,
} from '@oxy.so/core';
import { IDENTITY_PROOF_AUDIENCE, buildMoveSealPayload } from '@oxy.so/contracts';
import { signMessage } from '@oxy.so/protocol';

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

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { identityMoves } from '../../db/schema/identityMoves';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { mintIdentityProofChallenge } from '../../services/identityProof.service';
import identityMoveRouter from '../identityMove';

const HOLDER = 'https://auth.oxy.so';
const COMMONS = null;

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;

async function request(method: string, path: string, payload?: unknown, origin: string | null = HOLDER): Promise<JsonResponse> {
  const { port } = server.address() as AddressInfo;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  const response = await fetch(`http://127.0.0.1:${port}/identity/move${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const raw = await response.text();
  return { status: response.status, body: raw.length > 0 ? JSON.parse(raw) : {} };
}

async function accountWithIdentity(): Promise<{ userId: string; identity: OpenedMnemonicIdentity }> {
  const identity = generateWebIdentity();
  const [row] = await getDb().insert(users).values({ color: 'teal', publicKey: identity.publicKey }).returning({ id: users.id });
  currentUserId = row.id;
  return { userId: row.id, identity };
}

/** The web starts a move with a commitment. */
async function start() {
  const account = await accountWithIdentity();
  const web = generateMoveEphemeralKeyPair();
  const { commitment, nonce } = createMoveCommitment(web.publicKey);
  const created = await request('POST', '/', { initiatorCommitment: commitment });
  expect(created.status).toBe(201);
  return { ...account, web, commitment, nonce, moveId: created.body.moveId as string };
}

/** …Commons joins, and the web reveals. */
async function startJoinReveal() {
  const ctx = await start();
  const commons = generateMoveEphemeralKeyPair();
  expect((await request('POST', `/${ctx.moveId}/join`, { responderEphemeralPublicKey: commons.publicKey }, COMMONS)).status).toBe(200);
  expect((await request('POST', `/${ctx.moveId}/reveal`, { initiatorEphemeralPublicKey: ctx.web.publicKey, commitmentNonce: ctx.nonce })).status).toBe(200);
  return { ...ctx, commons };
}

async function sealProof(identity: OpenedMnemonicIdentity, userId: string, moveId: string, sealed: { nonce: string; ciphertext: string }, forMoveId = moveId) {
  const minted = await mintIdentityProofChallenge(userId, 'identity_move_seal');
  return signIdentityProof(identity, {
    action: 'identity_move_seal',
    subject: userId,
    actor: userId,
    rootPublicKey: identity.publicKey,
    payloadDigest: digestIdentityPayload(buildMoveSealPayload(forMoveId, sealed)),
    expectedRevision: null,
    audience: IDENTITY_PROOF_AUDIENCE,
    challenge: minted.challenge,
    expiresAt: minted.expiresAt,
  });
}

async function seal(ctx: Awaited<ReturnType<typeof startJoinReveal>>) {
  const sealed = sealIdentityForMove(ctx.identity, deriveMoveKey(ctx.web.privateKey, ctx.commons.publicKey, ctx.moveId), ctx.moveId);
  const res = await request('POST', `/${ctx.moveId}/seal`, { ...sealed, proof: await sealProof(ctx.identity, ctx.userId, ctx.moveId, sealed) });
  return { res, sealed };
}

function receiptClaims(ctx: Awaited<ReturnType<typeof startJoinReveal>>, sealed: { nonce: string; ciphertext: string }) {
  return {
    moveId: ctx.moveId,
    rootPublicKey: ctx.identity.publicKey,
    initiatorEphemeralPublicKey: ctx.web.publicKey,
    responderEphemeralPublicKey: ctx.commons.publicKey,
    ciphertextDigest: digestMoveCiphertext(sealed),
  };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/identity/move', identityMoveRouter);
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

describe('a complete move', () => {
  it('delivers the root to the joined device and forgets the ciphertext on a valid receipt', async () => {
    const ctx = await start();
    const before = (await request('GET', `/${ctx.moveId}`, undefined, COMMONS)).body;
    expect(before).toMatchObject({ initiatorCommitment: ctx.commitment, initiatorEphemeralPublicKey: null, status: 'pending' });

    // Nothing to reveal before a device joined.
    expect((await request('POST', `/${ctx.moveId}/reveal`, { initiatorEphemeralPublicKey: ctx.web.publicKey, commitmentNonce: ctx.nonce })).status).toBe(409);

    const commons = generateMoveEphemeralKeyPair();
    expect((await request('POST', `/${ctx.moveId}/join`, { responderEphemeralPublicKey: commons.publicKey }, COMMONS)).status).toBe(200);

    // A key the commitment does not open is refused, as is a wrong nonce.
    expect((await request('POST', `/${ctx.moveId}/reveal`, { initiatorEphemeralPublicKey: generateMoveEphemeralKeyPair().publicKey, commitmentNonce: ctx.nonce })).status).toBe(400);
    expect((await request('POST', `/${ctx.moveId}/reveal`, { initiatorEphemeralPublicKey: ctx.web.publicKey, commitmentNonce: 'ab'.repeat(32) })).status).toBe(400);

    const revealed = await request('POST', `/${ctx.moveId}/reveal`, { initiatorEphemeralPublicKey: ctx.web.publicKey, commitmentNonce: ctx.nonce });
    expect(revealed.status).toBe(200);
    expect(revealed.body).toMatchObject({ initiatorEphemeralPublicKey: ctx.web.publicKey, initiatorCommitmentNonce: ctx.nonce });
    expect(verifyMoveCommitment(ctx.web.publicKey, ctx.nonce, before.initiatorCommitment as string)).toBe(true);
    // Once only.
    expect((await request('POST', `/${ctx.moveId}/reveal`, { initiatorEphemeralPublicKey: ctx.web.publicKey, commitmentNonce: ctx.nonce })).status).toBe(409);
    expect(deriveMoveSas({ moveId: ctx.moveId, initiatorEphemeralPublicKey: ctx.web.publicKey, responderEphemeralPublicKey: commons.publicKey, initiatorCommitment: ctx.commitment })).toMatch(/^\d{6}$/);

    const full = { ...ctx, commons };
    const { res, sealed } = await seal(full);
    expect(res.status).toBe(200);

    const state = (await request('GET', `/${ctx.moveId}`, undefined, COMMONS)).body;
    expect(state.status).toBe('sealed');
    const received = openMovedIdentity(
      { nonce: state.nonce as string, ciphertext: state.ciphertext as string },
      deriveMoveKey(commons.privateKey, state.initiatorEphemeralPublicKey as string, ctx.moveId),
      ctx.moveId,
      state.publicKey as string,
    );
    expect(received.publicKey).toBe(ctx.identity.publicKey);

    const claims = receiptClaims(full, sealed);
    const receipt = await signMoveReceipt((message) => signMessage(message, received.privateKey), claims);
    const completed = await request('POST', `/${ctx.moveId}/receipt`, receipt, COMMONS);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ status: 'completed', ciphertext: null, receiptSignature: receipt.signature });
    expect(await verifyMoveReceipt(claims, completed.body.receiptSignature as string)).toBe(true);

    const [row] = await getDb().select().from(identityMoves).where(eq(identityMoves.moveId, ctx.moveId));
    expect(row.nonce).toBeNull();
    expect(row.ciphertext).toBeNull();
    // A replayed receipt changes nothing.
    expect((await request('POST', `/${ctx.moveId}/receipt`, receipt, COMMONS)).status).toBe(409);
  });
});

describe('starting a move', () => {
  it('is only served to the holder origin or loopback', async () => {
    await accountWithIdentity();
    const { commitment } = createMoveCommitment(generateMoveEphemeralKeyPair().publicKey);
    expect((await request('POST', '/', { initiatorCommitment: commitment }, 'https://accounts.oxy.so')).status).toBe(403);
    expect((await request('POST', '/', { initiatorCommitment: commitment }, null)).status).toBe(403);
    expect((await request('POST', '/', { initiatorCommitment: commitment }, 'http://localhost:8110')).status).toBe(201);
  });

  it('refuses an account without a root, a bare key instead of a commitment, and malformed input', async () => {
    const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
    currentUserId = row.id;
    expect((await request('POST', '/', { initiatorCommitment: 'c'.repeat(64) })).status).toBe(400);
    await accountWithIdentity();
    expect((await request('POST', '/', { initiatorEphemeralPublicKey: generateMoveEphemeralKeyPair().publicKey })).status).toBe(400);
    expect((await request('POST', '/', { initiatorCommitment: 'xyz' })).status).toBe(400);
  });
});

describe('joining', () => {
  it('lets only the first device join', async () => {
    const ctx = await startJoinReveal();
    const intruder = generateMoveEphemeralKeyPair();
    expect((await request('POST', `/${ctx.moveId}/join`, { responderEphemeralPublicKey: intruder.publicKey }, COMMONS)).status).toBe(409);
    const state = (await request('GET', `/${ctx.moveId}`, undefined, COMMONS)).body;
    expect(state.responderEphemeralPublicKey).toBe(ctx.commons.publicKey);
  });

  it('answers 404 for an unknown move and 400 for a malformed id', async () => {
    expect((await request('GET', `/${'0'.repeat(32)}`, undefined, COMMONS)).status).toBe(404);
    expect((await request('GET', '/not-a-move', undefined, COMMONS)).status).toBe(400);
  });
});

describe('sealing', () => {
  it('needs a join and a revealed key first', async () => {
    const ctx = await start();
    const bytes = { nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(64) };
    expect((await request('POST', `/${ctx.moveId}/seal`, { ...bytes, proof: await sealProof(ctx.identity, ctx.userId, ctx.moveId, bytes) })).status).toBe(409);

    const commons = generateMoveEphemeralKeyPair();
    await request('POST', `/${ctx.moveId}/join`, { responderEphemeralPublicKey: commons.publicKey }, COMMONS);
    expect((await request('POST', `/${ctx.moveId}/seal`, { ...bytes, proof: await sealProof(ctx.identity, ctx.userId, ctx.moveId, bytes) })).status).toBe(409);
  });

  it('needs a one-use root proof over this move and these exact bytes', async () => {
    const ctx = await startJoinReveal();
    const sealed = sealIdentityForMove(ctx.identity, deriveMoveKey(ctx.web.privateKey, ctx.commons.publicKey, ctx.moveId), ctx.moveId);

    const otherMove = await sealProof(ctx.identity, ctx.userId, ctx.moveId, sealed, 'f'.repeat(32));
    expect((await request('POST', `/${ctx.moveId}/seal`, { ...sealed, proof: otherMove })).status).toBe(401);

    const otherBytes = await sealProof(ctx.identity, ctx.userId, ctx.moveId, { ...sealed, ciphertext: 'b'.repeat(64) });
    expect((await request('POST', `/${ctx.moveId}/seal`, { ...sealed, proof: otherBytes })).status).toBe(401);

    const timestampSignature = { signature: 'ab', timestamp: Date.now() };
    expect((await request('POST', `/${ctx.moveId}/seal`, { ...sealed, ...timestampSignature })).status).toBe(400);

    const proof = await sealProof(ctx.identity, ctx.userId, ctx.moveId, sealed);
    expect((await request('POST', `/${ctx.moveId}/seal`, { ...sealed, proof })).status).toBe(200);
    // The same proof cannot seal twice.
    await getDb().update(identityMoves).set({ status: 'joined', nonce: null, ciphertext: null }).where(eq(identityMoves.moveId, ctx.moveId));
    expect((await request('POST', `/${ctx.moveId}/seal`, { ...sealed, proof })).status).toBe(401);
  });

  it('is only allowed to the account that started the move', async () => {
    const ctx = await startJoinReveal();
    const sealed = sealIdentityForMove(ctx.identity, deriveMoveKey(ctx.web.privateKey, ctx.commons.publicKey, ctx.moveId), ctx.moveId);
    const proof = await sealProof(ctx.identity, ctx.userId, ctx.moveId, sealed);
    await accountWithIdentity();
    expect((await request('POST', `/${ctx.moveId}/seal`, { ...sealed, proof })).status).toBe(404);
  });
});

describe('receipts', () => {
  it('refuse a receipt not by the moved root, or over other ciphertext', async () => {
    const ctx = await startJoinReveal();
    const { sealed } = await seal(ctx);
    const claims = receiptClaims(ctx, sealed);

    const forged = await signMoveReceipt((message) => signMessage(message, generateWebIdentity().privateKey), claims);
    expect((await request('POST', `/${ctx.moveId}/receipt`, forged, COMMONS)).status).toBe(401);
    const otherBytes = await signMoveReceipt((message) => signMessage(message, ctx.identity.privateKey), { ...claims, ciphertextDigest: 'ab'.repeat(32) });
    expect((await request('POST', `/${ctx.moveId}/receipt`, otherBytes, COMMONS)).status).toBe(401);
    expect((await request('POST', `/${ctx.moveId}/receipt`, { signature: 'ab', timestamp: 1 }, COMMONS)).status).toBe(400);
    expect((await request('GET', `/${ctx.moveId}`, undefined, COMMONS)).body.status).toBe('sealed');
  });

  it('refuse a receipt once the account’s root changed', async () => {
    const ctx = await startJoinReveal();
    const { sealed } = await seal(ctx);
    await getDb().update(users).set({ publicKey: generateWebIdentity().publicKey }).where(eq(users.id, ctx.userId));
    const receipt = await signMoveReceipt((message) => signMessage(message, ctx.identity.privateKey), receiptClaims(ctx, sealed));
    expect((await request('POST', `/${ctx.moveId}/receipt`, receipt, COMMONS)).status).toBe(409);
  });
});

describe('ending without a move', () => {
  it('expires lazily and drops the ciphertext', async () => {
    const ctx = await startJoinReveal();
    const { sealed } = await seal(ctx);
    await getDb().update(identityMoves).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(identityMoves.moveId, ctx.moveId));

    const state = (await request('GET', `/${ctx.moveId}`, undefined, COMMONS)).body;
    expect(state.status).toBe('expired');
    expect(state.ciphertext).toBeNull();
    const receipt = await signMoveReceipt((message) => signMessage(message, ctx.identity.privateKey), receiptClaims(ctx, sealed));
    expect((await request('POST', `/${ctx.moveId}/receipt`, receipt, COMMONS)).status).toBe(409);
  });

  it('can be cancelled by its owner only', async () => {
    const ctx = await startJoinReveal();
    await seal(ctx);
    await accountWithIdentity();
    await request('DELETE', `/${ctx.moveId}`);
    expect((await request('GET', `/${ctx.moveId}`, undefined, COMMONS)).body.status).toBe('sealed');

    currentUserId = ctx.userId;
    expect((await request('DELETE', `/${ctx.moveId}`)).status).toBe(200);
    const state = (await request('GET', `/${ctx.moveId}`, undefined, COMMONS)).body;
    expect(state.status).toBe('cancelled');
    expect(state.ciphertext).toBeNull();
  });

  it('dies with the account', async () => {
    const ctx = await startJoinReveal();
    await getDb().delete(users).where(eq(users.id, ctx.userId));
    expect((await request('GET', `/${ctx.moveId}`, undefined, COMMONS)).status).toBe(404);
  });
});
