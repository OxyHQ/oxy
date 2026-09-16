/**
 * Identity move relay, against a REAL Postgres.
 *
 * The guarantees are about a move that can only go one way, once:
 *  - only the identity origin (or loopback) may start, seal or cancel a move;
 *  - the first device to join wins, and a move seals only after a join;
 *  - sealing needs a fresh identity-key proof for THIS move;
 *  - the relay hands out the ciphertext only while it is sealed, and forgets it
 *    once a receipt signed by the moved identity arrives;
 *  - a forged or replayed receipt changes nothing, and nothing survives expiry.
 *
 * Both sides run the real `@oxy.so/core` move crypto, so a drift between what the
 * web seals, what Commons opens and what the server verifies fails here.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import {
  deriveMoveKey,
  deriveMoveSas,
  generateMoveEphemeralKeyPair,
  generateWebIdentity,
  IDENTITY_MOVE_ACTIONS,
  openMovedIdentity,
  sealIdentityForMove,
  signMoveAction,
  verifyMoveReceipt,
  type OpenedWebIdentity,
} from '@oxy.so/core';

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
import identityMoveRouter, { buildMoveMessage } from '../identityMove';
import { buildMoveMessage as coreBuildMoveMessage } from '@oxy.so/core';

const IDENTITY_ORIGIN = 'https://id.oxy.so';
const COMMONS = null;

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;

async function request(method: string, path: string, payload?: unknown, origin: string | null = IDENTITY_ORIGIN): Promise<JsonResponse> {
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

async function accountWithIdentity(): Promise<{ userId: string; identity: OpenedWebIdentity }> {
  const identity = generateWebIdentity();
  const [row] = await getDb().insert(users).values({ color: 'teal', publicKey: identity.publicKey }).returning({ id: users.id });
  currentUserId = row.id;
  return { userId: row.id, identity };
}

/** Web starts a move, Commons joins. */
async function startAndJoin() {
  const account = await accountWithIdentity();
  const web = generateMoveEphemeralKeyPair();
  const commons = generateMoveEphemeralKeyPair();
  const created = await request('POST', '/', { initiatorEphemeralPublicKey: web.publicKey });
  expect(created.status).toBe(201);
  const moveId = created.body.moveId as string;
  const joined = await request('POST', `/${moveId}/join`, { responderEphemeralPublicKey: commons.publicKey }, COMMONS);
  expect(joined.status).toBe(200);
  return { ...account, web, commons, moveId };
}

