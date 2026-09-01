/**
 * DID document endpoints (B2), against a REAL Postgres.
 *
 * ## The guarantee this file exists for
 *
 * **An account created AFTER the Postgres cutover must be resolvable by a DID
 * resolver.**
 *
 * The handler this replaces ran `:userId` through the legacy 24-hex id predicate
 * in `utils/validation.ts` (`/^[0-9a-f]{24}$/i`) and answered
 * `404 {error:'NOT_FOUND', message:'DID not found'}` on a miss. Every row created
 * since the cutover carries a **uuid v7** (`@oxyhq/db`'s `generatedId()`),
 * which that regex rejects — so a real, fully-provisioned account's DID document
 * 404'd BEFORE ANY QUERY RAN, and the answer was byte-identical to "no such
 * account". `did:web` is a PUBLIC contract consumed by third-party resolvers and
 * remote fediverse instances, so this was not a degraded read: the account did
 * not exist as far as the federated world was concerned.
 *
 * The suite this replaces could not have caught it. It stubbed `User.findById`
 * AND stubbed the id predicate itself with the same 24-hex regex, then used a
 * hard-coded 24-hex `USER_ID` — so the guard was satisfied by construction and
 * the id format was never in question. Here the ids are the ones the schema
 * actually mints, the account and its child rows are real, and the first case
 * asserts the id is NOT 24-hex so nothing below can pass vacuously.
 *
 * ## What is mocked, and why
 *
 * `nodeRegistry.service` only. It is still Mongoose-backed (a sibling port), and
 * what matters here is the DID document's `#oxy-node` service entry, which is a
 * pure function of the ACTIVE/inactive node the route hands `buildDidDocument`.
 * Everything else — the account row, `user_auth_methods`, `user_verified_domains`,
 * and the real `did.service` derivation — is the database.
 *
 * Response bodies are asserted WHOLE, not by status code: the document's exact
 * JSON shape is what remote resolvers parse.
 */

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { ec as EC } from 'elliptic';
import { eq } from 'drizzle-orm';

const mockGetUserNode = jest.fn();

jest.mock('../../services/nodeRegistry.service', () => ({
  getUserNode: (...args: unknown[]) => mockGetUserNode(...args),
  materializeNodeFromRecord: jest.fn(),
  removeNode: jest.fn(),
  probeLiveness: jest.fn(),
  sweepNodeLiveness: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import { userVerifiedDomains } from '../../db/schema/userVerifiedDomains';
import didRoutes from '../did';

const ec = new EC('secp256k1');

/** The two ids the `text` primary key can hold; only one of them is minted now. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

const DID_CONTEXT = [
  'https://www.w3.org/ns/did/v1',
  'https://w3id.org/security/suites/secp256k1-2019/v1',
];

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

async function get(target: http.Server, path: string): Promise<RawResponse> {
  const address = target.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: address.port, path }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: raw.length > 0 ? JSON.parse(raw) : {},
        });
      });
    }).on('error', reject);
  });
}

/** A fresh account. `username` is unique per row (case-insensitively unique). */
async function account(username?: string): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: username ?? `u${randomUUID().replace(/-/g, '')}` })
    .returning({ id: users.id });
  return row.id;
}

/** Link an identity key: the account column plus its `user_auth_methods` row. */
async function linkIdentity(userId: string, publicKey: string): Promise<void> {
  await getDb().update(users).set({ publicKey }).where(eq(users.id, userId));
  await getDb().insert(userAuthMethods).values({
    userId,
    type: 'identity',
    methodPublicKey: publicKey,
  });
}

let server: http.Server;

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use('/', didRoutes);
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

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserNode.mockResolvedValue(null);
});

