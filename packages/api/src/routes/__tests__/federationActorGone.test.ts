/**
 * `POST /federation/actor-gone` — the service-credential "mark a federated
 * identity gone" bridge, against a REAL Postgres.
 *
 * Mention is the only component that talks to the remote fediverse; when it gets
 * an HTTP 410 Gone for an actor it calls this route to archive the corresponding
 * Oxy user so the dead identity leaves discovery/search surfaces.
 *
 * ## The guarantee this file exists for
 *
 * **A dead federated actor must be archivable whichever side of the cutover its
 * account was created on, and a real account must never be archivable at all.**
 *
 * Two defects worked against the first half, either one alone sufficient:
 *
 *  1. `federationActorGoneSchema` validated `oxyUserId` with `/^[a-f0-9]{24}$/i`
 *     inside `validate({ body })`, so a post-cutover account — whose id is the
 *     uuid v7 `generatedId()` mints — was answered 400 before the handler ran.
 *  2. The guard read `User.findById` (Mongo) while the surrounding system had
 *     moved to Postgres, so the read and the archived state it decides on lived
 *     in different databases.
 *
 * The previous suite could not have caught either: it replaced the model with an
 * in-memory map, seeded it with the literal ids `'a'.repeat(24)` / `'b'.repeat(24)`,
 * and asserted the ARGUMENTS of a mocked `updateOne` — a shape assertion, which
 * stays green no matter what the database ends up holding. Here the archive is
 * read back out of `users`, and the post-cutover ids are minted by the schema
 * itself and asserted not to be 24-hex, so nothing passes vacuously.
 *
 * ## What is still mocked, and why
 *
 * `serviceAuthMiddleware` (the scope it grants is a test PARAMETER) and a SPY on
 * `userCache.invalidate` — the cache is a process-local memo whose invalidation
 * is the assertion, not a store to be checked. The guard, the write, the schema
 * and the error handler are real.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';

/** The scopes the mocked service-auth middleware grants. */
let currentScopes: string[] = ['federation:write'];

jest.mock('../../middleware/auth', () => ({
  serviceAuthMiddleware: (
    req: { serviceApp?: Record<string, unknown> },
    _res: unknown,
    next: () => void,
  ) => {
    req.serviceApp = {
      type: 'service',
      appId: 'app-1',
      appName: 'mention',
      credentialId: 'cred-1',
      scopes: currentScopes,
    };
    next();
  },
}));

jest.mock('../../services/securityActivityService', () => ({ __esModule: true, default: {} }));
jest.mock('../../services/federation.service', () => ({
  __esModule: true,
  getUserPublicKey: jest.fn(),
  signWithKeyId: jest.fn(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { USER_TYPES, users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import userCache from '../../utils/userCache';
import federationRouter from '../federation';

type UserType = (typeof USER_TYPES)[number];

interface JsonResponse {
  status: number;
  body: unknown;
}

let server: http.Server;
let invalidateSpy: jest.SpyInstance;

function post(path: string, payload: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(payload ?? {});
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * A POST-cutover account: the id is omitted so `generatedId()` mints the uuid v7
 * every new row receives. Nothing in the test invents that shape.
 */
async function seedUser(
  type: UserType,
  accountStatus: 'active' | 'archived' = 'active',
): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ type, accountStatus })
    .returning({ id: users.id });
  return row.id;
}

/** A PRE-cutover account, whose 24-char ObjectId hex is preserved verbatim. */
async function seedLegacyUser(
  type: UserType,
  accountStatus: 'active' | 'archived' = 'active',
): Promise<string> {
  const id = randomBytes(12).toString('hex');
  await getDb().insert(users).values({ id, type, accountStatus });
  return id;
}

/** What the database actually holds for an account, or null. */
async function storedStatus(id: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ accountStatus: users.accountStatus })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row?.accountStatus ?? null;
}

/** A well-formed account id that names no row. */
async function unknownUser(): Promise<string> {
  const id = await seedUser('federated');
  await getDb().delete(users).where(eq(users.id, id));
  return id;
}

const HEX24 = /^[0-9a-f]{24}$/i;

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/federation', federationRouter);
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

beforeEach(() => {
  currentScopes = ['federation:write'];
  invalidateSpy = jest.spyOn(userCache, 'invalidate');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the id format must not decide whether a dead actor can be archived', () => {
  it('archives a POST-CUTOVER federated actor, and its id is not 24-hex', async () => {
    const actor = await seedUser('federated');

    // The premise. Without it, reinstating the 24-hex schema would leave this
    // case green and prove nothing.
    expect(actor).not.toMatch(HEX24);

    const res = await post('/federation/actor-gone', { oxyUserId: actor });

    // The 24-hex schema answered 400 here BEFORE the handler ran, so a dead
    // remote identity created since the cutover could never leave discovery.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { oxyUserId: actor, accountStatus: 'archived', alreadyArchived: false },
    });
    expect(await storedStatus(actor)).toBe('archived');
    expect(invalidateSpy).toHaveBeenCalledWith(actor);
  });

  it('still archives a PRE-cutover federated actor, whose id is 24-hex', async () => {
    const actor = await seedLegacyUser('federated');
    expect(actor).toMatch(HEX24);

    const res = await post('/federation/actor-gone', { oxyUserId: actor });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { oxyUserId: actor, accountStatus: 'archived', alreadyArchived: false },
    });
    expect(await storedStatus(actor)).toBe('archived');
  });
});

