/**
 * `OXY_API_ROLE=inbosh` — the same image serving only the email backend.
 *
 * The real `server.ts` is imported with the role set, against a real throwaway
 * database, and driven over HTTP. Three things are pinned:
 *
 * 1. **What is mounted.** `/health` and the email backend answer; every other
 *    platform route falls through to the 404 handler. The default role's side of
 *    the same table is `platformRoleRoutes.test.ts`.
 * 2. **Auth is the platform's.** A bearer minted by the session service (same
 *    `ACCESS_TOKEN_SECRET`, same session row) is accepted on `/email`, with the
 *    `X-Session-Id` header the SDK's linked client sends; a token signed with any
 *    other secret is refused.
 * 3. **CORS is the platform's.** A preflight from `https://inbo.sh` with the
 *    linked client's headers is admitted with credentials.
 *
 * `PORT`, the role and the secrets are read once at import, so they are set
 * before it.
 */

jest.unmock('socket.io');
// The run-wide setup stubs `jsonwebtoken`; this suite needs real tokens end to end.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

process.env.ACCESS_TOKEN_SECRET ??= 'inbosh-role-access-token-secret-32-chars';
process.env.REFRESH_TOKEN_SECRET ??= 'inbosh-role-refresh-token-secret-32-chars';
process.env.DEVICE_ID_SALT ??= 'x'.repeat(48);
process.env.AWS_REGION ??= 'us-west-2';
process.env.AWS_ACCESS_KEY_ID ??= 'inbosh-role';
process.env.AWS_SECRET_ACCESS_KEY ??= 'inbosh-role';
process.env.R2_BUCKET ??= 'inbosh-role';
process.env.OXY_API_ROLE = 'inbosh';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { closePostgres, connectPostgres } from '../config/postgres';
import {
  resetOriginRegistryForTests,
  setOriginSnapshotForTests,
} from '../config/dynamicOriginRegistry';
import { insertAccountFixture } from '../db/__fixtures__/accountIdentity';
import { createTestDatabase, dropTestDatabase } from '../db/testDatabase';
import sessionService from '../services/session.service';

const SLOW_STEP_TIMEOUT_MS = 120_000;

/** Platform routes that answer something other than 404 in the default role. */
const PLATFORM_ONLY_PATHS = [
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
  resetOriginRegistryForTests();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closePostgres();
  await dropTestDatabase(ownDatabaseUrl);
  process.env.DATABASE_URL = sharedDatabaseUrl;
}, SLOW_STEP_TIMEOUT_MS);

describe('what the inbosh role mounts', () => {
  it('answers /health', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
  });

  it.each(PLATFORM_ONLY_PATHS)('does not serve the platform route %s', async (path) => {
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('mounts the authenticated email backend behind the platform auth', async () => {
    const response = await fetch(`${baseUrl}/email/mailboxes`);
    expect(response.status).toBe(401);
  });

  it.each([
    ['GET', '/email/proxy'],
    ['POST', '/email/inbound'],
    ['POST', '/email/feedback/ses'],
  ])(
    'mounts the unauthenticated email edge %s %s (answers something other than 404)',
    async (method, path) => {
      const response = await fetch(`${baseUrl}${path}`, { method });
      expect(response.status).not.toBe(404);
    },
  );
});

describe('auth on the email backend is the platform’s', () => {
  it('accepts a bearer from the shared session service, with and without the SDK’s session header', async () => {
    const user = await insertAccountFixture({ username: `u-${randomUUID().slice(0, 12)}` });
    const session = await sessionService.createSession(
      user.id,
      { headers: { 'user-agent': 'inbosh-role-test' } } as Request,
      { deviceId: `dev-${randomUUID()}` },
    );
    const call = async (extra: Record<string, string>) => {
      const response = await fetch(`${baseUrl}/email/mailboxes`, {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          accept: 'application/json',
          ...extra,
        },
      });
      return { status: response.status, body: (await response.text()).slice(0, 300) };
    };
    // Both shapes in one assertion, so a failure prints the status AND the body.
    const results = {
      bearerOnly: await call({}),
      withSessionHeader: await call({ 'x-session-id': session.sessionId }),
    };
    expect(results).toEqual({
      bearerOnly: { status: 200, body: expect.any(String) },
      withSessionHeader: { status: 200, body: expect.any(String) },
    });
  });

  it('refuses a token signed with a different secret', async () => {
    const forged = jwt.sign({ userId: 'someone', sessionId: 'whatever' }, 'not-the-shared-secret');
    const response = await fetch(`${baseUrl}/email/mailboxes`, {
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(response.status).toBe(401);
  });
});

describe('CORS on the inbosh role', () => {
  it('admits a preflight from https://inbo.sh with the linked client’s headers', async () => {
    setOriginSnapshotForTests(['https://inbo.sh'], []);
    const headers = ['accept', 'authorization', 'content-type', 'x-session-id', 'idempotency-key'];
    const response = await fetch(`${baseUrl}/email/mailboxes`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://inbo.sh',
        'access-control-request-method': 'GET',
        'access-control-request-headers': headers.join(','),
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://inbo.sh');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    const allowed = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    for (const header of headers) expect(allowed).toContain(header);
  });
});
