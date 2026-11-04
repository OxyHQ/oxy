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
      { method: 'GET', host: '127.0.0.1', port: address.port, path: '/profiles/newest?limit=10' },
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

/**
 * Accounts are dated days AHEAD so they outrank every row the other suites in
 * this database create "now", and the first page is guaranteed to reach them.
 */
async function account(
  daysAhead: number,
  fields: Partial<typeof users.$inferInsert> = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({
      username: `new${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      createdAt: new Date(Date.now() + daysAhead * 86_400_000),
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
  const older = await account(1);
  const newer = await account(2);
  const hidden = [
    await account(3, { privacyIsPrivateAccount: true }),
    await account(3, { accountStatus: 'archived' }),
    await account(3, { kind: 'community' }),
    await account(3, { type: 'federated' }),
  ];

  const ids = (await newest()).map((row) => row.id);

  expect(ids.filter((id) => id === older || id === newer)).toEqual([newer, older]);
  expect(ids.filter((id) => hidden.includes(id))).toEqual([]);
});