describe('POST /federation/actor-gone — trust boundary', () => {
  it('rejects a service token without federation:write, and archives nothing', async () => {
    currentScopes = [];
    const actor = await seedUser('federated');

    const res = await post('/federation/actor-gone', { oxyUserId: actor });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'FORBIDDEN',
      message: 'Missing required scope: federation:write',
    });
    expect(await storedStatus(actor)).toBe('active');
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('400s an id that is neither shape, and archives nothing', async () => {
    const res = await post('/federation/actor-gone', { oxyUserId: 'not-an-account-id' });

    // `Validation failed` can only come from `validate({ body })` — no handler
    // emits it — so this is proof the rejection preceded every lookup.
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'BAD_REQUEST',
      message: 'Validation failed',
      details: {
        issues: [{ path: 'oxyUserId', message: 'must be an Oxy account id', code: 'custom' }],
      },
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('404s an account that does not exist', async () => {
    const res = await post('/federation/actor-gone', { oxyUserId: await unknownUser() });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'user not found' });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it.each<UserType>(['local', 'agent', 'automated'])(
    'refuses (409) to archive a %s account and never writes',
    async (type) => {
      const account = await seedUser(type);

      const res = await post('/federation/actor-gone', { oxyUserId: account });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'CONFLICT',
        message: 'user is not a federated actor and cannot be archived',
      });
      // The real account was never touched.
      expect(await storedStatus(account)).toBe('active');
      expect(invalidateSpy).not.toHaveBeenCalled();
    },
  );
});

describe('POST /federation/actor-gone — archival', () => {
  it('archives only the named actor, leaving every other federated actor live', async () => {
    const actor = await seedUser('federated');
    const bystander = await seedUser('federated');

    const res = await post('/federation/actor-gone', { oxyUserId: actor });

    expect(res.status).toBe(200);
    expect(await storedStatus(actor)).toBe('archived');
    expect(await storedStatus(bystander)).toBe('active');
    expect(invalidateSpy.mock.calls.map((call) => call[0])).toEqual([actor]);
  });

  it('is idempotent: an already-archived actor is a 200 no-op with no invalidate', async () => {
    const actor = await seedUser('federated', 'archived');

    const res = await post('/federation/actor-gone', { oxyUserId: actor });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { oxyUserId: actor, accountStatus: 'archived', alreadyArchived: true },
    });
    expect(await storedStatus(actor)).toBe('archived');
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('converges when the same 410 Gone is delivered twice', async () => {
    const actor = await seedUser('federated');

    const first = await post('/federation/actor-gone', { oxyUserId: actor });
    const second = await post('/federation/actor-gone', { oxyUserId: actor });

    expect(first.body).toEqual({
      data: { oxyUserId: actor, accountStatus: 'archived', alreadyArchived: false },
    });
    expect(second.body).toEqual({
      data: { oxyUserId: actor, accountStatus: 'archived', alreadyArchived: true },
    });
    expect(await storedStatus(actor)).toBe('archived');
    // Exactly one write, so exactly one invalidation.
    expect(invalidateSpy.mock.calls.map((call) => call[0])).toEqual([actor]);
  });

  it('never hard-deletes: the archived row survives with its identity intact', async () => {
    // Archival is the whole point — Mention keeps its FederatedActor tombstone
    // and the follow-graph edges survive, so the row must not disappear.
    const actor = await seedUser('federated');

    await post('/federation/actor-gone', { oxyUserId: actor });

    const [row] = await getDb()
      .select({ id: users.id, type: users.type, accountStatus: users.accountStatus })
      .from(users)
      .where(eq(users.id, actor))
      .limit(1);
    expect(row).toEqual({ id: actor, type: 'federated', accountStatus: 'archived' });
  });
});
