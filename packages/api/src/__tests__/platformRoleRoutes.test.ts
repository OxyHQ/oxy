/**
 * The default role is the whole platform, unchanged.
 *
 * The counterpart of `inboshRole.test.ts`: with `OXY_API_ROLE` unset the platform
 * routes the inbosh role drops are all still mounted (they answer something other
 * than the 404 handler), and the email backend still answers beside them. If a
 * route moves behind the role switch by mistake, this is the test that fails.
 */

jest.unmock('socket.io');

process.env.ACCESS_TOKEN_SECRET ??= 'platform-role-access-token-secret-32-chars';
process.env.REFRESH_TOKEN_SECRET ??= 'platform-role-refresh-token-secret-32-chars';
process.env.AWS_REGION ??= 'us-west-2';
process.env.AWS_ACCESS_KEY_ID ??= 'platform-role';
process.env.AWS_SECRET_ACCESS_KEY ??= 'platform-role';
process.env.R2_BUCKET ??= 'platform-role';
delete process.env.OXY_API_ROLE;

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closePostgres, connectPostgres } from '../config/postgres';
import { createTestDatabase, dropTestDatabase } from '../db/testDatabase';

const SLOW_STEP_TIMEOUT_MS = 120_000;

/** The same list `inboshRole.test.ts` asserts is absent from the inbosh role. */
const PLATFORM_PATHS = [
  '/.well-known/jwks.json',
  '/users/me',
  '/applications',
  '/ap/actor',
  '/nodeinfo/2.0',
  '/v1/models',
  '/billing/accounts',
  '/federation/public-key/someone',
  '/wallet',
];

let server: Server;
let baseUrl = '';
let ownDatabaseUrl = '';
let sharedDatabaseUrl: string | undefined;

beforeAll(async () => {
  sharedDatabaseUrl = process.env.DATABASE_URL;
  ownDatabaseUrl = await createTestDatabase();
  await connectPostgres();
  server = (await import('../server')).default;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, SLOW_STEP_TIMEOUT_MS);

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closePostgres();
  await dropTestDatabase(ownDatabaseUrl);
  process.env.DATABASE_URL = sharedDatabaseUrl;
}, SLOW_STEP_TIMEOUT_MS);

describe('the default role', () => {
  it.each(PLATFORM_PATHS)('still serves the platform route %s', async (path) => {
    const response = await fetch(`${baseUrl}${path}`);
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    // Anything but the global 404 handler's answer: 200, 401, 403, 400 are all a mounted route.
    expect(response.status === 404 && body?.error === 'NOT_FOUND').toBe(false);
  });

  it('still serves the email backend beside them', async () => {
    expect((await fetch(`${baseUrl}/email/mailboxes`)).status).toBe(401);
  });
});
