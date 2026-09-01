/**
 * POST /federation/domain-purge — remove what the Oxy PLATFORM holds for a
 * fediverse instance the calling app has blocked, against a REAL Postgres.
 *
 * The two assertions this suite exists for, because both guard something
 * irreversible:
 *
 *   1. A DRY RUN WRITES NOTHING. Not a file delete, not a row delete, not an
 *      archive, not a graph edge — while still returning a non-empty plan, so
 *      "wrote nothing" can never be satisfied by "did nothing".
 *   2. A NON-BLOCKED DOMAIN'S DATA IS NEVER TOUCHED. Subdomains, unrelated
 *      domains and our own apex all survive a purge aimed next to them. The
 *      engine's `isBlockedDomain` is exact canonical-host membership, so a
 *      purge that matched wider would delete content for instances we still
 *      federate with.
 *
 * Also covered: `www.` spellings ARE matched (36 such rows exist in production
 * and a naive equality query misses them); files belonging to ANOTHER
 * application are never deleted and instead retain the shared user row; the
 * caller's identity comes from the service credential and not the request body;
 * and the destructive path is refused unless the deployment is armed.
 *
 * ## What the port changed here
 *
 * `main` wrote this suite against in-memory doubles for the `User`, `File` and
 * `Follow` Mongoose models — and the purge service it exercised was Mongoose
 * too. The service is now Postgres, so the doubles no longer stand between the
 * test and the store: every row below is a real row, and every assertion reads
 * one back. Three consequences worth naming, because they are what a reader
 * would otherwise flag as a weakened case:
 *
 *   - **"Wrote nothing" is now a store DIFF, not an unused mock.** The old
 *     `assertNothingWritten()` asserted that seven jest doubles were never
 *     called, which is satisfied by a purge that writes through any path those
 *     doubles did not model. {@link expectStoreUnchanged} snapshots the rows
 *     themselves — users, their `accountStatus`, files, their `status`, follow
 *     edges, blocks and restrictions — and requires them identical afterwards.
 *   - **"Deleted" means what the store means.** `assetService.deleteFile`
 *     tombstones (`status:'deleted'`) rather than removing the row, and
 *     `files.owner_user_id` is `ON DELETE CASCADE`, so a file whose actor was
 *     purged has no row at all. Both are asserted as they actually are.
 *   - **Domains are unique per test.** One database is shared by every test in
 *     the run (jest.globalSetup creates it once and workers run in parallel
 *     against it), and `actorsMatched` counts every row carrying the domain —
 *     so a fixed `evil.example` would make two tests, or two suites, count each
 *     other's actors. {@link freshDomain} gives each case its own host.
 *
 * The real router, the real body schema, the real purge service, the real
 * `userService` graph teardown, the real `assetService.deleteFile` and the real
 * `@oxyhq/federation` canonicaliser all run. Only S3 (an object store, not a
 * store of record) and the service-credential middleware are substituted.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';

const CALLER_APP_ID = 'app-mention';
const OTHER_APP_ID = 'app-allo';

/** Our own federation apex, as the mocked `isOwnFederationDomain` knows it. */
const OWN_APEX = 'oxy.so';

/** What the mocked service-credential middleware asserts on each request. */
let callerScopes: string[] = ['federation:write'];

jest.mock('../../middleware/auth', () => ({
  serviceAuthMiddleware: (
    req: { serviceApp?: Record<string, unknown> },
    _res: unknown,
    next: () => void,
  ) => {
    req.serviceApp = {
      type: 'service',
      appId: CALLER_APP_ID,
      appName: 'mention',
      credentialId: 'cred-1',
      scopes: callerScopes,
    };
    next();
  },
}));

jest.mock('../../services/securityActivityService', () => ({ __esModule: true, default: {} }));

