/**
 * Federation Service — resolveAndUpsert fast + eventually-fresh, against a REAL
 * Postgres.
 *
 * Covers the Bluesky-style refresh contract:
 *  - A FRESH cached federated user is returned immediately with NO remote
 *    WebFinger / actor fetch / avatar download (never blocks the caller).
 *  - A STALE cached user is still returned immediately, but schedules a
 *    background refresh that re-fetches the actor, downloads the avatar, writes
 *    the new file id to the user, and invalidates the user cache.
 *  - The background refresh is throttled (storm guard): a second resolve within
 *    the min-interval does not launch another refresh.
 *  - A failing background refresh never throws out of resolveAndUpsert.
 *
 * ## Why the rewrite mattered here more than anywhere else
 *
 * The suite this replaces mocked `models/User` and asserted on the `$set`
 * PAYLOAD of `findOneAndUpdate`/`updateOne` — e.g.
 * `expect(updateArgs[1].$set).toMatchObject({ 'name.first': 'Alice Updated' })`.
 * Those assertions passed against a service whose write went to Mongo while
 * `routes/federation.ts` and `routes/profiles.ts` READ from Postgres: the exact
 * cross-store split this port closes was invisible to them, because no
 * assertion ever looked at a stored row.
 *
 * Worse, `'name.first'` is a Mongo DOT PATH. Drizzle keys `set()` by column
 * PROPERTY and silently ignores an unknown key, so a naive port of that literal
 * writes NOTHING and throws NOTHING. Every write assertion below therefore
 * reads the row back and checks `name_first` really moved.
 *
 * The storm guard uses module-level state keyed by actor URI, which persists
 * across tests in this file. Each test therefore uses a UNIQUE handle/actor so
 * the in-flight set and last-attempt map never collide between cases.
 *
 * MOCKED, because each is a collaborator this file is not about: `userCache`
 * (invalidation is asserted, not exercised), the asset/S3 services (federated
 * avatar storage), and `safeFetch` (all outbound traffic).
 */

const mockCacheInvalidate = jest.fn();
const mockAssetFileContentExists = jest.fn();
const mockAssetUploadFileDirect = jest.fn();
const mockAssetDeleteFile = jest.fn();

process.env.AWS_ACCESS_KEY_ID ||= 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY ||= 'test-secret-key';
process.env.AWS_S3_BUCKET ||= 'test-bucket';

jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: mockCacheInvalidate },
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// AssetService / S3 are reached when federated avatar storage is verified or
// repaired. Keep the mock stateful so tests can exercise both usable and
// missing local storage without touching AWS.
jest.mock('../assetService', () => ({
  __esModule: true,
  AssetService: class {
    fileContentExists(...args: unknown[]) {
      return mockAssetFileContentExists(...args);
    }

    uploadFileDirect(...args: unknown[]) {
      return mockAssetUploadFileDirect(...args);
    }

    deleteFile(...args: unknown[]) {
      return mockAssetDeleteFile(...args);
    }
  },
}));
jest.mock('../s3Service', () => ({
  __esModule: true,
  createS3Service: jest.fn(() => ({})),
}));

// All outbound federation traffic now goes through @oxyhq/core/server's
// DNS-pinned safeFetch. Mock it so tests drive the response (and assert the
// SSRF guard rejects private/non-https targets) without real network I/O.
const mockSafeFetch = jest.fn();
class FakeSsrfRejection extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SsrfRejection';
  }
}
jest.mock('@oxyhq/core/server', () => ({
  __esModule: true,
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfRejection: FakeSsrfRejection,
}));

import { Readable } from 'stream';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { federationService, isOwnFederationDomain } from '../federation.service';

/**
 * Build a fake SafeFetchResult whose `.response` is a real Node Readable stream
 * (what safeFetch yields), so the service's streaming/byte-cap readers run for
 * real against controlled bytes.
 */
function makeSafeFetchResult(
  status: number,
  headers: Record<string, string>,
  body: Buffer | string = Buffer.alloc(0),
): {
  status: number;
  headers: Record<string, string>;
  finalUrl: string;
  response: Readable & { destroy: () => void };
} {
  const buffer = typeof body === 'string' ? Buffer.from(body) : body;
  const stream = Readable.from([buffer]) as Readable & { destroy: () => void };
  return { status, headers, finalUrl: 'https://cdn.example/final', response: stream };
}

const DOMAIN = 'mastodon.social';
const NEW_AVATAR_URL = 'https://cdn.example/avatar-new.png';

let actorCounter = 0;

interface Fixture {
  handle: string;
  actorUri: string;
  domain: string;
}

function nextFixture(domain: string = DOMAIN): Fixture {
  actorCounter += 1;
  const local = `alice${actorCounter}`;
  return {
    handle: `${local}@${domain}`,
    actorUri: `https://${domain}/users/${local}`,
    domain,
  };
}

