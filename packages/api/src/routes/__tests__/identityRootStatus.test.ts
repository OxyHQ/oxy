/**
 * `GET /identity/root-status` (ADR 0029 D3), against a REAL Postgres: how the
 * account is kept — Commons' root, or the email it signs in with — readable
 * from any first-party origin with a bearer.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

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

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import identityProofRouter from '../identityProof';

let server: http.Server;

async function status(origin = 'https://accounts.oxy.so') {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/identity/root-status`, { headers: { origin } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/identity', identityProofRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await closePostgres();
});

it('reports an account without a key by its email', async () => {
  const email = `${randomUUID()}@example.com`;
  const [row] = await getDb().insert(users).values({ email }).returning({ id: users.id });
  currentUserId = row.id;
  expect(await status()).toEqual({ status: 200, body: { rootLinked: false, recoveryEmail: email } });
});

it('reports an account with neither', async () => {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  currentUserId = row.id;
  expect((await status()).body).toEqual({ rootLinked: false, recoveryEmail: null });
});

it('reports a Commons account as self-custodied, with no recovery email even if a row still has one', async () => {
  const [row] = await getDb()
    .insert(users)
    .values({ publicKey: `04${'b'.repeat(128)}`, email: `${randomUUID()}@example.com` })
    .returning({ id: users.id });
  currentUserId = row.id;
  expect((await status()).body).toEqual({ rootLinked: true, recoveryEmail: null });
});
