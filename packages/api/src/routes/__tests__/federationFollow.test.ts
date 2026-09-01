/**
 * `POST /federation/follow` — the service-credential follow bridge, against a
 * REAL Postgres on both halves.
 *
 * A FEDERATED (fediverse) actor that follows/unfollows a LOCAL user over
 * ActivityPub is mirrored into the Oxy follow graph by Mention's backend through
 * this route.
 *
 * ## The guarantee this file exists for
 *
 * **A remote Follow of an account created after the Postgres cutover must be
 * mirrored.** Two independent defects stopped that, and either one alone was
 * enough:
 *
 *  1. `federationFollowSchema` validated both ids with `/^[a-f0-9]{24}$/i`. That
 *     runs inside `validate({ body })`, i.e. BEFORE the handler, so a
 *     post-cutover account — whose id is the uuid v7 `generatedId()` mints —
 *     was answered 400 without a single lookup.
 *  2. The route's anti-impersonation guards read `User.findById(...)` (Mongo)
 *     while the write they gate, `userService.followUser`, was already on
 *     Postgres. The guard and the write disagreed about whether an account
 *     exists at all: an account present only in Postgres 404'd at the guard,
 *     and one present only in Mongo passed the guard and then failed the write.
 *
 * The previous suite could not have caught either. It mirrored every seeded row
 * into an in-memory `guardUsers` map so the two halves agreed by construction,
 * and every id in it was 24-hex by construction, so the schema was never asked
 * a question it could get wrong. Here there is ONE store — the database — and
 * `mirrors a Follow of a POST-CUTOVER account` seeds an account whose id is
 * minted by the schema itself and asserts it is not 24-hex before using it, so
 * nothing can pass vacuously.
 *
 * ## What is still mocked, and why
 *
 * `serviceAuthMiddleware` only — minting a real service token would test the
 * token mint, not this bridge, and the scope it grants is a test PARAMETER here.
 * The guards, the graph, the schema and the error handler are all real.
 *
 * The denormalized `_count` assertions are GONE, not translated: those columns
 * were deliberately deleted (`db/schema/users.ts`) — `user_follows` is the
 * single authority and the counts are measured from it.
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

import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userFollows } from '../../db/schema/userFollows';
import { USER_TYPES, users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { userService } from '../../services/user.service';
import federationRouter from '../federation';

type UserType = (typeof USER_TYPES)[number];

interface JsonResponse {
  status: number;
  body: unknown;
}

let server: http.Server;

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
 * A PRE-cutover account: its id is a 24-char ObjectId hex, preserved verbatim in
 * the `text` primary key exactly as the backfill leaves it.
 */
async function seedLegacyUser(
  type: UserType,
  accountStatus: 'active' | 'archived' = 'active',
): Promise<string> {
  const id = randomBytes(12).toString('hex');
  await getDb().insert(users).values({ id, type, accountStatus });
  return id;
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

/** A well-formed account id that names no row, in the post-cutover shape. */
async function unknownUser(): Promise<string> {
  const id = await seedUser('local');
  await getDb().delete(users).where(eq(users.id, id));
  return id;
}

async function edgeCount(followerId: string, followedId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: userFollows.id })
    .from(userFollows)
    .where(and(eq(userFollows.followerId, followerId), eq(userFollows.followedId, followedId)));
  return rows.length;
}

async function edgeExists(followerId: string, followedId: string): Promise<boolean> {
  return (await edgeCount(followerId, followedId)) > 0;
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
});

