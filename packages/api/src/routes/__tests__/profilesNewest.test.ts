/**
 * `GET /profiles/newest` against a REAL Postgres: public, discoverable, local
 * personal accounts in sign-up order, newest first.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

jest.mock('../../middleware/optionalAuth', () => ({
  optionalUserOrServiceAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveViewerId: () => undefined,
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import profilesRouter from '../profiles';

let server: http.Server;

function newest(): Promise<Array<Record<string, unknown>>> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', host: '127.0.0.1', port: address.port, path: '/profiles/newest?limit=100' },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve(JSON.parse(raw).data));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function account(
  minutesAgo: number,
  fields: Partial<typeof users.$inferInsert> = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({
      username: `new${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
      ...fields,
    })
    .returning({ id: users.id });
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use('/profiles', profilesRouter);
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

it('lists public local people newest first, without the accounts it must not show', async () => {
  const older = await account(3);
  const newer = await account(1);
  const hidden = [
    await account(0, { privacyIsPrivateAccount: true }),
    await account(0, { accountStatus: 'archived' }),
    await account(0, { kind: 'community' }),
    await account(0, { type: 'federated' }),
  ];

  const ids = (await newest()).map((row) => row.id);

  expect(ids.filter((id) => id === older || id === newer)).toEqual([newer, older]);
  expect(ids.filter((id) => hidden.includes(id))).toEqual([]);
});
