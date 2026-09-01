/**
 * `POST /federation/actor-delete` — the service-credential "hard-delete a dead
 * federated identity + its follow graph" bridge, against a REAL Postgres.
 *
 * Mention is the only component that talks to the remote fediverse; when an
 * actor is permanently removed upstream (HTTP 410 Gone for a deleted/spam
 * account) it calls this route to ERASE the corresponding Oxy identity and every
 * social-graph edge it left behind — the irreversible counterpart to
 * `actor-gone` (which only archives).
 *
 * ## The guarantee this file exists for
 *
 * **A dead federated actor must be erasable whichever side of the cutover its
 * account was created on, and a real account must never be erasable at all.**
 *
 * `federationActorDeleteSchema` validated `oxyUserId` with `/^[a-f0-9]{24}$/i`
 * inside `validate({ body })`, so a post-cutover account — whose id is the uuid
 * v7 `generatedId()` mints — was answered 400 before the handler ran; the ghost
 * identity and its follow edges stayed. Separately, the route's guard read
 * `User.findById` (Mongo) while the purge it gates,
 * `userService.deleteFederatedActor`, was already on Postgres — so the read that
 * decides whether the account is federated and the delete that acts on it lived
 * in different databases, and an account present in only one of them made the
 * two disagree.
 *
 * The previous suite mirrored every seeded row into an in-memory `guardUsers`
 * map, which made the two halves agree by construction and made every id 24-hex
 * by construction. It also had to hand-delete from that map to model the second
 * call in the idempotency case — the tell that the route's read was not looking
 * where the purge wrote. Here there is ONE store, so the repeat call converges
 * because the row is genuinely gone.
 *
 * The denormalized counterparty `_count` repair is GONE, not translated: those
 * columns were deliberately deleted, so there is no counter to repair. What
 * replaces it is stronger — the edges themselves are asserted absent, and the
 * counterparties' remaining edges are asserted INTACT.
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

import { and, eq, or } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { blocks } from '../../db/schema/blocks';
import { restrictions } from '../../db/schema/restrictions';
import { userFollows } from '../../db/schema/userFollows';
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
async function seedUser(type: UserType): Promise<string> {
  const [row] = await getDb().insert(users).values({ type }).returning({ id: users.id });
  return row.id;
}

/** A PRE-cutover account, whose 24-char ObjectId hex is preserved verbatim. */
async function seedLegacyUser(type: UserType): Promise<string> {
  const id = randomBytes(12).toString('hex');
  await getDb().insert(users).values({ id, type });
  return id;
}

/** A well-formed account id that names no row. */
async function unknownUser(): Promise<string> {
  const id = await seedUser('federated');
  await getDb().delete(users).where(eq(users.id, id));
  return id;
}

async function follow(followerId: string, followedId: string): Promise<void> {
  await getDb().insert(userFollows).values({ followerId, followedId });
}

async function userExists(id: string): Promise<boolean> {
  const [row] = await getDb().select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
  return row !== undefined;
}

async function edgesTouching(id: string): Promise<number> {
  const rows = await getDb()
    .select({ id: userFollows.id })
    .from(userFollows)
    .where(or(eq(userFollows.followerId, id), eq(userFollows.followedId, id)));
  return rows.length;
}

async function blocksTouching(id: string): Promise<number> {
  const rows = await getDb()
    .select({ id: blocks.id })
    .from(blocks)
    .where(or(eq(blocks.userId, id), eq(blocks.blockedId, id)));
  return rows.length;
}

async function restrictionsTouching(id: string): Promise<number> {
  const rows = await getDb()
    .select({ id: restrictions.id })
    .from(restrictions)
    .where(or(eq(restrictions.userId, id), eq(restrictions.restrictedId, id)));
  return rows.length;
}

async function edgeExists(followerId: string, followedId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: userFollows.id })
    .from(userFollows)
    .where(and(eq(userFollows.followerId, followerId), eq(userFollows.followedId, followedId)))
    .limit(1);
  return row !== undefined;
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

describe('the id format must not decide whether a dead actor can be erased', () => {
  it('erases a POST-CUTOVER federated actor and its edges, and its id is not 24-hex', async () => {
    const actor = await seedUser('federated');
    const followed = await seedUser('local');
    await follow(actor, followed);

    // The premise. Without it, reinstating the 24-hex schema would leave this
    // case green and prove nothing.
    expect(actor).not.toMatch(HEX24);

    const res = await post('/federation/actor-delete', { oxyUserId: actor });

    // The 24-hex schema answered 400 here BEFORE the handler ran, so a ghost
    // identity created since the cutover could never be erased.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { oxyUserId: actor, deleted: true, followEdgesRemoved: 1 },
    });
    expect(await userExists(actor)).toBe(false);
    expect(await edgesTouching(actor)).toBe(0);
  });

  it('still erases a PRE-cutover federated actor, whose id is 24-hex', async () => {
    const actor = await seedLegacyUser('federated');
    expect(actor).toMatch(HEX24);

    const res = await post('/federation/actor-delete', { oxyUserId: actor });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { oxyUserId: actor, deleted: true, followEdgesRemoved: 0 },
    });
    expect(await userExists(actor)).toBe(false);
  });
});

