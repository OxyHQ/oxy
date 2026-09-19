/**
 * `GET /identity/root-status` (ADR 0024 D5), against a REAL Postgres: readiness
 * metadata for reminders, readable from any first-party origin with a bearer —
 * and nothing in it that opens anything.
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

import { generateWebIdentity, markWrapVerified, sealWebIdentity } from '@oxy.so/core';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { identityWebEnvelopes } from '../../db/schema/identityWebEnvelopes';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { envelopeColumns } from '../../utils/identityEnvelopeColumns';
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

it('reports an account with no root', async () => {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  currentUserId = row.id;
  expect(await status()).toEqual({
    status: 200,
    body: { rootLinked: false, webHolder: null, hasPhrase: null, phraseConfirmedAt: null, recoveryVerifiedAt: null },
  });
});

it('reports a root kept elsewhere, and a web holder by its passkey counts — never its ciphertext', async () => {
  const identity = generateWebIdentity();
  const [row] = await getDb().insert(users).values({ publicKey: identity.publicKey }).returning({ id: users.id });
  currentUserId = row.id;
  expect((await status()).body).toMatchObject({ rootLinked: true, webHolder: null });

  const { envelope, dataKey } = sealWebIdentity(identity, { prfOutput: new Uint8Array(32).fill(1), credentialId: 'credential-aaaaaaaaaaaaaaaa', rpId: 'oxy.so' });
  dataKey.fill(0);
  const verified = markWrapVerified(envelope, 'credential-aaaaaaaaaaaaaaaa');
  await getDb().insert(identityWebEnvelopes).values({ userId: row.id, ...envelopeColumns(verified, identity.publicKey), phraseConfirmedAt: new Date() });

  const res = await status();
  expect(res.body).toMatchObject({ rootLinked: true, webHolder: { passkeys: 1, verifiedPasskeys: 1 }, hasPhrase: true, phraseConfirmedAt: expect.any(String), recoveryVerifiedAt: null });
  const serialized = JSON.stringify(res.body);
  expect(serialized).not.toContain(verified.wraps[0].wrappedKey);
  expect(serialized).not.toContain(verified.sealedSecret);
});

it('ignores a web holder sealing a root the account no longer has', async () => {
  const identity = generateWebIdentity();
  const [row] = await getDb().insert(users).values({ publicKey: generateWebIdentity().publicKey }).returning({ id: users.id });
  currentUserId = row.id;
  const { envelope, dataKey } = sealWebIdentity(identity, { prfOutput: new Uint8Array(32).fill(1), credentialId: 'credential-aaaaaaaaaaaaaaaa', rpId: 'oxy.so' });
  dataKey.fill(0);
  await getDb().insert(identityWebEnvelopes).values({ userId: row.id, ...envelopeColumns(envelope, identity.publicKey) });
  expect((await status()).body).toMatchObject({ rootLinked: true, webHolder: null, hasPhrase: null });
});
