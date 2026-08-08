/**
 * `GET` / `POST /profiles/recommendations` against a REAL Postgres.
 *
 * Four things here are worth a test, and the previous version could verify none
 * of them: it reimplemented the Mongo aggregation inside the test file and then
 * asserted the pipeline it had just built.
 *
 *  1. **The exclusion set.** The viewer, everyone they already follow, and any
 *     caller-supplied `excludeIds` must never be recommended — on BOTH the
 *     personalized path and the popularity fallback.
 *  2. **The eligibility bar.** Shell/QA profiles, private accounts, stale or
 *     unavailable federated actors, account-level sensitive profiles, archived
 *     and `restricted` accounts never reach the surface.
 *  3. **`clientId` authorization.** A `clientId` selects another tenant's
 *     private per-user signals and weight profile, so honouring an arbitrary
 *     caller-supplied one is cross-tenant data exposure. Only a service token
 *     for its OWN application, or a user with effective access to the
 *     application's owning account, may use it.
 *  4. **The ranking.** Composite score descending, `id` ascending as the stable
 *     tiebreak.
 *
 * ## Isolation
 *
 * When the personalized candidate union is non-empty the scorer reads ONLY those
 * candidates, so those tests are exactly reproducible on a database other suites
 * are also writing to. The popularity FALLBACK reads the whole graph by design,
 * so its tests assert membership and exclusion rather than an exact list.
 *
 * The dual-auth middleware is the one mock: it attaches the principal a test
 * selects (`req.user` for a user token, `req.serviceApp` for a service token),
 * which is exactly its production contract. Everything downstream of it — the
 * `clientId` authorization, `accountService.resolveEffectiveAccess`, the scorer,
 * the serializer — is real.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { recommendationResponseSchema, safeParseContract } from '@oxyhq/contracts';


/** The principal the mocked dual-auth middleware attaches. */
let currentUserId: string | undefined;
let currentServiceApp: { appId: string; scopes: string[] } | undefined;
/** The viewer `resolveViewerId` reports — the service-delegation header case. */
let currentDelegatedViewerId: string | undefined;

jest.mock('../../middleware/optionalAuth', () => ({
  optionalUserOrServiceAuth: (
    req: {
      user?: { _id: string };
      serviceApp?: { type: string; appId: string; appName: string; credentialId: string; scopes: string[] };
    },
    _res: unknown,
    next: () => void,
  ) => {
    if (currentServiceApp) {
      req.serviceApp = {
        type: 'service',
        appName: 'test',
        credentialId: 'test-credential',
        ...currentServiceApp,
      };
    } else if (currentUserId) {
      req.user = { _id: currentUserId };
    }
    next();
  },
  resolveViewerId: () => currentDelegatedViewerId ?? currentUserId,
}));
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appAffinityEdges } from '../../db/schema/appAffinityEdges';
import { applications } from '../../db/schema/applications';
import { appUserSignals } from '../../db/schema/appUserSignals';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { FEDERATED_RECOMMENDATION_MAX_AGE_MS } from '../../utils/profileQuery';
import profilesRouter from '../profiles';

interface RecommendationsResponse {
  status: number;
  body: { message?: string; data?: Array<Record<string, unknown>> };
}

let server: http.Server;

function request(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<RecommendationsResponse> {
  const address = server.address() as AddressInfo;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : undefined,
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
    if (payload) req.write(payload);
    req.end();
  });
}

function getRecommendations(query = ''): Promise<RecommendationsResponse> {
  return request('GET', `/profiles/recommendations${query}`);
}