/**
 * Insert a cached federated actor exactly as `resolveAndUpsert` would find one.
 *
 * Rows are NEVER deleted afterwards: the throwaway database is shared by the
 * whole run, and suites that bracket a global COUNT (`platformStats`) assume
 * counts only grow — a cleanup delete makes the service's count fall below the
 * bracket's floor and fails a suite this file has nothing to do with. Every
 * fixture is uniquely named instead, so nothing here depends on the table's
 * contents.
 *
 * `updated_at` is written EXPLICITLY: the staleness decision reads it, and the
 * column's `defaultNow()` would otherwise pin every fixture to "just written"
 * and make the stale cases untestable.
 */
async function seedFederatedUser(
  fx: Fixture,
  ageMs: number,
  over: Partial<typeof users.$inferInsert> = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({
      type: 'federated',
      username: fx.handle,
      federationActorUri: fx.actorUri,
      federationDomain: fx.domain,
      avatar: 'stored-file-id',
      updatedAt: new Date(Date.now() - ageMs),
      ...over,
    })
    .returning({ id: users.id });
  return row.id;
}

/** The columns a write assertion reads back. */
async function storedUser(userId: string) {
  const [row] = await getDb()
    .select({
      id: users.id,
      type: users.type,
      username: users.username,
      nameFirst: users.nameFirst,
      bio: users.bio,
      description: users.description,
      avatar: users.avatar,
      actorUri: users.federationActorUri,
      domain: users.federationDomain,
      lastResolvedAt: users.federationLastResolvedAt,
      lastAvatarFetchedAt: users.federationLastAvatarFetchedAt,
      avatarETag: users.federationAvatarETag,
      avatarLastModified: users.federationAvatarLastModified,
      unavailableAt: users.federationUnavailableAt,
      unavailableReason: users.federationUnavailableReason,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

/** The row for an actor URI, which is what the upsert keys on. */
async function storedByActorUri(actorUri: string) {
  const [row] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.federationActorUri, actorUri))
    .limit(1);
  if (!row) return null;
  return storedUser(row.id);
}

const FRESH_AGE_MS = 60 * 1000; // 1 minute — well under the 24h stale window
const STALE_AGE_MS = 48 * 60 * 60 * 1000; // 48h — older than STALE_MS (24h)

function mockUploadedFile(fileId: string) {
  return { id: fileId };
}

function resetAssetMocks(): void {
  mockAssetFileContentExists.mockResolvedValue(true);
  mockAssetUploadFileDirect.mockResolvedValue(mockUploadedFile('uploaded-file-id'));
  mockAssetDeleteFile.mockResolvedValue(undefined);
}

/** Let any scheduled fire-and-forget background refresh settle. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

/**
 * A background refresh is fire-and-forget and now does real database I/O, so a
 * fixed number of microtask flushes would be a race. Poll until the row shows
 * the write, or give up — an assertion after this then reports the ACTUAL row
 * rather than a timing artifact.
 */
async function waitForRow(
  userId: string,
  predicate: (row: NonNullable<Awaited<ReturnType<typeof storedUser>>>) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = await storedUser(userId);
    if (row && predicate(row)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('FederationService.resolveAndUpsert (fast + eventually-fresh)', () => {
  let webfingerSpy: jest.SpyInstance;
  let actorSpy: jest.SpyInstance;
  let avatarSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    resetAssetMocks();
    webfingerSpy = jest.spyOn(federationService, 'resolveWebFingerResource');
    actorSpy = jest.spyOn(federationService, 'fetchActorProfile');
    avatarSpy = jest.spyOn(federationService, 'downloadAndStoreAvatar')
      .mockResolvedValue({ fileId: 'new-file-id', notModified: false });
  });

  afterEach(() => {
    webfingerSpy.mockRestore();
    actorSpy.mockRestore();
    avatarSpy.mockRestore();
  });

  it('returns a fresh cached user immediately without any remote I/O', async () => {
    const fx = nextFixture();
    webfingerSpy.mockResolvedValue({ actorUri: fx.actorUri, subjectAcct: fx.handle });
    actorSpy.mockResolvedValue(null);

    const userId = await seedFederatedUser(fx, FRESH_AGE_MS);

    const result = await federationService.resolveAndUpsert(fx.handle);
    await flushMicrotasks();

    // The cached row is handed back as the account document — `_id` is the
    // account id, which is what every caller re-reads by.
    expect(result?._id).toBe(userId);
    expect(result?.username).toBe(fx.handle);
    expect(mockAssetFileContentExists).toHaveBeenCalledWith('stored-file-id');
    expect(webfingerSpy).not.toHaveBeenCalled();
    expect(actorSpy).not.toHaveBeenCalled();
    expect(avatarSpy).not.toHaveBeenCalled();
    expect(mockCacheInvalidate).not.toHaveBeenCalled();
  });

  it('returns an archived cached user without scheduling background refresh', async () => {
    const fx = nextFixture();
    const userId = await seedFederatedUser(fx, STALE_AGE_MS, { accountStatus: 'archived' });

    const result = await federationService.resolveAndUpsert(fx.handle);
    await flushMicrotasks();

    expect(result?._id).toBe(userId);
    expect(webfingerSpy).not.toHaveBeenCalled();
    expect(actorSpy).not.toHaveBeenCalled();
    expect(avatarSpy).not.toHaveBeenCalled();
    expect(mockCacheInvalidate).not.toHaveBeenCalled();
  });

  it('returns the stale user immediately and runs a background refresh that updates avatar/name/bio + invalidates cache', async () => {
    const fx = nextFixture();
    webfingerSpy.mockResolvedValue({ actorUri: fx.actorUri, subjectAcct: fx.handle });
    actorSpy.mockResolvedValue({
      actorUri: fx.actorUri,
      domain: fx.domain,
      username: fx.handle,
      displayName: 'Alice Updated',
      avatarUrl: NEW_AVATAR_URL,
      bio: 'fresh bio',
    });

    const userId = await seedFederatedUser(fx, STALE_AGE_MS);

    const result = await federationService.resolveAndUpsert(fx.handle);
    expect(result?._id).toBe(userId); // returned synchronously, before the refresh resolves

    await waitForRow(userId, (row) => row.avatar === 'new-file-id');

    expect(actorSpy).toHaveBeenCalledWith(fx.actorUri, fx.handle);
    expect(avatarSpy).toHaveBeenCalledWith(
      NEW_AVATAR_URL,
      'stored-file-id',
      { etag: undefined, lastModified: undefined },
      userId,
    );

    // The ROW, not the call payload. `name_first` is the column the Mongo dot
    // path `'name.first'` used to name; a port that kept the dot path writes
    // nothing here, and this assertion is what says so.
    const row = await storedUser(userId);
    expect(row).toMatchObject({
      nameFirst: 'Alice Updated',
      bio: 'fresh bio',
      description: 'fresh bio',
      avatar: 'new-file-id',
    });
    expect(row?.lastResolvedAt).toBeInstanceOf(Date);
    expect(mockCacheInvalidate).toHaveBeenCalledWith(userId);
  });

  it('clears a stale bio when the remote actor profile is legitimately empty', async () => {
    const fx = nextFixture();
    webfingerSpy.mockResolvedValue({ actorUri: fx.actorUri, subjectAcct: fx.handle });
    actorSpy.mockResolvedValue({
      actorUri: fx.actorUri,
      domain: fx.domain,
      username: fx.handle,
      displayName: 'Alice Updated',
      avatarUrl: undefined,
      bio: '',
    });

    const userId = await seedFederatedUser(fx, STALE_AGE_MS, { bio: 'stale bridge boilerplate' });

    await federationService.resolveAndUpsert(fx.handle);
    await waitForRow(userId, (row) => row.bio === '');

    const row = await storedUser(userId);
    expect(row?.bio).toBe('');
    expect(row?.description).toBe('');
  });

  it('clears the unavailable tombstone on a successful background refresh', async () => {
    const fx = nextFixture();
    webfingerSpy.mockResolvedValue({ actorUri: fx.actorUri, subjectAcct: fx.handle });
    actorSpy.mockResolvedValue({
      actorUri: fx.actorUri,
      domain: fx.domain,
      username: fx.handle,
      displayName: 'Alice Back',
      avatarUrl: undefined,
      bio: undefined,
    });

    const userId = await seedFederatedUser(fx, STALE_AGE_MS, {
      federationUnavailableAt: new Date(),
      federationUnavailableReason: 'gone',
    });

    await federationService.resolveAndUpsert(fx.handle);
    await waitForRow(userId, (row) => row.nameFirst === 'Alice Back');

    // Mongo's `$unset` is a write of NULL here — "available" is what NULL means
    // on these two columns.
    const row = await storedUser(userId);
    expect(row?.unavailableAt).toBeNull();
    expect(row?.unavailableReason).toBeNull();
  });

  it('returns a fresh cached user but refreshes in the background when its stored avatar object is missing', async () => {
    const fx = nextFixture();
    mockAssetFileContentExists.mockResolvedValue(false);
    webfingerSpy.mockResolvedValue({ actorUri: fx.actorUri, subjectAcct: fx.handle });
    actorSpy.mockResolvedValue({
      actorUri: fx.actorUri,
      domain: fx.domain,
      username: fx.handle,
      displayName: 'Alice Repaired',
      avatarUrl: NEW_AVATAR_URL,
      bio: 'repaired bio',
    });

    const userId = await seedFederatedUser(fx, FRESH_AGE_MS);

    const result = await federationService.resolveAndUpsert(fx.handle);
    expect(result?._id).toBe(userId);

    await waitForRow(userId, (row) => row.avatar === 'new-file-id');

    expect(mockAssetFileContentExists).toHaveBeenCalledWith('stored-file-id');
    expect(actorSpy).toHaveBeenCalledWith(fx.actorUri, fx.handle);
    expect(avatarSpy).toHaveBeenCalledWith(
      NEW_AVATAR_URL,
      'stored-file-id',
      { etag: undefined, lastModified: undefined },
      userId,
    );
    expect((await storedUser(userId))?.nameFirst).toBe('Alice Repaired');
  });

  it('replays the STORED conditional-request validators on a background refresh', async () => {
    const fx = nextFixture();
    webfingerSpy.mockResolvedValue({ actorUri: fx.actorUri, subjectAcct: fx.handle });
    actorSpy.mockResolvedValue({
      actorUri: fx.actorUri,
      domain: fx.domain,
      username: fx.handle,
      displayName: 'Alice Conditional',
      avatarUrl: NEW_AVATAR_URL,
      bio: undefined,
    });

    const userId = await seedFederatedUser(fx, STALE_AGE_MS, {
      federationAvatarETag: '"etag-stored"',
      federationAvatarLastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
    });

    await federationService.resolveAndUpsert(fx.handle);
    await waitForRow(userId, (row) => row.nameFirst === 'Alice Conditional');

    // The validators live in `federation_avatar_etag` /
    // `federation_avatar_last_modified` COLUMNS, not on the account document's
    // `federation` key (which carries only actorUri/domain). Reading them off
    // that key would compile — through the index signature — and be `undefined`
    // forever, turning every background refresh into an unconditional
    // re-download of an unchanged image.
    expect(avatarSpy).toHaveBeenCalledWith(
      NEW_AVATAR_URL,
      'stored-file-id',
      { etag: '"etag-stored"', lastModified: 'Wed, 21 Oct 2025 07:28:00 GMT' },
      userId,
    );
  });

  it('throttles repeated background refreshes for the same actor (storm guard)', async () => {
    const fx = nextFixture();
    webfingerSpy.mockResolvedValue({ actorUri: fx.actorUri, subjectAcct: fx.handle });
    actorSpy.mockResolvedValue({
      actorUri: fx.actorUri,
      domain: fx.domain,
      username: fx.handle,
      displayName: 'Alice',
      avatarUrl: NEW_AVATAR_URL,
      bio: 'bio',
    });

    const userId = await seedFederatedUser(fx, STALE_AGE_MS);
    await federationService.resolveAndUpsert(fx.handle);
    await waitForRow(userId, (row) => row.nameFirst === 'Alice');
    expect(actorSpy).toHaveBeenCalledTimes(1);

    // Second resolve within REFRESH_MIN_INTERVAL_MS must NOT launch another
    // refresh. The row is aged back so staleness ALONE would schedule one —
    // otherwise this would pass for the wrong reason.
    await getDb()
      .update(users)
      .set({ updatedAt: new Date(Date.now() - STALE_AGE_MS) })
      .where(eq(users.id, userId));

    await federationService.resolveAndUpsert(fx.handle);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(actorSpy).toHaveBeenCalledTimes(1);
  });

  it('does the first-time blocking fetch when no cached user exists', async () => {
    const fx = nextFixture();
    webfingerSpy.mockResolvedValue({ actorUri: fx.actorUri, subjectAcct: fx.handle });
    actorSpy.mockResolvedValue({
      actorUri: fx.actorUri,
      domain: fx.domain,
      username: fx.handle,
      displayName: 'Alice',
      avatarUrl: NEW_AVATAR_URL,
      bio: 'bio',
    });

    const result = await federationService.resolveAndUpsert(fx.handle);
    const userId = result?._id ?? '';

    expect(webfingerSpy).toHaveBeenCalledWith(fx.handle);
    expect(actorSpy).toHaveBeenCalledWith(fx.actorUri, fx.handle);
    expect(avatarSpy).toHaveBeenCalledWith(NEW_AVATAR_URL, undefined, undefined, userId);

    const row = await storedUser(userId);
    expect(row).toMatchObject({
      type: 'federated',
      username: fx.handle,
      actorUri: fx.actorUri,
      domain: fx.domain,
      nameFirst: 'Alice',
      bio: 'bio',
      description: 'bio',
      avatar: 'new-file-id',
      unavailableAt: null,
      unavailableReason: null,
    });
    expect(row?.lastResolvedAt).toBeInstanceOf(Date);
    expect(mockCacheInvalidate).toHaveBeenCalledWith(userId);

    // The RETURNED document reflects the avatar the upsert wrote AFTERWARDS.
    // Mongo hand-patched its in-memory copy field by field, which is how a
    // returned document and its row drift apart.
    expect(result?.avatar).toBe('new-file-id');
  });

  it('does not let a WebFinger alias relabel an existing actor URI', async () => {
    const victim = nextFixture('victim.example');
    const attackerHandle = `attacker${actorCounter}@evil.example`;
    const userId = await seedFederatedUser(victim, STALE_AGE_MS);

    // The attacker's server points its self link at an already-cached victim.
    webfingerSpy.mockResolvedValue({
      actorUri: victim.actorUri,
      subjectAcct: attackerHandle,
    });
    actorSpy.mockResolvedValue({
      actorUri: victim.actorUri,
      domain: 'evil.example',
      username: attackerHandle,
      displayName: 'Attacker',
      avatarUrl: undefined,
      bio: undefined,
    });

    const result = await federationService.resolveAndUpsert(attackerHandle);

    expect(result?._id).toBe(userId);
    expect(result?.username).toBe(victim.handle);
    expect(actorSpy).not.toHaveBeenCalled();
    expect(await storedByActorUri(victim.actorUri)).toMatchObject({
      id: userId,
      username: victim.handle,
      domain: victim.domain,
    });
  });

  it('keeps the canonical WebFinger handle when the actor is served from www', async () => {
    actorCounter += 1;
    const handle = `mosseri${actorCounter}@threads.net`;
    const actorUri = `https://www.threads.net/ap/users/mosseri${actorCounter}/`;

    webfingerSpy.mockResolvedValue({ actorUri, subjectAcct: handle });
    actorSpy.mockResolvedValue({
      actorUri,
      domain: 'threads.net',
      username: handle,
      displayName: 'Adam Mosseri',
      avatarUrl: undefined,
      bio: 'Threads profile',
    });

    const result = await federationService.resolveAndUpsert(`@${handle}`);

    expect(webfingerSpy).toHaveBeenCalledWith(handle);
    expect(actorSpy).toHaveBeenCalledWith(actorUri, handle);
    expect(await storedByActorUri(actorUri)).toMatchObject({
      type: 'federated',
      username: handle,
      actorUri,
      domain: 'threads.net',
    });
  });

  it('ignores a WebFinger subject that does not resolve back to the same actor', async () => {
    actorCounter += 1;
    const requestedHandle = `attacker${actorCounter}@evil.example`;
    const spoofedHandle = `victim${actorCounter}@trusted.example`;
    const actorUri = `https://evil.example/users/attacker${actorCounter}`;

    webfingerSpy.mockImplementation(async (acct: string) => {
      if (acct === requestedHandle) {
        return { actorUri, subjectAcct: spoofedHandle };
      }
      if (acct === spoofedHandle) {
        return { actorUri: 'https://trusted.example/users/victim', subjectAcct: spoofedHandle };
      }
      return null;
    });
    actorSpy.mockResolvedValue({
      actorUri,
      domain: 'evil.example',
      username: requestedHandle,
      displayName: 'Evil Attacker',
      avatarUrl: undefined,
      bio: 'not a trusted.example user',
    });

    const result = await federationService.resolveAndUpsert(requestedHandle);

    expect(webfingerSpy).toHaveBeenCalledWith(requestedHandle);
    expect(webfingerSpy).toHaveBeenCalledWith(spoofedHandle);
    expect(actorSpy).toHaveBeenCalledWith(actorUri, requestedHandle);
    // The stored row keeps the REQUESTED identity, never the spoofed subject.
    expect(await storedByActorUri(actorUri)).toMatchObject({
      username: requestedHandle,
      domain: 'evil.example',
    });
  });

  it('uses the WebFinger subject when the requested handle is a www alias', async () => {
    actorCounter += 1;
    const requestedHandle = `mosseri${actorCounter}@www.threads.net`;
    const canonicalHandle = `mosseri${actorCounter}@threads.net`;
    const actorUri = `https://www.threads.net/ap/users/mosseri${actorCounter}/alias`;

    webfingerSpy.mockResolvedValue({ actorUri, subjectAcct: canonicalHandle });
    actorSpy.mockResolvedValue({
      actorUri,
      domain: 'threads.net',
      username: canonicalHandle,
      displayName: 'Adam Mosseri',
      avatarUrl: undefined,
      bio: 'Threads profile',
    });

    const result = await federationService.resolveAndUpsert(`@${requestedHandle}`);

    expect(webfingerSpy).toHaveBeenCalledWith(requestedHandle);
    expect(actorSpy).toHaveBeenCalledWith(actorUri, canonicalHandle);
    expect(await storedByActorUri(actorUri)).toMatchObject({
      type: 'federated',
      username: canonicalHandle,
      actorUri,
      domain: 'threads.net',
    });
  });

  it('finds a cached actor whose stored username differs only by CASE', async () => {
    const fx = nextFixture();
    const userId = await seedFederatedUser(fx, FRESH_AGE_MS, {
      username: fx.handle.toUpperCase(),
    });

    const result = await federationService.resolveAndUpsert(fx.handle);

    // The lookup is written against the expression `users_username_key` is
    // built on (`lower(btrim(username))`). A plain `username = $1` is
    // correct-looking, case-SENSITIVE, and would miss this row — then upsert a
    // duplicate actor beside it.
    expect(result?._id).toBe(userId);
    expect(webfingerSpy).not.toHaveBeenCalled();
  });

  it('never throws out of resolveAndUpsert when the background refresh rejects', async () => {
    const fx = nextFixture();
    webfingerSpy.mockResolvedValue({ actorUri: fx.actorUri, subjectAcct: fx.handle });
    actorSpy.mockRejectedValue(new Error('remote down'));

    const userId = await seedFederatedUser(fx, STALE_AGE_MS);

    const result = await federationService.resolveAndUpsert(fx.handle);
    expect(result?._id).toBe(userId);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockCacheInvalidate).not.toHaveBeenCalled();
    // The cached row survives a failed refresh untouched.
    expect((await storedUser(userId))?.avatar).toBe('stored-file-id');
  });

  it('returns a relabelled identity resolved by bridge handle without clobbering username/domain', async () => {
    actorCounter += 1;
    const bridgeDomain = 'bird.makeup';
    const networkDomain = 'x.com';
    const local = `wired${actorCounter}`;
    const bridgeHandle = `${local}@${bridgeDomain}`;
    const relabelledHandle = `${local}@${networkDomain}`;
    const actorUri = `https://${bridgeDomain}/users/${local}`;

    webfingerSpy.mockResolvedValue({ actorUri, subjectAcct: bridgeHandle });
    actorSpy.mockResolvedValue({
      actorUri,
      domain: bridgeDomain,
      username: bridgeHandle,
      displayName: 'Wired',
      bio: 'bridge bio',
    });

    const userId = await seedFederatedUser(
      { handle: relabelledHandle, actorUri, domain: networkDomain },
      FRESH_AGE_MS,
    );

    const result = await federationService.resolveAndUpsert(bridgeHandle);
    await flushMicrotasks();

    expect(result?._id).toBe(userId);
    expect(result?.username).toBe(relabelledHandle);
    expect(actorSpy).not.toHaveBeenCalled();

    const row = await storedUser(userId);
    expect(row?.username).toBe(relabelledHandle);
    expect(row?.domain).toBe(networkDomain);
  });

  // ----------------------------------------------------------------------
  // Own-domain guard: `<localpart>@oxy.so` is a NON-ENTITY. On Oxy's own apex
  // the only valid identity is the bare local handle (`nate`); the
  // domain-qualified form `@nate@oxy.so` must never resolve and must never be
  // surfaced, so it can't look like a second representation of the local user.
  // Resolution short-circuits to null BEFORE any DB lookup, WebFinger/actor
  // fetch, or upsert.
  // ----------------------------------------------------------------------

  it('returns null for an own-domain handle without any WebFinger or upsert', async () => {
    actorCounter += 1;
    const ownHandle = `nate${actorCounter}@oxy.so`;

    const result = await federationService.resolveAndUpsert(ownHandle);

    expect(result).toBeNull();
    expect(webfingerSpy).not.toHaveBeenCalled();
    expect(actorSpy).not.toHaveBeenCalled();
    // No `type: 'federated'` shadow row was minted for the own-apex handle.
    // Scoped to THIS handle rather than to the whole apex: the throwaway
    // database is shared by the run, so a global absence would be asserting
    // something about other suites.
    const [shadow] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, ownHandle))
      .limit(1);
    expect(shadow).toBeUndefined();
  });

  it('short-circuits an own-domain handle regardless of a leading @ or letter case', async () => {
    const result = await federationService.resolveAndUpsert('@NATE@oxy.so');

    expect(result).toBeNull();
    expect(webfingerSpy).not.toHaveBeenCalled();
    expect(actorSpy).not.toHaveBeenCalled();
  });
});