// `federation.service` builds its own-domain set at module load from env; the
// membership test itself is `OWN_FEDERATION_DOMAINS.has(canonicalFederationHost(d))`,
// which is reproduced here over the REAL canonicaliser so `www.oxy.so` is
// refused by the apex guard for the same reason the real one refuses it.
jest.mock('../../services/federation.service', () => {
  const { canonicalFederationHost } = jest.requireActual('@oxyhq/federation');
  return {
    __esModule: true,
    getUserPublicKey: jest.fn(),
    signWithKeyId: jest.fn(),
    isOwnFederationDomain: (domain: string) => canonicalFederationHost(domain) === OWN_APEX,
  };
});

// The REAL AssetService over a stub object store: deleting a file must write the
// tombstone this suite reads back, and only the S3 round-trip is fake.
jest.mock('../../services/assetServiceSingleton', () => {
  const { AssetService } = jest.requireActual('../../services/assetService');
  const s3Service = {
    deleteFile: async () => undefined,
    fileExists: async () => false,
  };
  return { __esModule: true, assetService: new AssetService(s3Service), s3Service };
});

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

/**
 * The canonical host rule, REAL, but reachable — one case has to make it answer
 * "no" for a candidate the query returned (see the re-verification test below).
 * Every other export, and every other call, is the genuine implementation.
 */
jest.mock('@oxyhq/federation', () => {
  const actual = jest.requireActual('@oxyhq/federation');
  return { __esModule: true, ...actual, isSameFederationHost: jest.fn(actual.isSameFederationHost) };
});

import { asc, eq, inArray, or } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { blocks } from '../../db/schema/blocks';
import { fileLinks } from '../../db/schema/fileLinks';
import { files } from '../../db/schema/files';
import { restrictions } from '../../db/schema/restrictions';
import { userFollows } from '../../db/schema/userFollows';
import { USER_TYPES, users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import * as purgeService from '../../services/federation/blockedDomainPurge.service';
import type { BlockedDomainPurgeResult } from '../../services/federation/blockedDomainPurge.service';
import userCache from '../../utils/userCache';
import federationRouter from '../federation';

type UserType = (typeof USER_TYPES)[number];

type FederationModule = typeof import('@oxyhq/federation');

const { isSameFederationHost: realIsSameFederationHost } =
  jest.requireActual<FederationModule>('@oxyhq/federation');
const federationModule = jest.requireMock<
  FederationModule & { isSameFederationHost: jest.Mock }
>('@oxyhq/federation');

interface JsonResponse {
  status: number;
  body: { message?: string; error?: string; data?: BlockedDomainPurgeResult };
}

let server: http.Server;
const originalArmed = process.env.FEDERATION_DOMAIN_PURGE_ENABLED;

/**
 * Rows this test seeded. Only these are snapshotted or asserted on — every other
 * row in the shared database belongs to another test or another worker.
 */
let seededUserIds: string[] = [];
let seededFileIds: string[] = [];

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
    req.write(body);
    req.end();
  });
}

function purge(payload: Record<string, unknown>): Promise<JsonResponse> {
  return post('/federation/domain-purge', payload);
}

/** The plan/result of a call that was supposed to succeed. */
function planOf(res: JsonResponse): BlockedDomainPurgeResult {
  expect(res.status).toBe(200);
  const { data } = res.body;
  if (data === undefined) {
    throw new Error(`expected a purge result, got ${JSON.stringify(res.body)}`);
  }
  return data;
}

/**
 * A host no other test (or parallel worker) is purging. The database outlives
 * each test, and every count in the result is domain-scoped over the whole
 * table, so a shared host would let one case observe another's actors.
 */
function freshDomain(): string {
  return `blocked-${randomBytes(6).toString('hex')}.example`;
}

