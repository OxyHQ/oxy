/**
 * Web identity carrier routes, against a REAL Postgres.
 *
 * The guarantees are about who can read or change the sealed web copy of an
 * identity, and about the bytes that end up stored:
 *  - only the identity origin (or loopback) is served, even with a valid bearer;
 *  - every write needs a fresh identity-key proof bound to ITS action — a bearer
 *    alone, a stale proof, or a proof for another action is refused;
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
  buildIdentityActionMessage,
  generateWebIdentity,
  sealWebIdentity,
  signIdentityAction,
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
import { identityWebEnvelopes } from '../../db/schema/identityWebEnvelopes';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import identityWebEnvelopeRouter, { WEB_ENVELOPE_ACTIONS } from '../identityWebEnvelope';

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

function sealFor(identity: OpenedWebIdentity, credentialId = 'credential-aaaaaaaaaaaaaaaa', fill = 5) {
  const { envelope, dataKey } = sealWebIdentity(identity, { prfOutput: prf(fill), credentialId });
  dataKey.fill(0);
  return envelope;
}

async function proof(identity: OpenedWebIdentity, action: string, userId: string, timestamp = Date.now()) {
  return signIdentityAction(identity, action, userId, timestamp);
}

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

describe('storing the envelope', () => {
  it('reads as absent before anything is stored', async () => {
    const { userId } = await accountWithIdentity();
    currentUserId = userId;

    const res = await request('GET', '/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ envelope: null, phraseConfirmedAt: null, updatedAt: null });
  });

  it('stores exactly the sealed envelope and hands it back byte for byte', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const envelope = sealFor(identity);

    const put = await request('PUT', '/', { envelope, ...(await proof(identity, WEB_ENVELOPE_ACTIONS.put, userId)) });
    expect(put.status).toBe(200);
    expect(put.body.envelope).toEqual(envelope);
    expect(put.body.phraseConfirmedAt).toBeNull();

    const get = await request('GET', '/');
    expect(get.body.envelope).toEqual(envelope);

    // The row holds ciphertext only — no mnemonic, no private key.
    const [row] = await getDb().select().from(identityWebEnvelopes).where(eq(identityWebEnvelopes.userId, userId));
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(identity.privateKey);
    for (const word of new Set(identity.mnemonic.split(' '))) {
      expect(serialized).not.toMatch(new RegExp(`\\b${word}\\b`));
    }
  });

  it('refuses a write carried by a bearer alone', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const res = await request('PUT', '/', { envelope: sealFor(identity) });
    expect(res.status).toBe(400);
  });

  it('refuses a proof signed by a different key', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const res = await request('PUT', '/', {
      envelope: sealFor(identity),
      ...(await proof(generateWebIdentity(), WEB_ENVELOPE_ACTIONS.put, userId)),
    });
    expect(res.status).toBe(401);
  });

  it('refuses a stale proof', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const res = await request('PUT', '/', {
      envelope: sealFor(identity),
      ...(await proof(identity, WEB_ENVELOPE_ACTIONS.put, userId, Date.now() - 60 * 60 * 1000)),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a proof made for another action or another account', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const envelope = sealFor(identity);

    const otherAction = await request('PUT', '/', { envelope, ...(await proof(identity, WEB_ENVELOPE_ACTIONS.delete, userId)) });
    expect(otherAction.status).toBe(401);

    const otherAccount = await request('PUT', '/', { envelope, ...(await proof(identity, WEB_ENVELOPE_ACTIONS.put, 'someone-else')) });
    expect(otherAccount.status).toBe(401);
  });

  it('refuses an envelope that seals any identity but the account’s own', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const res = await request('PUT', '/', {
      envelope: sealFor(generateWebIdentity()),
      ...(await proof(identity, WEB_ENVELOPE_ACTIONS.put, userId)),
    });
    expect(res.status).toBe(400);
  });

  it('refuses an account with no linked identity', async () => {
    const identity = generateWebIdentity();
    const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
    currentUserId = row.id;
    const res = await request('PUT', '/', {
      envelope: sealFor(identity),
      ...(await proof(identity, WEB_ENVELOPE_ACTIONS.put, row.id)),
    });
    expect(res.status).toBe(400);
  });

  it('replaces rather than accumulates, and a re-wrap keeps the saved-phrase state', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    await request('PUT', '/', { envelope: sealFor(identity), ...(await proof(identity, WEB_ENVELOPE_ACTIONS.put, userId)) });
    const confirmed = await request('POST', '/phrase-confirmed', await proof(identity, WEB_ENVELOPE_ACTIONS.phraseConfirmed, userId));
    expect(confirmed.status).toBe(200);
    expect(typeof confirmed.body.phraseConfirmedAt).toBe('string');

    const rewrapped = sealFor(identity, 'credential-bbbbbbbbbbbbbbbb', 9);
    const put = await request('PUT', '/', { envelope: rewrapped, ...(await proof(identity, WEB_ENVELOPE_ACTIONS.put, userId)) });
    expect(put.body.envelope).toEqual(rewrapped);
    expect(put.body.phraseConfirmedAt).toBe(confirmed.body.phraseConfirmedAt);

    const rows = await getDb().select({ id: identityWebEnvelopes.id }).from(identityWebEnvelopes).where(eq(identityWebEnvelopes.userId, userId));
    expect(rows).toHaveLength(1);
  });
});

describe('establishing an account’s first identity', () => {
  async function accountWithoutIdentity(): Promise<string> {
    const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
    return row.id;
  }

  async function establishBody(identity: OpenedWebIdentity, userId: string) {
    return {
      envelope: sealFor(identity),
      link: await proof(identity, WEB_ENVELOPE_ACTIONS.link, userId),
      ...(await proof(identity, WEB_ENVELOPE_ACTIONS.put, userId)),
    };
  }

  async function linkedKey(userId: string): Promise<string | null> {
    const [row] = await getDb().select({ publicKey: users.publicKey }).from(users).where(eq(users.id, userId));
    return row?.publicKey ?? null;
  }

  it('links the key, records the auth method and stores the envelope together', async () => {
    const userId = await accountWithoutIdentity();
    currentUserId = userId;
    const identity = generateWebIdentity();
    const body = await establishBody(identity, userId);

    const res = await request('POST', '/establish', body);
    expect(res.status).toBe(200);
    expect(res.body.envelope).toEqual(body.envelope);
    expect(await linkedKey(userId)).toBe(identity.publicKey);
    const methods = await getDb()
      .select({ type: userAuthMethods.type, methodPublicKey: userAuthMethods.methodPublicKey })
      .from(userAuthMethods)
      .where(eq(userAuthMethods.userId, userId));
    expect(methods).toEqual([{ type: 'identity', methodPublicKey: identity.publicKey }]);
  });

  it('links nothing when any part is refused — never a key without its envelope', async () => {
    const userId = await accountWithoutIdentity();
    currentUserId = userId;
    const identity = generateWebIdentity();
    const body = await establishBody(identity, userId);

    const badPut = await request('POST', '/establish', { ...body, signature: (await proof(generateWebIdentity(), WEB_ENVELOPE_ACTIONS.put, userId)).signature });
    expect(badPut.status).toBe(401);
    const badLink = await request('POST', '/establish', { ...body, link: await proof(identity, WEB_ENVELOPE_ACTIONS.put, userId) });
    expect(badLink.status).toBe(401);

    expect(await linkedKey(userId)).toBeNull();
    expect((await request('GET', '/')).body.envelope).toBeNull();
  });

  it('is safe to retry with the same identity', async () => {
    const userId = await accountWithoutIdentity();
    currentUserId = userId;
    const identity = generateWebIdentity();

    expect((await request('POST', '/establish', await establishBody(identity, userId))).status).toBe(200);
    expect((await request('POST', '/establish', await establishBody(identity, userId))).status).toBe(200);
    const methods = await getDb().select({ id: userAuthMethods.id }).from(userAuthMethods).where(eq(userAuthMethods.userId, userId));
    expect(methods).toHaveLength(1);
  });

  it('never replaces an identity the account already has', async () => {
    const { userId, identity: existing } = await accountWithIdentity();
    currentUserId = userId;
    const res = await request('POST', '/establish', await establishBody(generateWebIdentity(), userId));
    expect(res.status).toBe(409);
    expect(await linkedKey(userId)).toBe(existing.publicKey);
  });

  it('refuses a key already linked to another account', async () => {
    const { identity: taken } = await accountWithIdentity();
    const userId = await accountWithoutIdentity();
    currentUserId = userId;
    const res = await request('POST', '/establish', await establishBody(taken, userId));
    expect(res.status).toBe(409);
    expect(await linkedKey(userId)).toBeNull();
  });
});

describe('an identity that moved on', () => {
  it('reads as absent once the account’s identity key is no longer the one sealed', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    await request('PUT', '/', { envelope: sealFor(identity), ...(await proof(identity, WEB_ENVELOPE_ACTIONS.put, userId)) });

    await getDb().update(users).set({ publicKey: generateWebIdentity().publicKey }).where(eq(users.id, userId));

    const res = await request('GET', '/');
    expect(res.body.envelope).toBeNull();
  });
});

describe('confirming the phrase', () => {
  it('needs an envelope to confirm', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    const res = await request('POST', '/phrase-confirmed', await proof(identity, WEB_ENVELOPE_ACTIONS.phraseConfirmed, userId));
    expect(res.status).toBe(400);
  });
});

describe('destroying the web copy', () => {
  it('deletes only with a proof for the delete action, and is idempotent', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    await request('PUT', '/', { envelope: sealFor(identity), ...(await proof(identity, WEB_ENVELOPE_ACTIONS.put, userId)) });

    expect((await request('DELETE', '/', await proof(identity, WEB_ENVELOPE_ACTIONS.put, userId))).status).toBe(401);
    expect((await request('GET', '/')).body.envelope).not.toBeNull();

    expect((await request('DELETE', '/', await proof(identity, WEB_ENVELOPE_ACTIONS.delete, userId))).status).toBe(200);
    expect((await request('GET', '/')).body.envelope).toBeNull();
    expect((await request('DELETE', '/', await proof(identity, WEB_ENVELOPE_ACTIONS.delete, userId))).status).toBe(200);
  });

  it('dies with the account', async () => {
    const { userId, identity } = await accountWithIdentity();
    currentUserId = userId;
    await request('PUT', '/', { envelope: sealFor(identity), ...(await proof(identity, WEB_ENVELOPE_ACTIONS.put, userId)) });

    await getDb().delete(users).where(eq(users.id, userId));

    const rows = await getDb().select({ id: identityWebEnvelopes.id }).from(identityWebEnvelopes).where(eq(identityWebEnvelopes.userId, userId));
    expect(rows).toHaveLength(0);
  });
});

it('signs the same bytes the server reconstructs', () => {
  expect(buildIdentityActionMessage('web_envelope_put', 'u', 1)).toBe('{"action":"web_envelope_put","userId":"u","timestamp":1}');
});