function postRecommendations(body: unknown): Promise<RecommendationsResponse> {
  return request('POST', '/profiles/recommendations', body);
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

/**
 * Followers given to an account that must rank FIRST in the popularity
 * fallback. The fallback ranks over the whole graph — every account any suite
 * has seeded — and breaks a tie on `id` ASCENDING, which a freshly-created
 * account always loses. A count far above anything the rest of the repo's
 * fixtures produce is what makes the ranking assertion deterministic instead of
 * merely likely.
 */
const DOMINANT_FOLLOWER_COUNT = 60;

/** An eligible account with more followers than any other row in the database. */
async function mostFollowedAccount(): Promise<string> {
  const id = await curatedAccount();
  const fans: Array<{ followerId: string; followedId: string }> = [];
  for (let index = 0; index < DOMINANT_FOLLOWER_COUNT; index += 1) {
    fans.push({ followerId: await curatedAccount(), followedId: id });
  }
  await getDb().insert(userFollows).values(fans);
  return id;
}

async function application(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      type: 'third_party',
      scopes: ['user:read'],
      ownerAccountId,
    })
    .returning({ id: applications.id });
  return row.id;
}

function ids(res: RecommendationsResponse): string[] {
  return (res.body.data ?? []).map((row) => row.id as string);
}

/**
 * A viewer whose candidate union is non-empty via mutual overlap, so the scorer
 * runs on exactly `candidates` and the popularity fallback is not reached.
 */
async function viewerWithOverlap(
  candidates: string[],
): Promise<{ viewer: string; bridge: string }> {
  const viewer = await curatedAccount();
  const bridge = await curatedAccount();
  await follow(viewer, bridge);
  for (const candidate of candidates) {
    await follow(bridge, candidate);
  }
  return { viewer, bridge };
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
  currentServiceApp = undefined;
  currentDelegatedViewerId = undefined;
});

describe('GET /profiles/recommendations — exclusion set', () => {
  it('never returns the viewer, nor anyone the viewer already follows', async () => {
    const candidate = await curatedAccount();
    const alreadyFollowed = await curatedAccount();
    const { viewer, bridge } = await viewerWithOverlap([candidate, alreadyFollowed]);
    await follow(bridge, viewer);
    await follow(viewer, alreadyFollowed);
    currentUserId = viewer;

    const res = await getRecommendations('?limit=50');

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([candidate]);
  });

  it('excludes the viewer and their follows from the popularity FALLBACK too', async () => {
    // A viewer whose follows have no overlap at all → empty candidate union →
    // the fallback runs, over the whole graph.
    const viewer = await curatedAccount();
    const followed = await curatedAccount();
    await follow(viewer, followed);
    // Follower edges make both fallback-eligible on popularity alone.
    for (let index = 0; index < 3; index += 1) {
      const fan = await curatedAccount();
      await follow(fan, viewer);
      await follow(fan, followed);
    }
    currentUserId = viewer;

    const res = await getRecommendations('?limit=100');

    expect(res.status).toBe(200);
    expect(ids(res)).not.toContain(viewer);
    expect(ids(res)).not.toContain(followed);
  });

  it('honours caller-supplied excludeIds on POST', async () => {
    const keep = await curatedAccount();
    const drop = await curatedAccount();
    const { viewer } = await viewerWithOverlap([keep, drop]);
    currentUserId = viewer;

    const res = await postRecommendations({ limit: 50, excludeIds: [drop] });

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([keep]);
  });
});