/**
 * scheduleAvatarRefresh — off-request-path avatar download.
 *
 * The in-memory throttle map (_lastAvatarAttemptAt) is keyed by user id and
 * persists across tests in this process; each test seeds its own row, so its id
 * is unique and cross-test coalescing cannot happen.
 */
describe('FederationService.scheduleAvatarRefresh (off request path)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSafeFetch.mockReset();
    resetAssetMocks();
  });

  it('skips the forced re-download when lastAvatarFetchedAt is within the throttle window', async () => {
    const fx = nextFixture();
    const avatarSpy = jest.spyOn(federationService, 'downloadAndStoreAvatar')
      .mockResolvedValue({ fileId: 'should-not-be-used', notModified: false });

    // Persisted authority: avatar was fetched 1 minute ago — inside the 5min window.
    const userId = await seedFederatedUser(fx, FRESH_AGE_MS, {
      federationLastAvatarFetchedAt: new Date(Date.now() - 60 * 1000),
    });
    const before = await storedUser(userId);

    federationService.scheduleAvatarRefresh(
      userId,
      'https://cdn.example/avatar.png',
      'stored-file-id',
      { force: true },
    );
    await flushMicrotasks();
    await flushMicrotasks();

    // Forced refresh inside the window is a no-op: no download, no write.
    expect(avatarSpy).not.toHaveBeenCalled();
    expect(mockCacheInvalidate).not.toHaveBeenCalled();
    expect(await storedUser(userId)).toEqual(before);

    avatarSpy.mockRestore();
  });

  it('on 304 Not Modified: skips re-upload but advances lastAvatarFetchedAt and invalidates cache', async () => {
    const fx = nextFixture();
    const avatarUrl = 'https://cdn.example/avatar-304.png';

    // No spy on downloadAndStoreAvatar — exercise the REAL conditional-request
    // logic against a mocked safeFetch that returns 304 for a conditional request.
    mockSafeFetch.mockImplementation((_url: string, init?: { headers?: Record<string, string> }) => {
      // The stored validators must be replayed as conditional headers.
      expect(init?.headers?.['If-None-Match']).toBe('"etag-v1"');
      expect(init?.headers?.['If-Modified-Since']).toBe('Wed, 21 Oct 2025 07:28:00 GMT');
      return Promise.resolve(makeSafeFetchResult(304, {}));
    });

    // Stale by time so a forced refresh actually runs, but with stored validators.
    const fetchedAt = new Date(Date.now() - 10 * 60 * 1000); // 10min ago, outside window
    const userId = await seedFederatedUser(fx, STALE_AGE_MS, {
      federationLastAvatarFetchedAt: fetchedAt,
      federationAvatarETag: '"etag-v1"',
      federationAvatarLastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
    });

    federationService.scheduleAvatarRefresh(userId, avatarUrl, 'stored-file-id', { force: true });
    await waitForRow(
      userId,
      (row) => row.lastAvatarFetchedAt !== null && row.lastAvatarFetchedAt > fetchedAt,
    );

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);

    // 304 → the avatar file id is UNCHANGED but the fetch clock advanced.
    const row = await storedUser(userId);
    expect(row?.avatar).toBe('stored-file-id');
    expect(row?.lastAvatarFetchedAt?.getTime()).toBeGreaterThan(fetchedAt.getTime());
    expect(mockCacheInvalidate).toHaveBeenCalledWith(userId);
  });

  it('on 304 Not Modified with a missing local object: retries without validators and repairs the avatar file', async () => {
    const fx = nextFixture();
    const avatarUrl = 'https://cdn.example/avatar-repair.png';
    mockAssetFileContentExists.mockResolvedValue(false);
    mockAssetUploadFileDirect.mockResolvedValue(mockUploadedFile('repaired-file-id'));

    mockSafeFetch
      .mockImplementationOnce((_url: string, init?: { headers?: Record<string, string> }) => {
        expect(init?.headers?.['If-None-Match']).toBe('"etag-v1"');
        expect(init?.headers?.['If-Modified-Since']).toBe('Wed, 21 Oct 2025 07:28:00 GMT');
        return Promise.resolve(makeSafeFetchResult(304, {}));
      })
      .mockImplementationOnce((_url: string, init?: { headers?: Record<string, string> }) => {
        expect(init?.headers?.['If-None-Match']).toBeUndefined();
        expect(init?.headers?.['If-Modified-Since']).toBeUndefined();
        return Promise.resolve(
          makeSafeFetchResult(
            200,
            {
              'content-type': 'image/png',
              etag: '"etag-v2"',
              'last-modified': 'Thu, 22 Oct 2025 07:28:00 GMT',
            },
            Buffer.from('png-bytes'),
          ),
        );
      });

    const userId = await seedFederatedUser(fx, STALE_AGE_MS, {
      federationLastAvatarFetchedAt: new Date(Date.now() - 10 * 60 * 1000),
      federationAvatarETag: '"etag-v1"',
      federationAvatarLastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
    });

    federationService.scheduleAvatarRefresh(userId, avatarUrl, 'stored-file-id', { force: true });
    await waitForRow(userId, (row) => row.avatar === 'repaired-file-id');

    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    expect(mockAssetFileContentExists).toHaveBeenCalledWith('stored-file-id');
    expect(mockAssetUploadFileDirect).toHaveBeenCalledWith(
      userId,
      expect.any(Buffer),
      'image/png',
      expect.stringMatching(/^federated-avatar-[a-f0-9]+\.png$/),
      'public',
      {
        source: 'federation',
        role: 'avatar',
        remoteUrl: avatarUrl,
      },
    );

    expect(await storedUser(userId)).toMatchObject({
      avatar: 'repaired-file-id',
      avatarETag: '"etag-v2"',
      avatarLastModified: 'Thu, 22 Oct 2025 07:28:00 GMT',
    });
    expect(mockCacheInvalidate).toHaveBeenCalledWith(userId);
  });

  it('advances the fetch clock but keeps the avatar when the download fails', async () => {
    const fx = nextFixture();
    const avatarSpy = jest.spyOn(federationService, 'downloadAndStoreAvatar')
      .mockResolvedValue({ fileId: null, notModified: false });

    const fetchedAt = new Date(Date.now() - 10 * 60 * 1000);
    const userId = await seedFederatedUser(fx, STALE_AGE_MS, {
      federationLastAvatarFetchedAt: fetchedAt,
    });

    federationService.scheduleAvatarRefresh(
      userId,
      'https://cdn.example/broken.png',
      'stored-file-id',
      { force: true },
    );
    await waitForRow(
      userId,
      (row) => row.lastAvatarFetchedAt !== null && row.lastAvatarFetchedAt > fetchedAt,
    );

    // The clock advances so a forced refresh cannot hammer a broken remote on
    // every request, and the existing avatar is never clobbered with null.
    const row = await storedUser(userId);
    expect(row?.avatar).toBe('stored-file-id');
    expect(row?.lastAvatarFetchedAt?.getTime()).toBeGreaterThan(fetchedAt.getTime());
    expect(mockCacheInvalidate).toHaveBeenCalledWith(userId);

    avatarSpy.mockRestore();
  });
});