async function seedUser(values: Partial<typeof users.$inferInsert>): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${randomBytes(6).toString('hex')}`, ...values })
    .returning({ id: users.id });
  seededUserIds.push(row.id);
  return row.id;
}

function seedFederatedUser(domain: string): Promise<string> {
  return seedUser({ type: 'federated', federationDomain: domain });
}

function seedLocalUser(type: UserType = 'local'): Promise<string> {
  return seedUser({ type });
}

async function seedFile(
  ownerUserId: string,
  metadata: Record<string, unknown>,
  size = 100,
): Promise<string> {
  const [row] = await getDb()
    .insert(files)
    .values({
      // `files_sha256_live_key` admits ONE live row per hash across the whole
      // table, and suites run in parallel against one database.
      sha256: randomBytes(32).toString('hex'),
      size,
      mime: 'image/png',
      ext: 'png',
      visibility: 'public',
      storageKey: `public/content/2026/08/aa/${randomBytes(8).toString('hex')}.png`,
      ownerUserId,
      metadata,
    })
    .returning({ id: files.id });
  seededFileIds.push(row.id);
  return row.id;
}

async function follow(followerId: string, followedId: string): Promise<void> {
  await getDb().insert(userFollows).values({ followerId, followedId });
}

async function userExists(id: string): Promise<boolean> {
  const [row] = await getDb().select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
  return row !== undefined;
}

async function accountStatusOf(id: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ accountStatus: users.accountStatus })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row?.accountStatus ?? null;
}

/**
 * A file's lifecycle as the store holds it: its `status`, or `'gone'` when the
 * row itself no longer exists (its owner was hard-deleted and the row cascaded).
 * `'active'` is the only value that means the asset survived the purge.
 */
async function fileState(id: string): Promise<string> {
  const [row] = await getDb()
    .select({ status: files.status })
    .from(files)
    .where(eq(files.id, id))
    .limit(1);
  return row?.status ?? 'gone';
}

/** Everything this test seeded, in a form two snapshots can be compared by. */
async function storeState(): Promise<unknown> {
  const db = getDb();
  const [userRows, fileRows, followRows, blockRows, restrictionRows] = await Promise.all([
    db
      .select({ id: users.id, type: users.type, accountStatus: users.accountStatus })
      .from(users)
      .where(inArray(users.id, seededUserIds))
      .orderBy(asc(users.id)),
    db
      .select({ id: files.id, status: files.status })
      .from(files)
      .where(inArray(files.id, seededFileIds))
      .orderBy(asc(files.id)),
    db
      .select({ followerId: userFollows.followerId, followedId: userFollows.followedId })
      .from(userFollows)
      .where(
        or(
          inArray(userFollows.followerId, seededUserIds),
          inArray(userFollows.followedId, seededUserIds),
        ),
      )
      .orderBy(asc(userFollows.id)),
    db
      .select({ userId: blocks.userId, blockedId: blocks.blockedId })
      .from(blocks)
      .where(or(inArray(blocks.userId, seededUserIds), inArray(blocks.blockedId, seededUserIds)))
      .orderBy(asc(blocks.id)),
    db
      .select({ userId: restrictions.userId, restrictedId: restrictions.restrictedId })
      .from(restrictions)
      .where(
        or(
          inArray(restrictions.userId, seededUserIds),
          inArray(restrictions.restrictedId, seededUserIds),
        ),
      )
      .orderBy(asc(restrictions.id)),
  ]);
  return { userRows, fileRows, followRows, blockRows, restrictionRows };
}

/**
 * Nothing this test seeded moved. Replaces `main`'s "these seven doubles were
 * never called": a write through a path the doubles did not model satisfied
 * that, and cannot satisfy this.
 */
async function expectStoreUnchanged(before: unknown): Promise<void> {
  expect(await storeState()).toEqual(before);
}

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
  if (originalArmed === undefined) delete process.env.FEDERATION_DOMAIN_PURGE_ENABLED;
  else process.env.FEDERATION_DOMAIN_PURGE_ENABLED = originalArmed;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

beforeEach(() => {
  seededUserIds = [];
  seededFileIds = [];
  callerScopes = ['federation:write'];
  process.env.FEDERATION_DOMAIN_PURGE_ENABLED = 'true';
  // `mockReset` also drops any unconsumed one-shot answer, so a case that
  // queued one and then threw cannot leak it into the next test.
  federationModule.isSameFederationHost.mockReset();
  federationModule.isSameFederationHost.mockImplementation(realIsSameFederationHost);
});

afterEach(() => {
  jest.restoreAllMocks();
});

interface BlockedCorpus {
  domain: string;
  /** The two blocked-domain actors, in the order the cursor will visit them. */
  actors: [string, string];
  fileA: string;
  avatarA: string;
  fileB: string;
  avatarB: string;
}

/**
 * Two blocked-domain actors, each with one caller-owned file and one avatar.
 *
 * The pair is returned in `id` order rather than seeding order: the scan is
 * `order by id`, and `generatedId()` mints a uuid v7 whose ordering within a
 * single millisecond is not guaranteed — so a cursor assertion that assumed
 * seeding order would be a rare flake, not a failure.
 */
async function seedBlockedDomainCorpus(domain: string): Promise<BlockedCorpus> {
  const first = await seedFederatedUser(domain);
  const second = await seedFederatedUser(domain);
  const [actorA, actorB] = [first, second].sort();

  return {
    domain,
    actors: [actorA, actorB],
    fileA: await seedFile(actorA, { source: 'federation', serviceAppId: CALLER_APP_ID }, 500),
    avatarA: await seedFile(actorA, { source: 'federation', role: 'avatar' }, 20),
    fileB: await seedFile(actorB, { source: 'federation', serviceAppId: CALLER_APP_ID }, 700),
    avatarB: await seedFile(actorB, { source: 'federation', role: 'avatar' }, 30),
  };
}

describe('POST /federation/domain-purge — dry run writes nothing', () => {
  it('plans a full purge and performs ZERO writes', async () => {
    const corpus = await seedBlockedDomainCorpus(freshDomain());
    const before = await storeState();

    const data = planOf(await purge({ domain: corpus.domain, dryRun: true }));

    // The plan is non-empty: "wrote nothing" cannot be satisfied by "did nothing".
    expect(data.actorsMatched).toBe(2);
    expect(data.actorsProcessed).toBe(2);
    expect(data.actorsDeleted).toBe(2);
    expect(data.filesDeleted).toBe(2);
    expect(data.avatarsDeleted).toBe(2);
    expect(data.bytesDeleted).toBe(500 + 20 + 700 + 30);
    expect(data.dryRun).toBe(true);

    await expectStoreUnchanged(before);
  });

  it('defaults to a dry run when the caller omits dryRun', async () => {
    const corpus = await seedBlockedDomainCorpus(freshDomain());
    const before = await storeState();

    const data = planOf(await purge({ domain: corpus.domain }));

    expect(data.dryRun).toBe(true);
    expect(data.actorsDeleted).toBe(2);
    await expectStoreUnchanged(before);
  });

  it('produces the same plan on the dry run as the real run applies', async () => {
    const corpus = await seedBlockedDomainCorpus(freshDomain());

    const planned = planOf(await purge({ domain: corpus.domain, dryRun: true }));
    const applied = planOf(await purge({ domain: corpus.domain, dryRun: false }));

    expect(applied.actorsDeleted).toBe(planned.actorsDeleted);
    expect(applied.filesDeleted).toBe(planned.filesDeleted);
    expect(applied.avatarsDeleted).toBe(planned.avatarsDeleted);
    expect(applied.bytesDeleted).toBe(planned.bytesDeleted);

    // And the applied numbers describe the store: both actors gone, and their
    // files with them (`files.owner_user_id` cascades).
    expect(await userExists(corpus.actors[0])).toBe(false);
    expect(await userExists(corpus.actors[1])).toBe(false);
    expect(await fileState(corpus.fileA)).toBe('gone');
    expect(await fileState(corpus.avatarB)).toBe('gone');
  });
});

describe('POST /federation/domain-purge — a non-blocked domain is never touched', () => {
  it('leaves a SUBDOMAIN of the blocked host untouched', async () => {
    const domain = freshDomain();
    const blockedActor = await seedFederatedUser(domain);
    const subdomainActor = await seedFederatedUser(`sub.${domain}`);
    const subdomainFile = await seedFile(subdomainActor, {
      source: 'federation',
      serviceAppId: CALLER_APP_ID,
    });

    const data = planOf(await purge({ domain, dryRun: false }));

    expect(data.actorsDeleted).toBe(1);
    // The subdomain actor and its file survive: the engine still federates with it.
    expect(await userExists(subdomainActor)).toBe(true);
    expect(await fileState(subdomainFile)).toBe('active');
    expect(await userExists(blockedActor)).toBe(false);
  });

  it('leaves an unrelated domain untouched', async () => {
    const domain = freshDomain();
    const blockedActor = await seedFederatedUser(domain);
    const otherActor = await seedFederatedUser(freshDomain());
    const otherFile = await seedFile(otherActor, {
      source: 'federation',
      serviceAppId: CALLER_APP_ID,
    });

    planOf(await purge({ domain, dryRun: false }));

    expect(await userExists(blockedActor)).toBe(false);
    expect(await userExists(otherActor)).toBe(true);
    expect(await fileState(otherFile)).toBe('active');
  });

  it('refuses to purge our own federation apex and writes nothing', async () => {
    const actor = await seedFederatedUser(OWN_APEX);
    const before = await storeState();

    const res = await purge({ domain: OWN_APEX, dryRun: false });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/own federation domain/i);
    await expectStoreUnchanged(before);
    expect(await userExists(actor)).toBe(true);
  });

  it('never deletes a non-federated user even if one carries the blocked domain', async () => {
    const domain = freshDomain();
    const local = await seedUser({ type: 'local', federationDomain: domain });
    const localFile = await seedFile(local, { source: 'federation', serviceAppId: CALLER_APP_ID });
    const before = await storeState();

    const data = planOf(await purge({ domain, dryRun: false }));

    expect(data.actorsMatched).toBe(0);
    expect(data.actorsProcessed).toBe(0);
    expect(await userExists(local)).toBe(true);
    expect(await fileState(localFile)).toBe('active');
    await expectStoreUnchanged(before);
  });
});

describe('POST /federation/domain-purge — canonical host matching', () => {
  it('matches a stored www. spelling of the blocked host', async () => {
    const domain = freshDomain();
    const actor = await seedFederatedUser(`www.${domain}`);
    const file = await seedFile(actor, { source: 'federation', serviceAppId: CALLER_APP_ID });

    const data = planOf(await purge({ domain, dryRun: false }));

    expect(data.actorsDeleted).toBe(1);
    expect(data.candidatesRejected).toBe(0);
    expect(await userExists(actor)).toBe(false);
    expect(await fileState(file)).toBe('gone');
  });

  it('matches when the CALLER spells the domain with www. and the store does not', async () => {
    const domain = freshDomain();
    const actor = await seedFederatedUser(domain);

    const data = planOf(await purge({ domain: `www.${domain}`, dryRun: false }));

    expect(data.canonicalDomain).toBe(domain);
    expect(await userExists(actor)).toBe(false);
  });

  /**
   * The candidate query and the re-verification are TWO separate guards, and the
   * query normally hides the second one: a subdomain row is never fetched, so
   * `isSameFederationHost` never gets to reject it. That leaves the
   * re-verification — the thing that is supposed to make a widened query
   * harmless — completely unexercised, and a test suite that only seeds a
   * subdomain passes whether it exists or not.
   *
   * So drive it at its own seam. `main` injected the fault into the candidate
   * QUERY (a `User.find` double returning a row it should not have). Against a
   * real Postgres that lever is gone, and it cannot be replaced by data: the
   * query filters on `federation_domain` and the re-verification reads the SAME
   * column off the SAME row, so any row the query returns necessarily satisfies
   * `isSameFederationHost`. The injection therefore moves one step along, onto
   * the rule's answer — which is the same fault seen from the guard's side, and
   * the invariant asserted is unchanged: a candidate the canonical rule refuses
   * is skipped, counted, and NOTHING belonging to it is touched.
   */
  it('rejects a candidate the query returned but the canonical rule does not match', async () => {
    const domain = freshDomain();
    const actor = await seedFederatedUser(domain);
    const file = await seedFile(actor, { source: 'federation', serviceAppId: CALLER_APP_ID });
    const before = await storeState();

    federationModule.isSameFederationHost.mockReturnValueOnce(false);

    const data = planOf(await purge({ domain, dryRun: false }));

    expect(data.candidatesRejected).toBe(1);
    expect(data.actorsProcessed).toBe(0);
    expect(data.actorsDeleted).toBe(0);
    expect(await userExists(actor)).toBe(true);
    expect(await fileState(file)).toBe('active');
    await expectStoreUnchanged(before);
  });

  it('rejects a domain that is not a bare host', async () => {
    const domain = freshDomain();
    await seedFederatedUser(domain);
    const before = await storeState();

    const res = await purge({ domain: `https://${domain}/path`, dryRun: false });

    expect(res.status).toBe(400);
    await expectStoreUnchanged(before);
  });
});