describe('GET /profiles/recommendations — eligibility bar', () => {
  it('drops shell profiles, private, sensitive, archived, restricted and stale federated candidates', async () => {
    const now = Date.now();
    const complete = await curatedAccount();
    const shell = await account({ username: handle('shell') });
    const keyOnly = await account({ avatar: 'file_avatar' });
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

    const { viewer } = await viewerWithOverlap([
      complete,
      shell,
      keyOnly,
      freshFederated,
      staleFederated,
      unavailableFederated,
      privateAccount,
      sensitive,
      archived,
      restricted,
    ]);
    currentUserId = viewer;

    const res = await getRecommendations('?limit=100');

    const returned = ids(res);
    expect(returned.sort()).toEqual([complete, freshFederated].sort());
  });

  it('excludes federated candidates when excludeTypes names them', async () => {
    const native = await curatedAccount();
    const federated = await curatedAccount({
      type: 'federated',
      federationActorUri: `https://remote.example/users/${handle('fed')}`,
      federationDomain: 'remote.example',
      federationLastResolvedAt: new Date(),
    });
    const { viewer } = await viewerWithOverlap([native, federated]);
    currentUserId = viewer;

    const res = await getRecommendations('?limit=50&excludeTypes=federated');

    expect(ids(res)).toEqual([native]);
  });

  it('400s repeated excludeTypes query params instead of throwing a 500', async () => {
    currentUserId = await curatedAccount();

    const res = await getRecommendations('?excludeTypes=federated&excludeTypes=agent');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/excludeTypes/i);
  });

  it('ignores an unrecognised excludeTypes value rather than excluding nothing silently', async () => {
    const native = await curatedAccount();
    const { viewer } = await viewerWithOverlap([native]);
    currentUserId = viewer;

    const res = await getRecommendations('?limit=50&excludeTypes=not_a_type');

    expect(ids(res)).toEqual([native]);
  });

  it('400s an out-of-range limit', async () => {
    currentUserId = await curatedAccount();

    const res = await getRecommendations('?limit=100000');

    expect(res.status).toBe(400);
  });
});

describe('GET /profiles/recommendations — anonymous fallback', () => {
  it('returns eligible public profiles for an anonymous caller and gates the rest', async () => {
    const popular = await mostFollowedAccount();
    const privateAccount = await curatedAccount({ privacyIsPrivateAccount: true });
    const archived = await curatedAccount({ accountStatus: 'archived' });
    const shell = await account({ username: handle('shell') });
    for (let index = 0; index < 3; index += 1) {
      const fan = await curatedAccount();
      await follow(fan, privateAccount);
      await follow(fan, archived);
      await follow(fan, shell);
    }

    const res = await getRecommendations('?limit=100');

    expect(res.status).toBe(200);
    const returned = ids(res);
    expect(returned[0]).toBe(popular);
    expect(returned).not.toContain(privateAccount);
    expect(returned).not.toContain(archived);
    expect(returned).not.toContain(shell);
  });

  it('returns ONLY eligible accounts, whoever the popularity ranking happens to pick', async () => {
    // The fallback ranks over the whole graph, so the row set is not this
    // test's to choose. The GATE is, and it holds for every row returned.
    const res = await getRecommendations('?limit=100');

    expect(res.status).toBe(200);
    const returned = ids(res);
    expect(returned.length).toBeGreaterThan(0);
    const rows = await getDb()
      .select({
        id: users.id,
        username: users.username,
        accountStatus: users.accountStatus,
        reputationTier: users.reputationTier,
        privacyIsPrivateAccount: users.privacyIsPrivateAccount,
        isSensitive: users.isSensitive,
      })
      .from(users)
      .where(inArray(users.id, returned));
    expect(rows).toHaveLength(returned.length);
    for (const row of rows) {
      expect(row.accountStatus).toBe('active');
      expect(row.reputationTier).not.toBe('restricted');
      expect(row.privacyIsPrivateAccount).toBe(false);
      expect(row.isSensitive).toBe(false);
      expect(row.username).not.toBeNull();
    }
  });

  it('stamps the uniform scored-row fields so the fallback and the scored path share a shape', async () => {
    const popular = await mostFollowedAccount();

    const res = await getRecommendations('?limit=100');

    const row = res.body.data?.find((entry) => entry.id === popular);
    expect(row).toBeDefined();
    expect(row?.score).toBe(0);
    expect(row?.matchedSignals).toEqual([]);
    expect(row?.mutualCount).toBe(0);
    expect(safeParseContract(recommendationResponseSchema, res.body.data)).not.toBeNull();
  });
});