async function seal(ctx: Awaited<ReturnType<typeof startAndJoin>>, timestamp = Date.now()) {
  const sealed = sealIdentityForMove(ctx.identity, deriveMoveKey(ctx.web.privateKey, ctx.commons.publicKey, ctx.moveId), ctx.moveId);
  const proof = await signMoveAction(ctx.identity, IDENTITY_MOVE_ACTIONS.seal, ctx.moveId, timestamp);
  return request('POST', `/${ctx.moveId}/seal`, { ...sealed, ...proof });
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

it('signs exactly the bytes the core client signs', () => {
  expect(buildMoveMessage('identity_move_seal', 'AB'.repeat(16), 42)).toBe(coreBuildMoveMessage('identity_move_seal', 'AB'.repeat(16), 42));
});

describe('a complete move', () => {
  it('delivers the identity to the joined device and forgets the ciphertext on a valid receipt', async () => {
    const ctx = await startAndJoin();

    // Both screens compute the code from what the relay reports.
    const state = (await request('GET', `/${ctx.moveId}`, undefined, COMMONS)).body;
    expect(state.status).toBe('joined');
    expect(deriveMoveSas(ctx.moveId, state.initiatorEphemeralPublicKey as string, state.responderEphemeralPublicKey as string)).toBe(
      deriveMoveSas(ctx.moveId, ctx.web.publicKey, ctx.commons.publicKey),
    );
    expect(state.ciphertext).toBeNull();

    expect((await seal(ctx)).status).toBe(200);

    // Commons polls, opens, and proves possession.
    const sealed = (await request('GET', `/${ctx.moveId}`, undefined, COMMONS)).body;
    expect(sealed.status).toBe('sealed');
    const received = openMovedIdentity(
      { nonce: sealed.nonce as string, ciphertext: sealed.ciphertext as string },
      deriveMoveKey(ctx.commons.privateKey, sealed.initiatorEphemeralPublicKey as string, ctx.moveId),
      ctx.moveId,
      sealed.publicKey as string,
    );
    expect(received.publicKey).toBe(ctx.identity.publicKey);

    const receipt = await signMoveAction(received, IDENTITY_MOVE_ACTIONS.received, ctx.moveId);
    expect((await request('POST', `/${ctx.moveId}/receipt`, receipt, COMMONS)).status).toBe(200);

    const done = (await request('GET', `/${ctx.moveId}`)).body;
    expect(done.status).toBe('completed');
    expect(done.ciphertext).toBeNull();
    expect(
      await verifyMoveReceipt(ctx.identity.publicKey, ctx.moveId, {
        signature: done.receiptSignature as string,
        timestamp: done.receiptTimestamp as number,
      }),
    ).toBe(true);

    const [row] = await getDb().select().from(identityMoves).where(eq(identityMoves.moveId, ctx.moveId));
    expect(row.nonce).toBeNull();
    expect(row.ciphertext).toBeNull();

    // A replayed receipt changes nothing.
    expect((await request('POST', `/${ctx.moveId}/receipt`, receipt, COMMONS)).status).toBe(409);
  });
});

describe('starting a move', () => {
  it('is only served to the identity origin or loopback', async () => {
    await accountWithIdentity();
    const { publicKey } = generateMoveEphemeralKeyPair();
    expect((await request('POST', '/', { initiatorEphemeralPublicKey: publicKey }, 'https://accounts.oxy.so')).status).toBe(403);
    expect((await request('POST', '/', { initiatorEphemeralPublicKey: publicKey }, null)).status).toBe(403);
    expect((await request('POST', '/', { initiatorEphemeralPublicKey: publicKey }, 'http://localhost:8110')).status).toBe(201);
  });

  it('refuses an account without an identity and malformed keys', async () => {
    const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
    currentUserId = row.id;
    expect((await request('POST', '/', { initiatorEphemeralPublicKey: generateMoveEphemeralKeyPair().publicKey })).status).toBe(400);
    await accountWithIdentity();
    expect((await request('POST', '/', { initiatorEphemeralPublicKey: '02abc' })).status).toBe(400);
  });
});

describe('joining', () => {
  it('lets only the first device join', async () => {
    const ctx = await startAndJoin();
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
  it('needs a join first', async () => {
    const account = await accountWithIdentity();
    const web = generateMoveEphemeralKeyPair();
    const moveId = (await request('POST', '/', { initiatorEphemeralPublicKey: web.publicKey })).body.moveId as string;
    const proof = await signMoveAction(account.identity, IDENTITY_MOVE_ACTIONS.seal, moveId);
    expect((await request('POST', `/${moveId}/seal`, { nonce: 'a'.repeat(48), ciphertext: 'b'.repeat(64), ...proof })).status).toBe(409);
  });

  it('needs a fresh proof for this move from the identity itself', async () => {
    const ctx = await startAndJoin();
    const sealed = sealIdentityForMove(ctx.identity, deriveMoveKey(ctx.web.privateKey, ctx.commons.publicKey, ctx.moveId), ctx.moveId);

    const otherMove = await signMoveAction(ctx.identity, IDENTITY_MOVE_ACTIONS.seal, 'f'.repeat(32));
    expect((await request('POST', `/${ctx.moveId}/seal`, { ...sealed, ...otherMove })).status).toBe(401);

    const wrongAction = await signMoveAction(ctx.identity, IDENTITY_MOVE_ACTIONS.received, ctx.moveId);
    expect((await request('POST', `/${ctx.moveId}/seal`, { ...sealed, ...wrongAction })).status).toBe(401);

    const otherKey = await signMoveAction(generateWebIdentity(), IDENTITY_MOVE_ACTIONS.seal, ctx.moveId);
    expect((await request('POST', `/${ctx.moveId}/seal`, { ...sealed, ...otherKey })).status).toBe(401);

    expect((await seal(ctx, Date.now() - 60 * 60 * 1000)).status).toBe(400);
    expect((await request('GET', `/${ctx.moveId}`, undefined, COMMONS)).body.status).toBe('joined');
  });

  it('is only allowed to the account that started the move', async () => {
    const ctx = await startAndJoin();
    await accountWithIdentity();
    const sealed = sealIdentityForMove(ctx.identity, deriveMoveKey(ctx.web.privateKey, ctx.commons.publicKey, ctx.moveId), ctx.moveId);
    const proof = await signMoveAction(ctx.identity, IDENTITY_MOVE_ACTIONS.seal, ctx.moveId);
    expect((await request('POST', `/${ctx.moveId}/seal`, { ...sealed, ...proof })).status).toBe(404);
  });
});

describe('receipts', () => {
  it('refuses a receipt not signed by the moved identity', async () => {
    const ctx = await startAndJoin();
    await seal(ctx);
    const forged = await signMoveAction(generateWebIdentity(), IDENTITY_MOVE_ACTIONS.received, ctx.moveId);
    expect((await request('POST', `/${ctx.moveId}/receipt`, forged, COMMONS)).status).toBe(401);
    expect((await request('GET', `/${ctx.moveId}`, undefined, COMMONS)).body.status).toBe('sealed');
  });

  it('refuses a receipt once the account’s identity changed', async () => {
    const ctx = await startAndJoin();
    await seal(ctx);
    await getDb().update(users).set({ publicKey: generateWebIdentity().publicKey }).where(eq(users.id, ctx.userId));
    const receipt = await signMoveAction(ctx.identity, IDENTITY_MOVE_ACTIONS.received, ctx.moveId);
    expect((await request('POST', `/${ctx.moveId}/receipt`, receipt, COMMONS)).status).toBe(409);
  });
});

describe('ending without a move', () => {
  it('expires lazily and drops the ciphertext', async () => {
    const ctx = await startAndJoin();
    await seal(ctx);
    await getDb().update(identityMoves).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(identityMoves.moveId, ctx.moveId));

    const state = (await request('GET', `/${ctx.moveId}`, undefined, COMMONS)).body;
    expect(state.status).toBe('expired');
    expect(state.ciphertext).toBeNull();
    const receipt = await signMoveAction(ctx.identity, IDENTITY_MOVE_ACTIONS.received, ctx.moveId);
    expect((await request('POST', `/${ctx.moveId}/receipt`, receipt, COMMONS)).status).toBe(409);
  });

  it('can be cancelled by its owner only', async () => {
    const ctx = await startAndJoin();
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
    const ctx = await startAndJoin();
    await getDb().delete(users).where(eq(users.id, ctx.userId));
    expect((await request('GET', `/${ctx.moveId}`, undefined, COMMONS)).status).toBe(404);
  });
});