describe('POST /federation/domain-purge — multi-tenancy', () => {
  it("never deletes another application's files, and RETAINS the shared row", async () => {
    const domain = freshDomain();
    const actor = await seedFederatedUser(domain);
    const mine = await seedFile(actor, { source: 'federation', serviceAppId: CALLER_APP_ID }, 100);
    const theirs = await seedFile(actor, { source: 'federation', serviceAppId: OTHER_APP_ID }, 900);
    const avatar = await seedFile(actor, { source: 'federation', role: 'avatar' }, 20);
    const invalidate = jest.spyOn(userCache, 'invalidate');

    const data = planOf(await purge({ domain, dryRun: false }));

    expect(data.filesDeleted).toBe(1);
    expect(data.bytesDeleted).toBe(100);
    expect(data.actorsDeleted).toBe(0);
    expect(data.actorsRetained).toEqual([
      expect.objectContaining({ oxyUserId: actor, referencedByAppIds: [OTHER_APP_ID] }),
    ]);

    // The other app's file AND the shared row survive; the row is archived.
    expect(await fileState(theirs)).toBe('active');
    expect(await fileState(mine)).toBe('deleted');
    // The avatar belongs to the row, which survived, so it survives too.
    expect(await fileState(avatar)).toBe('active');
    expect(await accountStatusOf(actor)).toBe('archived');
    expect(invalidate).toHaveBeenCalledWith(actor);
  });

  it('scopes deletion by the CREDENTIAL, ignoring any app id in the body', async () => {
    const domain = freshDomain();
    const actor = await seedFederatedUser(domain);
    const theirs = await seedFile(actor, { source: 'federation', serviceAppId: OTHER_APP_ID });

    // A caller trying to delete another app's data by asserting its id.
    const data = planOf(
      await purge({
        domain,
        dryRun: false,
        callerAppId: OTHER_APP_ID,
        serviceAppId: OTHER_APP_ID,
        appId: OTHER_APP_ID,
      }),
    );

    expect(data.filesDeleted).toBe(0);
    expect(await fileState(theirs)).toBe('active');
  });

  it('reports local followers so a user-visible purge is seen before it runs', async () => {
    const domain = freshDomain();
    const actor = await seedFederatedUser(domain);
    const localFollower = await seedLocalUser();
    const federatedFollower = await seedFederatedUser(freshDomain());
    await follow(localFollower, actor);
    await follow(federatedFollower, actor);
    const before = await storeState();

    const data = planOf(await purge({ domain, dryRun: true }));

    // Only the LOCAL follower counts — a real person losing a follow is what
    // makes the purge user-visible.
    expect(data.localFollowersAffected).toBe(1);
    await expectStoreUnchanged(before);
  });

  it('deletes a mirrored file that still carries a link row', async () => {
    // Federation media is linked to the app entity it was mirrored for, and an
    // unforced delete refuses a linked file. The purge passes `force`, so a
    // regression there would silently leave every linked file behind while the
    // actor row and its avatars still went.
    const domain = freshDomain();
    const actor = await seedFederatedUser(domain);
    const linked = await seedFile(actor, { source: 'federation', serviceAppId: CALLER_APP_ID }, 100);
    await getDb().insert(fileLinks).values({
      fileId: linked,
      app: 'mention',
      entityType: 'post',
      entityId: 'post-1',
      createdBy: actor,
    });

    const data = planOf(await purge({ domain, dryRun: false }));

    expect(data.filesDeleted).toBe(1);
    expect(data.bytesDeleted).toBe(100);
    expect(await userExists(actor)).toBe(false);
  });
});