describe('POST /federation/actor-delete — trust boundary', () => {
  it('rejects a service token without federation:write, and deletes nothing', async () => {
    currentScopes = [];
    const actor = await seedUser('federated');

    const res = await post('/federation/actor-delete', { oxyUserId: actor });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'FORBIDDEN',
      message: 'Missing required scope: federation:write',
    });
    expect(await userExists(actor)).toBe(true);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('400s an id that is neither shape, and deletes nothing', async () => {
    const res = await post('/federation/actor-delete', { oxyUserId: 'not-an-account-id' });

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

  it.each<UserType>(['local', 'agent', 'automated'])(
    '409s a %s account and leaves its whole graph intact',
    async (type) => {
      const account = await seedUser(type);
      const follower = await seedUser('local');
      await follow(follower, account);
      await getDb().insert(blocks).values({ userId: account, blockedId: follower });

      const res = await post('/federation/actor-delete', { oxyUserId: account });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'CONFLICT',
        message: 'user is not a federated actor and cannot be deleted',
      });
      expect(await userExists(account)).toBe(true);
      expect(await edgesTouching(account)).toBe(1);
      expect(await blocksTouching(account)).toBe(1);
      expect(invalidateSpy).not.toHaveBeenCalled();
    },
  );
});

describe('POST /federation/actor-delete — purge', () => {
  it('is a 200 no-op for an unknown account, with no destructive write', async () => {
    const unknownId = await unknownUser();

    const res = await post('/federation/actor-delete', { oxyUserId: unknownId });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { oxyUserId: unknownId, deleted: false, followEdgesRemoved: 0 },
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('hard-deletes the actor, every edge in both directions, and its blocks and restrictions', async () => {
    const actor = await seedUser('federated');
    const followed1 = await seedUser('local');
    const followed2 = await seedUser('local');
    const follower = await seedUser('local');
    const bystander = await seedUser('local');

    // Two outbound edges, one inbound — and one edge between two OTHER accounts
    // that must survive, so the delete is proven scoped rather than a truncate.
    await follow(actor, followed1);
    await follow(actor, followed2);
    await follow(follower, actor);
    await follow(bystander, followed1);
    await getDb()
      .insert(blocks)
      .values([
        { userId: actor, blockedId: followed1 },
        { userId: follower, blockedId: actor },
      ]);
    await getDb().insert(restrictions).values({ userId: actor, restrictedId: followed2 });

    const res = await post('/federation/actor-delete', { oxyUserId: actor });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { oxyUserId: actor, deleted: true, followEdgesRemoved: 3 },
    });

    expect(await userExists(actor)).toBe(false);
    expect(await edgesTouching(actor)).toBe(0);
    // MEASURED, NOT CLAIMED: `blocks`/`restrictions` reference `users.id` with
    // `ON DELETE CASCADE`, so on THIS route the end state below is guaranteed by
    // the constraint whether or not `purgeUserSocialGraph` deletes them itself —
    // deleting that delete leaves these two green. They are asserted because the
    // end state is what a client observes; they are NOT coverage of the
    // service's own delete, which belongs with `purgeUserSocialGraph`'s suite on
    // a path that does not remove the user row.
    expect(await blocksTouching(actor)).toBe(0);
    expect(await restrictionsTouching(actor)).toBe(0);
    // The unrelated edge is untouched — and each counterparty still exists.
    expect(await edgeExists(bystander, followed1)).toBe(true);
    expect(await userExists(followed1)).toBe(true);
    expect(await userExists(followed2)).toBe(true);
    expect(await userExists(follower)).toBe(true);

    // The actor's cache entry and every counterparty's are invalidated, so a
    // stale follower list cannot outlive the purge.
    const invalidated = new Set(invalidateSpy.mock.calls.map((call) => call[0] as string));
    expect(invalidated).toEqual(new Set([actor, followed1, followed2, follower]));
  });

  it('is idempotent: a repeated delete after the actor is gone is a 200 no-op', async () => {
    const actor = await seedUser('federated');

    const first = await post('/federation/actor-delete', { oxyUserId: actor });

    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      data: { oxyUserId: actor, deleted: true, followEdgesRemoved: 0 },
    });
    expect(await userExists(actor)).toBe(false);

    // No store to fix up by hand: the guard now reads the same database the
    // purge wrote to, so the second call sees the row genuinely gone.
    const second = await post('/federation/actor-delete', { oxyUserId: actor });

    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      data: { oxyUserId: actor, deleted: false, followEdgesRemoved: 0 },
    });
  });
});