describe('the id format must not decide whether a Follow is mirrored', () => {
  it('mirrors a Follow of a POST-CUTOVER account, and its ids are not 24-hex', async () => {
    const follower = await seedUser('federated');
    const target = await seedUser('local');

    // The premise. Without it, reinstating the 24-hex schema would leave this
    // case green and prove nothing.
    expect(follower).not.toMatch(HEX24);
    expect(target).not.toMatch(HEX24);

    const res = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: target,
      action: 'follow',
    });

    // The 24-hex schema answered 400 here BEFORE the handler ran, so a remote
    // Follow of any account created since the cutover was silently dropped.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { created: true, counts: { followers: 1, following: 1 } } });
    expect(await edgeCount(follower, target)).toBe(1);
  });

  it('mirrors an Undo-Follow of a POST-CUTOVER account', async () => {
    const follower = await seedUser('federated');
    const target = await seedUser('local');
    await getDb().insert(userFollows).values({ followerId: follower, followedId: target });

    const res = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: target,
      action: 'unfollow',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { removed: true, counts: { followers: 0, following: 0 } } });
    expect(await edgeExists(follower, target)).toBe(false);
  });

  it('still mirrors a Follow between PRE-cutover accounts, whose ids are 24-hex', async () => {
    // The 24-char ObjectId hex is preserved verbatim as a `text` id, so both
    // shapes are live at once and both must work.
    const follower = await seedLegacyUser('federated');
    const target = await seedLegacyUser('local');
    expect(follower).toMatch(HEX24);
    expect(target).toMatch(HEX24);

    const res = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: target,
      action: 'follow',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { created: true, counts: { followers: 1, following: 1 } } });
  });

  it('mirrors a Follow ACROSS the cutover — a new federated actor following a legacy account', async () => {
    const follower = await seedUser('federated');
    const target = await seedLegacyUser('local');

    const res = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: target,
      action: 'follow',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { created: true, counts: { followers: 1, following: 1 } } });
  });
});

describe('POST /federation/follow — trust boundary', () => {
  it('rejects a service token without federation:write, and writes no edge', async () => {
    currentScopes = [];
    const follower = await seedUser('federated');
    const target = await seedUser('local');

    const res = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: target,
      action: 'follow',
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'FORBIDDEN',
      message: 'Missing required scope: federation:write',
    });
    expect(await edgeExists(follower, target)).toBe(false);
  });

  it("rejects a LOCAL follower — a service credential may not move a real user's graph", async () => {
    const follower = await seedUser('local');
    const target = await seedUser('local');

    const res = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: target,
      action: 'follow',
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'FORBIDDEN',
      message: 'follower must be a federated user',
    });
    expect(await edgeExists(follower, target)).toBe(false);
  });

  it.each<UserType>(['agent', 'automated'])(
    'rejects a %s follower — only a federated actor may be moved by a credential',
    async (type) => {
      const follower = await seedUser(type);
      const target = await seedUser('local');

      const res = await post('/federation/follow', {
        followerUserId: follower,
        targetUserId: target,
        action: 'follow',
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: 'FORBIDDEN',
        message: 'follower must be a federated user',
      });
      expect(await edgeExists(follower, target)).toBe(false);
    },
  );

  it('404s an unknown follower', async () => {
    const target = await seedUser('local');

    const res = await post('/federation/follow', {
      followerUserId: await unknownUser(),
      targetUserId: target,
      action: 'follow',
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'follower user not found' });
  });

  it('404s an unknown target', async () => {
    const follower = await seedUser('federated');

    const res = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: await unknownUser(),
      action: 'follow',
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'target user not found' });
  });

  it('rejects a FEDERATED target — the bridge only mirrors remote → local', async () => {
    const follower = await seedUser('federated');
    const target = await seedUser('federated');

    const res = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: target,
      action: 'follow',
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'FORBIDDEN',
      message: 'target must be a local (non-federated) user',
    });
    expect(await edgeExists(follower, target)).toBe(false);
  });

  it('409s an archived follower', async () => {
    const follower = await seedUser('federated', 'archived');
    const target = await seedUser('local');

    const res = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: target,
      action: 'follow',
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'CONFLICT', message: 'follower is archived' });
    expect(await edgeExists(follower, target)).toBe(false);
  });

  it('409s an archived target', async () => {
    const follower = await seedUser('federated');
    const target = await seedUser('local', 'archived');

    const res = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: target,
      action: 'follow',
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'CONFLICT', message: 'target is archived' });
    expect(await edgeExists(follower, target)).toBe(false);
  });
});