describe('POST /federation/domain-purge — authorisation and arming', () => {
  it('rejects a credential without federation:write and reads nothing', async () => {
    callerScopes = [];
    const corpus = await seedBlockedDomainCorpus(freshDomain());
    const before = await storeState();
    // The engine is the boundary the gate must precede: `main` asserted the
    // `User.find` double was never called, which said the same thing about the
    // only read it modelled.
    const engine = jest.spyOn(purgeService, 'purgeBlockedDomain');

    const res = await purge({ domain: corpus.domain, dryRun: false });

    expect(res.status).toBe(403);
    expect(engine).not.toHaveBeenCalled();
    await expectStoreUnchanged(before);
  });

  it('refuses a real purge when the deployment is not armed', async () => {
    process.env.FEDERATION_DOMAIN_PURGE_ENABLED = 'false';
    const corpus = await seedBlockedDomainCorpus(freshDomain());
    const before = await storeState();
    const engine = jest.spyOn(purgeService, 'purgeBlockedDomain');

    const res = await purge({ domain: corpus.domain, dryRun: false });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/FEDERATION_DOMAIN_PURGE_ENABLED/);
    expect(engine).not.toHaveBeenCalled();
    await expectStoreUnchanged(before);
    expect(await userExists(corpus.actors[0])).toBe(true);
    expect(await userExists(corpus.actors[1])).toBe(true);
  });

  it('still allows a DRY RUN on an unarmed deployment', async () => {
    process.env.FEDERATION_DOMAIN_PURGE_ENABLED = 'false';
    const corpus = await seedBlockedDomainCorpus(freshDomain());
    const before = await storeState();

    const data = planOf(await purge({ domain: corpus.domain, dryRun: true }));

    expect(data.actorsDeleted).toBe(2);
    await expectStoreUnchanged(before);
  });
});