describe('the id format must not decide whether a DID resolves', () => {
  it('mints an account id the deleted 24-hex guard would have rejected', async () => {
    // The premise every case below rests on. Without it, reinstating the guard
    // would leave this suite green and prove nothing.
    const userId = await account();
    expect(userId).not.toMatch(OBJECT_ID_HEX);
  });

  it('serves the DID document of a post-cutover account', async () => {
    const userId = await account('nate');
    const publicKey = ec.genKeyPair().getPublic('hex');
    await linkIdentity(userId, publicKey);

    const res = await get(server, `/u/${userId}/did.json`);
    const did = `did:web:oxy.so:u:${userId}`;

    // The guard answered 404 here without querying, so the account was
    // unresolvable by every DID resolver and remote instance.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      '@context': DID_CONTEXT,
      id: did,
      controller: [did, 'did:web:oxy.so'],
      verificationMethod: [
        {
          id: `${did}#key-1`,
          type: 'EcdsaSecp256k1VerificationKey2019',
          controller: did,
          publicKeyHex: publicKey,
        },
      ],
      authentication: [`${did}#key-1`],
      assertionMethod: [`${did}#key-1`],
      alsoKnownAs: ['acct:nate@oxy.so', 'https://oxy.so/@nate'],
      service: [
        { id: `${did}#oxy-api`, type: 'OxyApiService', serviceEndpoint: 'https://api.oxy.so' },
        { id: `${did}#profile`, type: 'OxyProfileService', serviceEndpoint: 'https://oxy.so/@nate' },
      ],
    });
  });
});