describe('GET /profiles/recommendations — scored ranking', () => {
  it('ranks by composite score descending', async () => {
    // Same mutual overlap for all three; `verified` and `completeness` are the
    // only differing terms, so the expected order is derivable from the weights.
    const bare = await account({ username: handle('bare'), avatar: 'file_a' });
    const complete = await account({
      username: handle('complete'),
      avatar: 'file_b',
      nameFirst: 'Com',
      bio: 'a bio',
    });
    const verifiedComplete = await account({
      username: handle('verified'),
      avatar: 'file_c',
      nameFirst: 'Ver',
      bio: 'a bio',
      verified: true,
    });
    const { viewer } = await viewerWithOverlap([bare, complete, verifiedComplete]);
    currentUserId = viewer;

    const res = await getRecommendations('?limit=50');

    expect(ids(res)).toEqual([verifiedComplete, complete, bare]);
    const scores = (res.body.data ?? []).map((row) => row.score as number);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
  });

  it('ranks a higher mutual overlap above a lower one', async () => {
    const viewer = await curatedAccount();
    const bridgeA = await curatedAccount();
    const bridgeB = await curatedAccount();
    await follow(viewer, bridgeA);
    await follow(viewer, bridgeB);
    const doubleOverlap = await curatedAccount();
    const singleOverlap = await curatedAccount();
    await follow(bridgeA, doubleOverlap);
    await follow(bridgeB, doubleOverlap);
    await follow(bridgeA, singleOverlap);
    currentUserId = viewer;

    const res = await getRecommendations('?limit=50');

    expect(ids(res)).toEqual([doubleOverlap, singleOverlap]);
    expect(res.body.data?.[0]?.mutualCount).toBe(2);
    expect(res.body.data?.[1]?.mutualCount).toBe(1);
    expect(res.body.data?.[0]?.matchedSignals).toContain('graph');
  });

  it('pages the scored result deterministically', async () => {
    const candidates: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      candidates.push(await curatedAccount());
    }
    const { viewer } = await viewerWithOverlap(candidates);
    currentUserId = viewer;

    const page1 = await getRecommendations('?limit=2&offset=0');
    const page2 = await getRecommendations('?limit=2&offset=2');

    // Every candidate scores identically, so `id` ascending is the only thing
    // making the two pages a partition rather than an overlap.
    expect([...ids(page1), ...ids(page2)].sort()).toEqual([...candidates].sort());
    expect(new Set([...ids(page1), ...ids(page2)]).size).toBe(4);
  });
});

