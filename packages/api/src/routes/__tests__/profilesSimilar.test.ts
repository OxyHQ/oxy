/**
 * `GET /profiles/:userId/similar` against a REAL Postgres.
 *
 * Co-follower overlap: the people followed by the people who follow `:userId`,
 * ranked by how many of them overlap. Three properties are load-bearing:
 *
 *  - **The target gate.** An archived, `restricted` or PRIVATE target must not
 *    seed a discovery surface at all — 404 before the follower graph is read.
 *  - **The candidate bar.** Co-follower candidates are held to the same
 *    eligibility as the recommendations surface: no shell/QA profiles, no
 *    private accounts, no stale or unavailable federated actors.
 *  - **The exclusion set.** The viewer, the target, and everyone the viewer
 *    already follows are never suggested.
 *
 * The previous version reimplemented the Mongo `$graphLookup` pipeline inside
 * the test and then asserted the pipeline's own stage ORDER — a check that could
 * only ever agree with itself. Here the overlap is computed by Postgres from
 * real `user_follows` rows.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';


/** Set by a test before the request; read by the mocked auth middleware. */
let currentUserId: string | undefined;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    if (currentUserId) req.user = { id: currentUserId };
    next();
  },
}));
jest.mock('../../middleware/optionalAuth', () => ({
  optionalUserOrServiceAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveViewerId: () => currentUserId,
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { FEDERATED_RECOMMENDATION_MAX_AGE_MS } from '../../utils/profileQuery';
import profilesRouter from '../profiles';

interface SimilarResponse {
  status: number;
  body: { message?: string; data?: Array<Record<string, unknown>> };
}

let server: http.Server;

function similar(userId: string, params: Record<string, string> = {}): Promise<SimilarResponse> {
  const address = server.address() as AddressInfo;
  const queryString = new URLSearchParams(params).toString();
  const path = `/profiles/${encodeURIComponent(userId)}/similar${queryString ? `?${queryString}` : ''}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', host: '127.0.0.1', port: address.port, path },
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
    req.end();
  });
}

function handle(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

async function account(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

/** An account that clears the discovery quality bar (username + one curation signal). */
async function curatedAccount(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  return account({ username: handle('curated'), avatar: 'file_avatar', ...fields });
}

async function follow(followerId: string, followedId: string): Promise<void> {
  await getDb().insert(userFollows).values({ followerId, followedId });
}

function ids(res: SimilarResponse): string[] {
  return (res.body.data ?? []).map((row) => row.id as string);
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
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

beforeEach(() => {
  currentUserId = undefined;
});

describe('GET /profiles/:userId/similar — target gate', () => {
  it('401s an unauthenticated request', async () => {
    const target = await curatedAccount();

    const res = await similar(target);

    expect(res.status).toBe(401);
  });

  it('404s an archived target', async () => {
    currentUserId = await curatedAccount();
    const target = await curatedAccount({ accountStatus: 'archived' });
    const follower = await curatedAccount();
    const overlap = await curatedAccount();
    await follow(follower, target);
    await follow(follower, overlap);

    const res = await similar(target);

    expect(res.status).toBe(404);
  });

  it('404s a restricted-tier target', async () => {
    currentUserId = await curatedAccount();
    const target = await curatedAccount({ reputationTier: 'restricted' });

    const res = await similar(target);

    expect(res.status).toBe(404);
  });

  it('404s a private-account target', async () => {
    currentUserId = await curatedAccount();
    const target = await curatedAccount({ privacyIsPrivateAccount: true });

    const res = await similar(target);

    expect(res.status).toBe(404);
  });

  it('404s a target id that names no account', async () => {
    currentUserId = await curatedAccount();

    const res = await similar(randomUUID());

    expect(res.status).toBe(404);
  });
});

describe('GET /profiles/:userId/similar — overlap', () => {
  it('returns co-followed accounts ranked by overlap count, with the count on each row', async () => {
    currentUserId = await curatedAccount();
    const target = await curatedAccount();
    const followerA = await curatedAccount();
    const followerB = await curatedAccount();
    const followerC = await curatedAccount();
    const twiceCoFollowed = await curatedAccount();
    const thriceCoFollowed = await curatedAccount();
    const onceCoFollowed = await curatedAccount();

    for (const follower of [followerA, followerB, followerC]) {
      await follow(follower, target);
      await follow(follower, thriceCoFollowed);
    }
    await follow(followerA, twiceCoFollowed);
    await follow(followerB, twiceCoFollowed);
    await follow(followerC, onceCoFollowed);

    const res = await similar(target, { limit: '10' });

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([thriceCoFollowed, twiceCoFollowed, onceCoFollowed]);
    expect(res.body.data?.map((row) => row.mutualCount)).toEqual([3, 2, 1]);
  });

  it('never suggests the viewer, the target, or an account the viewer already follows', async () => {
    const viewer = await curatedAccount();
    currentUserId = viewer;
    const target = await curatedAccount();
    const alreadyFollowed = await curatedAccount();
    const suggestion = await curatedAccount();
    const follower = await curatedAccount();

    await follow(follower, target);
    // The follower co-follows all four, so only the exclusion set can remove any.
    await follow(follower, viewer);
    await follow(follower, alreadyFollowed);
    await follow(follower, suggestion);
    await follow(viewer, alreadyFollowed);

    const res = await similar(target, { limit: '10' });

    expect(ids(res)).toEqual([suggestion]);
  });

  it('returns an empty list when the target has no followers', async () => {
    currentUserId = await curatedAccount();
    const target = await curatedAccount();

    const res = await similar(target, { limit: '10' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('GET /profiles/:userId/similar — candidate eligibility', () => {
  it('drops shell profiles, private accounts and stale/unavailable federated actors', async () => {
    currentUserId = await curatedAccount();
    const target = await curatedAccount();
    const follower = await curatedAccount();
    await follow(follower, target);

    const now = Date.now();
    const complete = await curatedAccount();
    // Username only — no avatar, name, bio, description or badge.
    const shell = await account({ username: handle('shell') });
    const freshFederated = await curatedAccount({
      type: 'federated',
      federationActorUri: `https://remote.example/users/${handle('fresh')}`,
      federationDomain: 'remote.example',
      federationLastResolvedAt: new Date(now - 24 * 60 * 60 * 1000),
    });
    const staleFederated = await curatedAccount({
      type: 'federated',
      federationActorUri: `https://remote.example/users/${handle('stale')}`,
      federationDomain: 'remote.example',
      federationLastResolvedAt: new Date(now - FEDERATED_RECOMMENDATION_MAX_AGE_MS - 60_000),
    });
    const unavailableFederated = await curatedAccount({
      type: 'federated',
      federationActorUri: `https://remote.example/users/${handle('gone')}`,
      federationDomain: 'remote.example',
      federationLastResolvedAt: new Date(now - 60_000),
      federationUnavailableAt: new Date(now - 60_000),
    });
    const privateAccount = await curatedAccount({ privacyIsPrivateAccount: true });
    const sensitive = await curatedAccount({ isSensitive: true });
    const archived = await curatedAccount({ accountStatus: 'archived' });
    const restricted = await curatedAccount({ reputationTier: 'restricted' });

    for (const candidate of [
      complete,
      shell,
      freshFederated,
      staleFederated,
      unavailableFederated,
      privateAccount,
      sensitive,
      archived,
      restricted,
    ]) {
      await follow(follower, candidate);
    }

    const res = await similar(target, { limit: '50' });

    const returned = ids(res);
    expect(returned).toContain(complete);
    expect(returned).toContain(freshFederated);
    expect(returned).not.toContain(shell);
    expect(returned).not.toContain(staleFederated);
    expect(returned).not.toContain(unavailableFederated);
    expect(returned).not.toContain(privateAccount);
    expect(returned).not.toContain(sensitive);
    expect(returned).not.toContain(archived);
    expect(returned).not.toContain(restricted);
  });
});