describe('GET /u/:userId/did.json', () => {
  it('serves a self-sovereign document with JSON + CORS + cache headers', async () => {
    const userId = await account();
    await linkIdentity(userId, ec.genKeyPair().getPublic('hex'));

    const res = await get(server, `/u/${userId}/did.json`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it('serves a CUSTODIAL document controlled solely by Oxy when no key is linked', async () => {
    // The reversibility contract: no identity verification method → the account
    // is custodial, `controller` is `[OXY_DID]` alone, and the only verification
    // method is Oxy's own custodial key.
    const oxyPublicKey = ec.genKeyPair().getPublic('hex');
    const original = process.env.OXY_PUBLIC_KEY;
    process.env.OXY_PUBLIC_KEY = oxyPublicKey;
    try {
      const userId = await account();

      const res = await get(server, `/u/${userId}/did.json`);
      const did = `did:web:oxy.so:u:${userId}`;

      expect(res.status).toBe(200);
      expect(res.body.controller).toEqual(['did:web:oxy.so']);
      expect(res.body.verificationMethod).toEqual([
        {
          id: 'did:web:oxy.so#oxy-custodial-key',
          type: 'EcdsaSecp256k1VerificationKey2019',
          controller: 'did:web:oxy.so',
          publicKeyHex: oxyPublicKey,
        },
      ]);
      expect(res.body.authentication).toEqual(['did:web:oxy.so#oxy-custodial-key']);
      expect(res.body.id).toBe(did);
    } finally {
      if (original === undefined) delete process.env.OXY_PUBLIC_KEY;
      else process.env.OXY_PUBLIC_KEY = original;
    }
  });

  it('flips the controller back to custodial when the identity key is unlinked', async () => {
    // Link/unlink is fully reversible, and the document is DERIVED from the
    // stored rows — so removing the auth method + the account column reverts the
    // document with no separate state to keep in sync.
    const userId = await account();
    const publicKey = ec.genKeyPair().getPublic('hex');
    await linkIdentity(userId, publicKey);
    const did = `did:web:oxy.so:u:${userId}`;

    const linked = await get(server, `/u/${userId}/did.json`);
    expect(linked.body.controller).toEqual([did, 'did:web:oxy.so']);

    await getDb().delete(userAuthMethods).where(eq(userAuthMethods.userId, userId));
    await getDb().update(users).set({ publicKey: null }).where(eq(users.id, userId));

    const unlinked = await get(server, `/u/${userId}/did.json`);
    expect(unlinked.body.controller).toEqual(['did:web:oxy.so']);
    expect(unlinked.body.verificationMethod).toEqual([]);
    expect(unlinked.body.authentication).toEqual([]);
    expect(unlinked.body.assertionMethod).toEqual([]);
  });

  it('lists every identity key as a positional verification method, in a STABLE order', async () => {
    // `#key-N` fragments are positional, so an unordered child-table read would
    // let one account serve two different documents. The primary key is always
    // `#key-1`; linked identity keys follow in `linked_at` order.
    const userId = await account();
    const primary = ec.genKeyPair().getPublic('hex');
    const second = ec.genKeyPair().getPublic('hex');
    await linkIdentity(userId, primary);
    await getDb().insert(userAuthMethods).values({
      userId,
      type: 'identity',
      methodPublicKey: second,
      linkedAt: new Date(Date.now() + 1000),
    });
    const did = `did:web:oxy.so:u:${userId}`;

    const first = await get(server, `/u/${userId}/did.json`);
    const again = await get(server, `/u/${userId}/did.json`);

    expect(first.body.verificationMethod).toEqual([
      { id: `${did}#key-1`, type: 'EcdsaSecp256k1VerificationKey2019', controller: did, publicKeyHex: primary },
      { id: `${did}#key-2`, type: 'EcdsaSecp256k1VerificationKey2019', controller: did, publicKeyHex: second },
    ]);
    expect(again.body).toEqual(first.body);
  });

  it('publishes each verified domain as an alsoKnownAs entry, in insertion order', async () => {
    const userId = await account('domainowner');
    await linkIdentity(userId, ec.genKeyPair().getPublic('hex'));
    await getDb().insert(userVerifiedDomains).values([
      { userId, domain: 'first.example', verifiedAt: new Date('2026-01-01T00:00:00.000Z'), method: 'dns-txt', createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { userId, domain: 'second.example', verifiedAt: new Date('2026-02-01T00:00:00.000Z'), method: 'well-known', createdAt: new Date('2026-02-01T00:00:00.000Z') },
    ]);

    const res = await get(server, `/u/${userId}/did.json`);

    expect(res.body.alsoKnownAs).toEqual([
      'acct:domainowner@oxy.so',
      'https://oxy.so/@domainowner',
      'https://first.example',
      'https://second.example',
    ]);
  });

  it('announces an ACTIVE personal data node as a service entry', async () => {
    const userId = await account();
    await linkIdentity(userId, ec.genKeyPair().getPublic('hex'));
    mockGetUserNode.mockResolvedValue({ status: 'active', endpoint: 'https://node.nate.com' });

    const res = await get(server, `/u/${userId}/did.json`);
    const services = res.body.service as Array<{ id: string; type: string; serviceEndpoint: string }>;

    expect(mockGetUserNode).toHaveBeenCalledWith(userId);
    expect(services).toContainEqual({
      id: `did:web:oxy.so:u:${userId}#oxy-node`,
      type: 'OxyPersonalDataNode',
      serviceEndpoint: 'https://node.nate.com',
    });
  });

  it('omits the node service entry when the registered node is not active', async () => {
    const userId = await account();
    mockGetUserNode.mockResolvedValue({ status: 'unreachable', endpoint: 'https://node.nate.com' });

    const res = await get(server, `/u/${userId}/did.json`);
    const services = res.body.service as Array<{ type: string }>;

    expect(services.some((entry) => entry.type === 'OxyPersonalDataNode')).toBe(false);
  });

  it('returns 404 when the account does not exist', async () => {
    const res = await get(server, `/u/${randomUUID()}/did.json`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'DID not found' });
  });

  it('returns the SAME 404 for a malformed id, by querying rather than guessing', async () => {
    // No shape precheck any more: `users.id` is a `text` column compared against
    // a bound parameter, so a malformed id is a value that matches no row — the
    // exact body the deleted guard produced, reached without also rejecting
    // every post-cutover account.
    const res = await get(server, '/u/not-an-id/did.json');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'DID not found' });
  });
});

describe('GET /.well-known/did.json', () => {
  it('serves the Oxy organisation DID document with CORS', async () => {
    const res = await get(server, '/.well-known/did.json');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.body.id).toBe('did:web:oxy.so');
    expect(res.body.controller).toEqual(['did:web:oxy.so']);
    expect(res.body.alsoKnownAs).toEqual(['https://oxy.so']);
    expect(res.body.service).toEqual([
      { id: 'did:web:oxy.so#oxy-api', type: 'OxyApiService', serviceEndpoint: 'https://api.oxy.so' },
    ]);
  });
});