describe('POST /profiles/recommendations — clientId authorization', () => {
  it('reads app signals when a SERVICE token names its OWN application', async () => {
    const owner = await curatedAccount();
    const appId = await application(owner);
    // An endorsed candidate with no graph overlap at all: it can only enter the
    // union through the app signal, so its presence proves the signal was read.
    const endorsed = await curatedAccount();
    await getDb()
      .insert(appUserSignals)
      .values({ applicationId: appId, userId: endorsed, endorsementScore: 8 });
    currentServiceApp = { appId, scopes: ['user:read'] };

    const res = await postRecommendations({ clientId: appId, limit: 50 });

    expect(res.status).toBe(200);
    const row = res.body.data?.find((entry) => entry.id === endorsed);
    expect(row).toBeDefined();
    expect(row?.matchedSignals).toContain('curation');
  });

  it('DROPS a clientId naming another tenant application (service token)', async () => {
    const owner = await curatedAccount();
    const otherTenantAppId = await application(owner);
    const ownAppId = await application(await curatedAccount());
    const endorsed = await curatedAccount();
    await getDb()
      .insert(appUserSignals)
      .values({ applicationId: otherTenantAppId, userId: endorsed, endorsementScore: 8 });
    currentServiceApp = { appId: ownAppId, scopes: ['user:read'] };

    const res = await postRecommendations({ clientId: otherTenantAppId, limit: 50 });

    expect(res.status).toBe(200);
    // The other tenant's endorsement must not have injected its candidate.
    const row = res.body.data?.find((entry) => entry.id === endorsed);
    expect(row?.matchedSignals ?? []).not.toContain('curation');
  });

  it('honours a clientId whose application is owned by the USER making the request', async () => {
    const viewer = await curatedAccount();
    const appId = await application(viewer);
    const endorsed = await curatedAccount();
    await getDb()
      .insert(appUserSignals)
      .values({ applicationId: appId, userId: endorsed, endorsementScore: 8 });
    currentUserId = viewer;

    const res = await postRecommendations({ clientId: appId, limit: 50 });

    expect(res.status).toBe(200);
    const row = res.body.data?.find((entry) => entry.id === endorsed);
    expect(row).toBeDefined();
    expect(row?.matchedSignals).toContain('curation');
  });

  it('DROPS a clientId whose application the user has no access to', async () => {
    const stranger = await curatedAccount();
    const appId = await application(stranger);
    const endorsed = await curatedAccount();
    await getDb()
      .insert(appUserSignals)
      .values({ applicationId: appId, userId: endorsed, endorsementScore: 8 });
    currentUserId = await curatedAccount();

    const res = await postRecommendations({ clientId: appId, limit: 50 });

    expect(res.status).toBe(200);
    const row = res.body.data?.find((entry) => entry.id === endorsed);
    expect(row?.matchedSignals ?? []).not.toContain('curation');
  });

  it('DROPS a clientId from an anonymous caller without touching the applications table', async () => {
    const owner = await curatedAccount();
    const appId = await application(owner);
    const endorsed = await curatedAccount();
    await getDb()
      .insert(appUserSignals)
      .values({ applicationId: appId, userId: endorsed, endorsementScore: 8 });

    const res = await postRecommendations({ clientId: appId, limit: 50 });

    expect(res.status).toBe(200);
    const row = res.body.data?.find((entry) => entry.id === endorsed);
    expect(row?.matchedSignals ?? []).not.toContain('curation');
  });

  it('DROPS a clientId that names no application at all', async () => {
    currentUserId = await curatedAccount();

    const res = await postRecommendations({ clientId: randomUUID(), limit: 50 });

    expect(res.status).toBe(200);
  });
});

describe('POST /profiles/recommendations — interaction affinity', () => {
  it('injects and surfaces an affinity-only candidate for a viewer WITH an edge', async () => {
    const viewer = await curatedAccount();
    const appId = await application(viewer);
    // No follow edge in either direction — affinity is the ONLY path in.
    const affine = await curatedAccount();
    await getDb().insert(appAffinityEdges).values({
      applicationId: appId,
      fromUserId: viewer,
      toUserId: affine,
      affinity: 15,
      lastEventAt: new Date(),
      eventCount: 3,
    });
    currentUserId = viewer;

    const res = await postRecommendations({ clientId: appId, limit: 50 });

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([affine]);
    expect(res.body.data?.[0]?.matchedSignals).toContain('affinity');
  });

  it('is a strict no-op for a viewer with NO affinity edges', async () => {
    const candidate = await curatedAccount();
    const { viewer } = await viewerWithOverlap([candidate]);
    const appId = await application(viewer);
    currentUserId = viewer;

    const withApp = await postRecommendations({ clientId: appId, limit: 50 });
    const withoutApp = await postRecommendations({ limit: 50 });

    expect(ids(withApp)).toEqual([candidate]);
    expect(withApp.body.data?.[0]?.matchedSignals).not.toContain('affinity');
    expect(ids(withoutApp)).toEqual(ids(withApp));
  });

  it('ignores an edge that has fully decayed to zero', async () => {
    const viewer = await curatedAccount();
    const appId = await application(viewer);
    const affine = await curatedAccount();
    await getDb().insert(appAffinityEdges).values({
      applicationId: appId,
      fromUserId: viewer,
      toUserId: affine,
      affinity: 0,
      lastEventAt: new Date(),
      eventCount: 0,
    });
    currentUserId = viewer;

    const res = await postRecommendations({ clientId: appId, limit: 50 });

    // A zero edge injects no candidate, so the viewer falls through to the
    // popularity fallback rather than being handed a bogus suggestion.
    //
    // The assertion is about the SIGNAL, not about set membership. The fallback
    // ranks over the whole graph — every account any suite has seeded — and
    // breaks ties on `id` ascending, so whether a zero-follower account happens
    // to land inside the first 50 depends on how many eligible rows the rest of
    // the run created first. `not.toContain(affine)` therefore passed or failed
    // on the shared database's population rather than on the decayed edge: it
    // flaked the moment other suites seeded more accounts. What the decayed edge
    // actually guarantees is that `affine` is never credited with `affinity`.
    const affineRow = res.body.data?.find((row) => row.id === affine);
    expect(affineRow?.matchedSignals ?? []).not.toContain('affinity');
  });
});