describe('POST /federation/follow — body validation is still a real 400 contract', () => {
  it('400s an id that is neither shape, and writes nothing', async () => {
    const target = await seedUser('local');

    const res = await post('/federation/follow', {
      followerUserId: 'not-an-account-id',
      targetUserId: target,
      action: 'follow',
    });

    // `Validation failed` can only come from `validate({ body })` — no handler
    // emits it — so this is proof the rejection preceded every lookup.
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'BAD_REQUEST',
      message: 'Validation failed',
      details: {
        issues: [
          {
            path: 'followerUserId',
            message: 'must be an Oxy account id',
            code: 'custom',
          },
        ],
      },
    });
  });

  it('400s an unknown action', async () => {
    const follower = await seedUser('federated');
    const target = await seedUser('local');

    const res = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: target,
      action: 'block',
    });

    expect(res.status).toBe(400);
    expect(await edgeExists(follower, target)).toBe(false);
  });

  it('trims surrounding whitespace rather than rejecting the id', async () => {
    const follower = await seedUser('federated');
    const target = await seedUser('local');

    const res = await post('/federation/follow', {
      followerUserId: `  ${follower}  `,
      targetUserId: target,
      action: 'follow',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { created: true, counts: { followers: 1, following: 1 } } });
    expect(await edgeCount(follower, target)).toBe(1);
  });
});

describe('POST /federation/follow — idempotency', () => {
  it('creates the edge once, however many times the follow is repeated', async () => {
    const follower = await seedUser('federated');
    const target = await seedUser('local');

    const first = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: target,
      action: 'follow',
    });

    // `counts.followers` is the TARGET's follower total; `counts.following` is
    // the FOLLOWER's following total. Both are measured from `user_follows`.
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ data: { created: true, counts: { followers: 1, following: 1 } } });
    expect(await edgeCount(follower, target)).toBe(1);

    const second = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: target,
      action: 'follow',
    });

    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      data: { created: false, counts: { followers: 1, following: 1 } },
    });
    expect(await edgeCount(follower, target)).toBe(1);
  });

  it('removes the edge once and never drives a count negative', async () => {
    const follower = await seedUser('federated');
    const target = await seedUser('local');
    await getDb().insert(userFollows).values({ followerId: follower, followedId: target });

    const first = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: target,
      action: 'unfollow',
    });

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ data: { removed: true, counts: { followers: 0, following: 0 } } });
    expect(await edgeExists(follower, target)).toBe(false);

    const second = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: target,
      action: 'unfollow',
    });

    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      data: { removed: false, counts: { followers: 0, following: 0 } },
    });
  });

  it("counts the whole of each side's graph, not just this pair", async () => {
    const follower = await seedUser('federated');
    const target = await seedUser('local');
    const bystander = await seedUser('local');
    await getDb().insert(userFollows).values({ followerId: bystander, followedId: target });

    const res = await post('/federation/follow', {
      followerUserId: follower,
      targetUserId: target,
      action: 'follow',
    });

    // The target now has TWO followers; the follower follows ONE account.
    expect(res.body).toEqual({ data: { created: true, counts: { followers: 2, following: 1 } } });
  });
});

describe('UserService follow primitives — self-follow guard', () => {
  it('followUser refuses to follow yourself, and writes nothing', async () => {
    const self = await seedUser('federated');

    await expect(userService.followUser(self, self)).rejects.toThrow('Cannot follow yourself');
    expect(await edgeExists(self, self)).toBe(false);
  });

  it('unfollowUser refuses to unfollow yourself', async () => {
    const self = await seedUser('federated');

    await expect(userService.unfollowUser(self, self)).rejects.toThrow('Cannot follow yourself');
  });
});