describe('DID_WEB_DOMAIN override — anchored at api.oxy.so', () => {
  // The DID-web domain is captured at module-load time, so the routes (and the
  // did.service they depend on) are re-required under a fresh registry with the
  // override set. That registry gets its OWN `config/postgres` module instance,
  // whose pool starts closed — so it must be connected here and closed below, or
  // the route's first query throws and the pool leaks past the run.
  const ORIGINAL_DID_WEB_DOMAIN = process.env.DID_WEB_DOMAIN;
  let overrideServer: http.Server;
  let closeOverridePostgres: () => Promise<void>;

  beforeAll(async () => {
    process.env.DID_WEB_DOMAIN = 'api.oxy.so';
    let freshRoutes: typeof import('../did').default | undefined;
    await jest.isolateModulesAsync(async () => {
      const postgresModule = await import('../../config/postgres');
      await postgresModule.connectPostgres();
      closeOverridePostgres = postgresModule.closePostgres;
      freshRoutes = (await import('../did')).default;
    });
    if (!freshRoutes) {
      throw new Error('did routes failed to load under isolateModules');
    }
    const app = express();
    app.use('/', freshRoutes);
    await new Promise<void>((resolve) => {
      overrideServer = app.listen(0, '127.0.0.1', resolve);
    });
  });

  afterAll(async () => {
    if (ORIGINAL_DID_WEB_DOMAIN === undefined) delete process.env.DID_WEB_DOMAIN;
    else process.env.DID_WEB_DOMAIN = ORIGINAL_DID_WEB_DOMAIN;
    await new Promise<void>((resolve, reject) => {
      overrideServer.close((error) => (error ? reject(error) : resolve()));
    });
    await closeOverridePostgres();
  });

  it('serves a user DID anchored at did:web:api.oxy.so with federation URLs on oxy.so', async () => {
    const userId = await account('anchored');
    const publicKey = ec.genKeyPair().getPublic('hex');
    await linkIdentity(userId, publicKey);
    const did = `did:web:api.oxy.so:u:${userId}`;

    const res = await get(overrideServer, `/u/${userId}/did.json`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      '@context': DID_CONTEXT,
      id: did,
      controller: [did, 'did:web:api.oxy.so'],
      verificationMethod: [
        { id: `${did}#key-1`, type: 'EcdsaSecp256k1VerificationKey2019', controller: did, publicKeyHex: publicKey },
      ],
      authentication: [`${did}#key-1`],
      assertionMethod: [`${did}#key-1`],
      // Handles and profile URLs STAY on the federation apex.
      alsoKnownAs: ['acct:anchored@oxy.so', 'https://oxy.so/@anchored'],
      service: [
        { id: `${did}#oxy-api`, type: 'OxyApiService', serviceEndpoint: 'https://api.oxy.so' },
        { id: `${did}#profile`, type: 'OxyProfileService', serviceEndpoint: 'https://oxy.so/@anchored' },
      ],
    });
  });

  it('serves the Oxy organisation DID document anchored at did:web:api.oxy.so', async () => {
    const res = await get(overrideServer, '/.well-known/did.json');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('did:web:api.oxy.so');
    expect(res.body.controller).toEqual(['did:web:api.oxy.so']);
  });
});