describe('GET /profiles/:userId/similar — paging', () => {
  it('pages the overlap deterministically, with no duplicate and no skipped row', async () => {
    currentUserId = await curatedAccount();
    const target = await curatedAccount();
    const follower = await curatedAccount();
    await follow(follower, target);

    const candidates: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const candidate = await curatedAccount();
      candidates.push(candidate);
      await follow(follower, candidate);
    }

    const page1 = await similar(target, { limit: '2', offset: '0' });
    const page2 = await similar(target, { limit: '2', offset: '2' });

    // Every candidate ties at mutualCount 1, so `id asc` is the only thing
    // making the two pages a partition rather than an overlap.
    expect([...ids(page1), ...ids(page2)].sort()).toEqual([...candidates].sort());
    expect(new Set([...ids(page1), ...ids(page2)]).size).toBe(4);
  });

  it('400s an out-of-range limit', async () => {
    currentUserId = await curatedAccount();
    const target = await curatedAccount();

    const res = await similar(target, { limit: '100000' });

    expect(res.status).toBe(400);
  });
});

describe('GET /profiles/:userId/similar — wire shape', () => {
  it('emits the recommendation row DTO for each suggestion', async () => {
    currentUserId = await curatedAccount();
    const target = await curatedAccount();
    const follower = await curatedAccount();
    await follow(follower, target);

    const username = handle('suggested');
    const suggestion = await account({
      username,
      nameFirst: 'Sug',
      nameLast: 'Gestion',
      avatar: 'file_suggestion',
      description: 'a description',
      verified: true,
      reputationTier: 'trusted',
      type: 'federated',
      federationActorUri: `https://remote.example/users/${username}`,
      federationDomain: 'remote.example',
      federationLastResolvedAt: new Date(),
    });
    await follow(follower, suggestion);
    // One follower of its own, so `_count` is a measurement.
    await follow(target, suggestion);

    const res = await similar(target, { limit: '10' });

    expect(res.body.data).toEqual([
      {
        id: suggestion,
        username,
        name: { displayName: 'Sug Gestion', first: 'Sug', last: 'Gestion', full: 'Sug Gestion' },
        avatar: 'file_suggestion',
        description: 'a description',
        verified: true,
        trustTier: 'trusted',
        mutualCount: 1,
        isFederated: true,
        isAgent: false,
        isAutomated: false,
        instance: 'remote.example',
        _count: { followers: 2, following: 0 },
      },
    ]);
  });

  it('omits instance and reports isAgent for a non-federated agent account', async () => {
    currentUserId = await curatedAccount();
    const target = await curatedAccount();
    const follower = await curatedAccount();
    await follow(follower, target);
    const agent = await curatedAccount({ type: 'agent' });
    await follow(follower, agent);

    const res = await similar(target, { limit: '10' });

    const row = res.body.data?.[0];
    expect(row?.id).toBe(agent);
    expect(row?.isAgent).toBe(true);
    expect(row?.isFederated).toBe(false);
    expect(row).not.toHaveProperty('instance');
  });
});