describe('POST /federation/domain-purge — bounded, resumable, idempotent', () => {
  it('processes at most `limit` actors and resumes from the cursor', async () => {
    const corpus = await seedBlockedDomainCorpus(freshDomain());
    const [actorA, actorB] = corpus.actors;

    const first = planOf(await purge({ domain: corpus.domain, dryRun: false, limit: 1 }));

    expect(first.actorsProcessed).toBe(1);
    expect(first.actorsDeleted).toBe(1);
    expect(first.done).toBe(false);
    expect(first.nextCursor).toBe(actorA);
    expect(await userExists(actorA)).toBe(false);
    expect(await userExists(actorB)).toBe(true);

    const second = planOf(
      await purge({
        domain: corpus.domain,
        dryRun: false,
        limit: 1,
        afterId: first.nextCursor,
      }),
    );

    expect(second.actorsProcessed).toBe(1);
    expect(second.remaining).toBe(0);
    expect(await userExists(actorB)).toBe(false);
    // Every file of both actors went with them.
    for (const fileId of [corpus.fileA, corpus.avatarA, corpus.fileB, corpus.avatarB]) {
      expect(await fileState(fileId)).toBe('gone');
    }
  });

  /**
   * Progress must not depend on rows disappearing. A DRY RUN deletes nothing,
   * so a loop keyed on "are any rows left?" re-fetches the same head of the
   * batch forever while reporting steady progress. The cursor is what makes a
   * dry run terminate, so drive a whole one and require it to end.
   */
  it('a dry run walks to completion instead of looping on the first batch', async () => {
    const corpus = await seedBlockedDomainCorpus(freshDomain());
    const before = await storeState();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pass = 0;

    for (;;) {
      pass += 1;
      expect(pass).toBeLessThanOrEqual(5); // a livelock fails here, loudly
      const body: Record<string, unknown> = { domain: corpus.domain, dryRun: true, limit: 1 };
      if (cursor !== null) body.afterId = cursor;
      const data = planOf(await purge(body));
      if (data.nextCursor !== null) seen.push(data.nextCursor);
      cursor = data.nextCursor;
      if (data.done) break;
    }

    // Both actors were visited exactly once, and nothing was written.
    expect(seen).toEqual([corpus.actors[0], corpus.actors[1]]);
    await expectStoreUnchanged(before);
  });

  it('is a no-op when repeated after the domain is already purged', async () => {
    const corpus = await seedBlockedDomainCorpus(freshDomain());
    planOf(await purge({ domain: corpus.domain, dryRun: false }));
    const before = await storeState();

    const repeat = planOf(await purge({ domain: corpus.domain, dryRun: false }));

    expect(repeat.actorsMatched).toBe(0);
    expect(repeat.actorsProcessed).toBe(0);
    expect(repeat.actorsDeleted).toBe(0);
    expect(repeat.done).toBe(true);
    expect(repeat.nextCursor).toBeNull();
    await expectStoreUnchanged(before);
  });

  /**
   * A retained row keeps matching the domain forever by design. If progress were
   * keyed on `remaining`, a batch full of retained rows would be re-fetched on
   * every pass and the caller would never terminate. The cursor steps past them.
   */
  it('advances past a retained actor instead of re-fetching it forever', async () => {
    const domain = freshDomain();
    const first = await seedFederatedUser(domain);
    const second = await seedFederatedUser(domain);
    // The RETAINED actor has to be the one the cursor reaches first, so it is
    // chosen by id order rather than by seeding order.
    const [retained, deletable] = [first, second].sort();
    const theirs = await seedFile(retained, { source: 'federation', serviceAppId: OTHER_APP_ID });
    const mine = await seedFile(deletable, { source: 'federation', serviceAppId: CALLER_APP_ID });

    const pass1 = planOf(await purge({ domain, dryRun: false, limit: 1 }));

    expect(pass1.actorsRetained).toHaveLength(1);
    expect(pass1.nextCursor).toBe(retained);
    // The retained row is still there and still matches — so `remaining` alone
    // could never be the loop condition.
    expect(pass1.remaining).toBeGreaterThan(0);

    const pass2 = planOf(
      await purge({ domain, dryRun: false, limit: 1, afterId: pass1.nextCursor }),
    );

    // The cursor moved past the retained row onto the next actor.
    expect(pass2.actorsDeleted).toBe(1);
    expect(await userExists(deletable)).toBe(false);
    expect(await fileState(mine)).toBe('gone');
    expect(await userExists(retained)).toBe(true);
    expect(await fileState(theirs)).toBe('active');
  });

  /**
   * A retained actor is the one row a repeat pass keeps reaching: it survives by
   * design, so every later purge of that domain fetches it again. The pass must
   * still be a no-op — which it only is because a tombstoned file is not counted
   * as data the actor still holds.
   */
  it('is a no-op when repeated over a RETAINED actor', async () => {
    const domain = freshDomain();
    const actor = await seedFederatedUser(domain);
    await seedFile(actor, { source: 'federation', serviceAppId: OTHER_APP_ID }, 900);
    const mine = await seedFile(actor, { source: 'federation', serviceAppId: CALLER_APP_ID }, 100);

    const firstPass = planOf(await purge({ domain, dryRun: false }));
    expect(firstPass.filesDeleted).toBe(1);
    expect(firstPass.bytesDeleted).toBe(100);
    expect(await fileState(mine)).toBe('deleted');
    const before = await storeState();

    const repeat = planOf(await purge({ domain, dryRun: false }));

    // The row is reached again — it is retained, not gone — but its tombstone
    // is not re-deleted and not re-counted.
    expect(repeat.actorsProcessed).toBe(1);
    expect(repeat.filesDeleted).toBe(0);
    expect(repeat.bytesDeleted).toBe(0);
    expect(repeat.actorsRetained).toHaveLength(1);
    await expectStoreUnchanged(before);
  });
});