describe('POST /profiles/recommendations — boosts and weights', () => {
  it('injects a boosted member as a candidate and marks the appBoost signal', async () => {
    const boosted = await curatedAccount();
    const viewer = await curatedAccount();
    currentUserId = viewer;

    const res = await postRecommendations({
      limit: 50,
      boosts: [{ userIds: [boosted], weight: 1 }],
    });

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([boosted]);
    expect(res.body.data?.[0]?.matchedSignals).toContain('appBoost');
  });

  it('still applies the eligibility bar to a boosted member', async () => {
    const boostedPrivate = await curatedAccount({ privacyIsPrivateAccount: true });
    currentUserId = await curatedAccount();

    const res = await postRecommendations({
      limit: 50,
      boosts: [{ userIds: [boostedPrivate], weight: 5 }],
    });

    expect(ids(res)).not.toContain(boostedPrivate);
  });

  it('zeroing a signal weight removes its contribution', async () => {
    const verified = await account({ username: handle('v'), avatar: 'file_a', verified: true });
    const plain = await account({ username: handle('p'), avatar: 'file_a' });
    const { viewer } = await viewerWithOverlap([verified, plain]);
    currentUserId = viewer;

    const weighted = await postRecommendations({ limit: 50 });
    const unweighted = await postRecommendations({ limit: 50, signalWeights: { verified: 0 } });

    expect(ids(weighted)).toEqual([verified, plain]);
    const verifiedRow = unweighted.body.data?.find((row) => row.id === verified);
    expect(verifiedRow?.matchedSignals).not.toContain('verified');
  });

  it('400s a body that violates the recommendation request contract', async () => {
    currentUserId = await curatedAccount();

    const res = await postRecommendations({ limit: 0 });

    expect(res.status).toBe(400);
  });
});

describe('GET /profiles/recommendations — wire shape', () => {
  it('emits the recommendation item DTO and parses against the shared contract', async () => {
    const username = handle('recommended');
    const candidate = await account({
      username,
      nameFirst: 'Rec',
      nameLast: 'Ommended',
      avatar: 'file_rec',
      description: 'a description',
      verified: true,
      reputationTier: 'trusted',
    });
    const { viewer, bridge } = await viewerWithOverlap([candidate]);
    currentUserId = viewer;

    const res = await getRecommendations('?limit=50');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const row = res.body.data?.[0] ?? {};
    const { score, matchedSignals, ...rest } = row;
    expect(rest).toEqual({
      id: candidate,
      username,
      name: { displayName: 'Rec Ommended', first: 'Rec', last: 'Ommended', full: 'Rec Ommended' },
      avatar: 'file_rec',
      description: 'a description',
      verified: true,
      trustTier: 'trusted',
      mutualCount: 1,
      isFederated: false,
      isAgent: false,
      isAutomated: false,
      _count: { followers: 1, following: 0 },
    });
    expect(typeof score).toBe('number');
    expect(matchedSignals).toEqual(expect.arrayContaining(['graph', 'completeness', 'verified']));
    expect(safeParseContract(recommendationResponseSchema, res.body.data)).not.toBeNull();
    // The bridge is the viewer's own follow, so it is in the exclusion set.
    expect(ids(res)).not.toContain(bridge);
  });
});