describe('FederationService SSRF guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSafeFetch.mockReset();
    resetAssetMocks();
  });

  it('enforces https-only: an http avatar URL is rejected before reaching safeFetch', async () => {
    const result = await federationService.downloadAndStoreAvatar('http://cdn.example/avatar.png');

    expect(result).toEqual({ fileId: null, notModified: false });
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(mockAssetUploadFileDirect).not.toHaveBeenCalled();
  });

  it('drops an avatar when safeFetch rejects the target as a private/blocked address', async () => {
    mockSafeFetch.mockRejectedValue(new FakeSsrfRejection('hostname resolves to blocked range'));

    const result = await federationService.downloadAndStoreAvatar('https://private.example/avatar.png');

    expect(result).toEqual({ fileId: null, notModified: false });
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockAssetUploadFileDirect).not.toHaveBeenCalled();
  });

  it('returns null from WebFinger when safeFetch rejects the resource host as private', async () => {
    mockSafeFetch.mockRejectedValue(new FakeSsrfRejection('literal ip in blocked range'));

    await expect(federationService.resolveWebFingerResource('alice@trusted.example')).resolves.toBeNull();

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockAssetUploadFileDirect).not.toHaveBeenCalled();
  });

  it('rejects oversized avatars via the content-length pre-check before buffering or upload', async () => {
    mockSafeFetch.mockResolvedValue(
      makeSafeFetchResult(
        200,
        {
          'content-type': 'image/png',
          'content-length': String(6 * 1024 * 1024),
        },
        Buffer.alloc(64),
      ),
    );

    const result = await federationService.downloadAndStoreAvatar('https://cdn.example/huge.png');

    expect(result).toEqual({ fileId: null, etag: undefined, lastModified: undefined, notModified: false });
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockAssetUploadFileDirect).not.toHaveBeenCalled();
  });

  it('rejects avatars whose streamed body exceeds the byte cap even without content-length', async () => {
    mockSafeFetch.mockResolvedValue(
      makeSafeFetchResult(
        200,
        { 'content-type': 'image/png' },
        Buffer.alloc(6 * 1024 * 1024),
      ),
    );

    const result = await federationService.downloadAndStoreAvatar('https://cdn.example/streamed-huge.png');

    expect(result).toEqual({ fileId: null, etag: undefined, lastModified: undefined, notModified: false });
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockAssetUploadFileDirect).not.toHaveBeenCalled();
  });
});

describe('isOwnFederationDomain', () => {
  it('accepts the apex domain case-insensitively', () => {
    expect(isOwnFederationDomain('oxy.so')).toBe(true);
    expect(isOwnFederationDomain('OXY.SO')).toBe(true);
  });

  it('accepts a leading www. alias of the apex domain', () => {
    expect(isOwnFederationDomain('www.oxy.so')).toBe(true);
    expect(isOwnFederationDomain('WWW.OXY.SO')).toBe(true);
  });

  it('rejects unrelated domains', () => {
    expect(isOwnFederationDomain('mastodon.social')).toBe(false);
    expect(isOwnFederationDomain('www.mastodon.social')).toBe(false);
  });
});
