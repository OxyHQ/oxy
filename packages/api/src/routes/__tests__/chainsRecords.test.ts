/**
 * `POST /chains/records` — the authorization gates, over a real HTTP server.
 *
 * The service layer's own suite proves the namespace boundary against a real
 * database. What can only be proven HERE is that the route refuses a credential
 * that lacks `chains:write` BEFORE any of that runs — a scope check living in a
 * router is exactly the kind of gate that ships untested and then turns out to
 * have been unreachable.
 *
 * `serviceAuthMiddleware` is mocked because the credential it presents — the
 * appId and its scopes — IS the parameter under test, the same shape
 * `federation.test.ts` uses. The service is NOT mocked: a route test that stubs
 * the thing making the decision proves only that the route calls something.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

/** The credential `serviceAuthMiddleware` presents — set per test. */
let currentServiceApp: Record<string, unknown> | undefined;

jest.mock('../../middleware/auth', () => ({
  serviceAuthMiddleware: (req: { serviceApp?: Record<string, unknown> }, _res: unknown, next: () => void) => {
    req.serviceApp = currentServiceApp;
    next();
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { randomUUID } from 'node:crypto';
import { ec as EC } from 'elliptic';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { appGrants } from '../../db/schema/appGrants';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import chainsRoutes from '../chains';

const ec = new EC('secp256k1');

let server: http.Server;
let savedEnv: { priv?: string; pub?: string };

beforeAll(async () => {
  await connectPostgres();
  savedEnv = { priv: process.env.OXY_PRIVATE_KEY, pub: process.env.OXY_PUBLIC_KEY };
  const pair = ec.genKeyPair();
  process.env.OXY_PRIVATE_KEY = pair.getPrivate('hex');
  process.env.OXY_PUBLIC_KEY = pair.getPublic('hex');

  const app = express();
  app.use(express.json());
  app.use('/chains', chainsRoutes);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  process.env.OXY_PRIVATE_KEY = savedEnv.priv;
  process.env.OXY_PUBLIC_KEY = savedEnv.pub;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closePostgres();
});

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

async function application(chainNamespaces: string[]): Promise<string> {
  const ownerAccountId = await account();
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `test-${randomUUID()}`, ownerAccountId, chainNamespaces })
    .returning({ id: applications.id });
  return row.id;
}

async function authorize(appId: string, userId: string): Promise<void> {
  await getDb()
    .insert(appGrants)
    .values({ applicationId: appId, userId, scopes: ['chains:write'] });
}

function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const address = server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path: '/chains/records',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Present a credential for `appId` carrying `scopes`. */
function present(appId: string | undefined, scopes: string[]): void {
  currentServiceApp = appId === undefined ? undefined : { type: 'service', appId, scopes };
}

describe('POST /chains/records', () => {
  it('refuses a credential without chains:write', async () => {
    const appId = await application(['app.mention.']);
    // A credential that is otherwise perfectly entitled — the right app, the
    // right namespace — and still must not write without the scope.
    present(appId, ['federation:write']);

    const res = await post({
      oxyUserId: await account(),
      collection: 'app.mention.feed.post',
      rkey: 'r1',
      record: { text: 'hi' },
    });

    expect(res.status).toBe(403);
  });

  it('refuses a credential that names no application', async () => {
    present(undefined, []);
    const res = await post({
      oxyUserId: await account(),
      collection: 'app.mention.feed.post',
      rkey: 'r1',
      record: {},
    });
    expect(res.status).toBe(403);
  });

  it('appends when the scope and the namespace both allow it', async () => {
    const appId = await application(['app.mention.']);
    const userId = await account();
    await authorize(appId, userId);
    present(appId, ['chains:write']);

    const res = await post({
      oxyUserId: userId,
      collection: 'app.mention.feed.post',
      rkey: 'r1',
      record: { text: 'hi' },
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ seq: 0, verified: true });
    expect(typeof res.body.recordId).toBe('string');
  });

  it('refuses an authorized service credential when the subject did not consent', async () => {
    const appId = await application(['app.mention.']);
    present(appId, ['chains:write']);

    const res = await post({
      oxyUserId: await account(),
      collection: 'app.mention.feed.post',
      rkey: 'r1',
      record: {},
    });

    expect(res.status).toBe(403);
  });

  it('refuses a collection outside the application’s namespace, with the scope present', async () => {
    // The pair that shows the two gates are independent: same credential, same
    // scope, different collection.
    const appId = await application(['app.mention.']);
    present(appId, ['chains:write']);

    const res = await post({
      oxyUserId: await account(),
      collection: 'app.syra.listen',
      rkey: 'r1',
      record: {},
    });

    expect(res.status).toBe(403);
  });

  it('rejects a malformed collection before any of that', async () => {
    const appId = await application(['app.mention.']);
    present(appId, ['chains:write']);

    const res = await post({
      oxyUserId: await account(),
      collection: 'not an nsid',
      rkey: 'r1',
      record: {},
    });

    expect(res.status).toBe(400);
  });
});
