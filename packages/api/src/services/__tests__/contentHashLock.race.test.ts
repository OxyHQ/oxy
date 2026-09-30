/**
 * The tombstone → purge race, against a REAL Postgres.
 *
 * Deleting an asset tombstones its row and removes the objects afterwards. A
 * fresh upload of the same bytes in that gap — by anyone: rows are per owner,
 * storage is shared — takes the SAME content-addressed keys; if the purge then
 * deletes them, the new upload is a permanent 404.
 *
 * The purge re-checks for a live row and deletes only under the content-hash
 * advisory lock; every path creating a new live row takes the same lock around
 * its insert (and, for the streamed path, around the object write too).
 *
 * `Promise.all` would not force the interleaving (`~/Oxy/docs/postgres-and-drizzle.md`),
 * so each case holds one side at a gate, PROVES the other side is blocked on the
 * lock by polling `pg_locks` for THIS hash's key (and throws if it never blocks),
 * then releases. Every wait is bounded and names what it waited for; afterEach
 * releases any gate a failed test left shut.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'stream';
import { and, eq, ne, sql } from 'drizzle-orm';

jest.mock('../variantService', () => ({
  VariantService: class {
    constructor(_s3: unknown) { /* no-op */ }
    generateVariants = jest.fn(() => Promise.resolve());
  },
}));

jest.mock('../../queue/assetVariants.queue', () => ({
  enqueueAssetVariantGeneration: jest.fn(() => Promise.resolve()),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files, fileVariants, storageObjectDeletions, users } from '../../db/schema';
import { AssetService } from '../assetService';
import type { S3Service } from '../s3Service';
import type { FileInfo } from '../../types/s3.types';
import { runStorageDeletionBatch, type StorageDeletionStore } from '../accountStorageDeletion.worker';
import { CONTENT_HASH_LOCK_NAMESPACE, withContentHashLock } from '../contentHashLock';
import fileCache from '../../utils/fileCache';

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(24)]);
const hashOf = (content: Buffer) => createHash('sha256').update(content).digest('hex');

/**
 * Every wait in this file is BOUNDED and says what it was waiting for. A step
 * that never comes (a purge that claimed nothing, a contender that never
 * blocked) fails fast with its reason instead of burning the jest timeout —
 * which is how this file used to fail in CI: a purge that claimed nothing never
 * reached its S3 delete, and the test waited for it until jest gave up.
 */
const STEP_TIMEOUT_MS = 5000;

/** Gates and in-flight work a test started, released and settled in afterEach even if it failed midway. */
const openGates: Array<() => void> = [];
const inFlight: Array<Promise<unknown>> = [];

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  openGates.push(open);
  return { opened, open };
}

function track<T>(work: Promise<T>): Promise<T> {
  inFlight.push(work.catch(() => undefined));
  return work;
}

/**
 * Resolve once `signal` fires. Throw if `other` settles first (the side we are
 * waiting on finished WITHOUT reaching the point — its result is in the
 * message), or after {@link STEP_TIMEOUT_MS}.
 */
async function reach(signal: Promise<void>, other: Promise<unknown>, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    signal.then(() => ({ kind: 'reached' as const })),
    other.then(
      (value) => ({ kind: 'settled' as const, detail: JSON.stringify(value) }),
      (error: unknown) => ({ kind: 'settled' as const, detail: error instanceof Error ? error.message : String(error) }),
    ),
    new Promise<{ kind: 'timeout' }>((resolve) => { timer = setTimeout(() => resolve({ kind: 'timeout' }), STEP_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);
  if (outcome.kind === 'settled') throw new Error(`${what}: the other side finished first (${outcome.detail})`);
  if (outcome.kind === 'timeout') throw new Error(`${what}: not reached within ${STEP_TIMEOUT_MS}ms`);
}

/**
 * Wait until a session waits on THIS hash's advisory lock — the exact key, in
 * this database, so no other lock can satisfy it. Throws if `contender` settles
 * first (it never blocked) or if nothing blocks within the bound.
 */
async function waitForLockWaiter(sha256: string, contender: Promise<unknown>, what: string): Promise<void> {
  let settled: string | null = null;
  void contender.then(
    (value) => { settled = `resolved ${JSON.stringify(value)}`; },
    (error: unknown) => { settled = `rejected ${error instanceof Error ? error.message : String(error)}`; },
  );
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [row] = await getDb().execute<{ n: number }>(sql`
      select count(*)::int as n from pg_locks
      where locktype = 'advisory' and not granted
        and database = (select oid from pg_database where datname = current_database())
        and ((classid::bigint << 32) | objid::bigint)
          = hashtextextended(${CONTENT_HASH_LOCK_NAMESPACE + sha256}, 0)`);
    if ((row as { n: number } | undefined)?.n) return;
    if (settled !== null) throw new Error(`precondition failed (${what}): it never blocked on the lock — ${settled}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`precondition failed (${what}): nothing waited on this hash's lock within ${STEP_TIMEOUT_MS}ms`);
}

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function oweObject(sha256: string, target: string): Promise<string> {
  const [row] = await getDb()
    .insert(storageObjectDeletions)
    .values({ reason: 'file.deleted', accountId: `race-${randomBytes(4).toString('hex')}`, kind: 'object', target, sha256 })
    .returning({ id: storageObjectDeletions.id });
  return row.id;
}

async function liveRowsFor(sha256: string) {
  return getDb().select({ id: files.id }).from(files).where(and(eq(files.sha256, sha256), ne(files.status, 'deleted')));
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  // A failed test must not leave a transaction holding a lock (or a pool
  // connection) for the next one: open every gate, then settle what is left.
  for (const open of openGates.splice(0)) open();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(inFlight.splice(0)),
    new Promise((resolve) => { timer = setTimeout(resolve, STEP_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);
  fileCache.clear();
});

afterAll(async () => {
  await closePostgres();
});

describe('the purge honours the lock and re-checks under it', () => {
  it('keeps the bytes of a live row that an upload committed while the purge waited', async () => {
    const sha256 = randomBytes(32).toString('hex');
    const target = `content/2026/09/${sha256}.png`;
    const ledgerId = await oweObject(sha256, target);
    const owner = await insertUser();
    const release = gate();
    const locked = gate();

    // An upload in flight: it holds the lock, and commits a live row on the
    // same key before letting go.
    const upload = track(withContentHashLock(sha256, async (tx) => {
      locked.open();
      await release.opened;
      await tx.insert(files).values({
        sha256, size: 1, mime: 'image/png', ext: 'png', storageKey: target, ownerUserId: owner, status: 'active',
      });
    }));
    await reach(locked.opened, upload, 'the upload took the lock');

    const deleteObject = jest.fn((_key: string): Promise<void> => Promise.resolve());
    const store: StorageDeletionStore = { deleteObject, listKeys: async () => [] };
    const purge = track(runStorageDeletionBatch({ ownerId: 'race', ids: [ledgerId], store }));

    await waitForLockWaiter(sha256, purge, 'the purge');
    expect(deleteObject).not.toHaveBeenCalled();

    release.open();
    await upload;
    const result = await purge;

    expect(result).toMatchObject({ claimed: 1, retainedShared: 1, deleted: 0 });
    // The key the new (private) row uses is kept; only the CDN spelling nobody
    // uses goes.
    expect(deleteObject).not.toHaveBeenCalledWith(target);
    expect(deleteObject.mock.calls).toEqual([[`public/${target}`]]);
  });
});

describe('every path that creates a live row waits for a purge in progress', () => {
  /**
   * Start a purge of `sha256` that blocks INSIDE its S3 delete (holding the
   * lock) until released. Returns the gate and the purge promise.
   */
  async function purgeBlockedInDelete(sha256: string) {
    const ledgerId = await oweObject(sha256, `content/2026/09/${sha256}.png`);
    const inDelete = gate();
    const release = gate();
    const events: string[] = [];
    const store: StorageDeletionStore = {
      deleteObject: async (key) => {
        inDelete.open();
        await release.opened;
        events.push(`purge-deleted:${key}`);
      },
      listKeys: async () => [],
    };
    const purge = track(runStorageDeletionBatch({ ownerId: 'race', ids: [ledgerId], store }));
    await reach(inDelete.opened, purge, 'the purge reached its S3 delete');
    return { release, purge, events };
  }

  function fakeS3(events: string[]) {
    return {
      uploadStream: jest.fn(async (key: string, body: Readable): Promise<FileInfo> => {
        for await (const _chunk of body) { /* drain */ }
        return { key, size: 1, contentType: 'image/png' } as FileInfo;
      }),
      uploadBuffer: jest.fn(async (key: string): Promise<FileInfo> => {
        events.push(`upload-wrote:${key}`);
        return { key, size: 1, contentType: 'image/png' } as FileInfo;
      }),
      copyFile: jest.fn(async (_from: string, to: string) => {
        events.push(`upload-wrote:${to}`);
      }),
      deleteFile: jest.fn(async () => undefined),
      // The purge under way is removing the only copy: nothing is stored, so
      // the upload must write its bytes — after the purge.
      fileExists: jest.fn(async () => false),
      getPresignedUploadUrl: jest.fn(async () => 'https://signed.example/put'),
      listFiles: jest.fn(async () => []),
    };
  }

  it('the streamed upload writes its object only after the purge finished', async () => {
    const content = png();
    const sha256 = hashOf(content);
    const { release, purge, events } = await purgeBlockedInDelete(sha256);
    const s3 = fakeS3(events);
    const service = new AssetService(s3 as unknown as S3Service);

    const source = new Readable({ read() { this.push(content); this.push(null); } });
    const upload = track(service.uploadCachedMediaStream(source, 'image/png', 'x.png', 1_000_000));

    await waitForLockWaiter(sha256, upload, 'the streamed upload');
    expect(s3.copyFile).not.toHaveBeenCalled();

    release.open();
    await purge;
    const file = await upload;

    // Every purge delete happened BEFORE the upload wrote the object.
    const firstWrite = events.findIndex((e) => e.startsWith('upload-wrote:'));
    const lastPurge = events.map((e) => e.startsWith('purge-deleted:')).lastIndexOf(true);
    expect(lastPurge).toBeGreaterThanOrEqual(0);
    expect(firstWrite).toBeGreaterThan(lastPurge);
    expect((await liveRowsFor(sha256)).map((r) => r.id)).toEqual([file.id]);
  });

  it('the direct upload inserts its row only after the purge finished', async () => {
    const content = png();
    const sha256 = hashOf(content);
    const { release, purge, events } = await purgeBlockedInDelete(sha256);
    const s3 = fakeS3(events);
    const service = new AssetService(s3 as unknown as S3Service);

    const upload = track(service.uploadFileDirect(await insertUser(), content, 'image/png', 'x.png', 'public'));

    await waitForLockWaiter(sha256, upload, 'the direct upload');
    expect(await liveRowsFor(sha256)).toEqual([]);
    expect(s3.uploadBuffer).not.toHaveBeenCalled();

    release.open();
    await purge;
    const file = await upload;

    const firstWrite = events.findIndex((e) => e.startsWith('upload-wrote:'));
    const lastPurge = events.map((e) => e.startsWith('purge-deleted:')).lastIndexOf(true);
    expect(firstWrite).toBeGreaterThan(lastPurge);
    expect((await liveRowsFor(sha256)).map((r) => r.id)).toEqual([file.id]);
  });

  it('initUpload inserts its row only after the purge finished', async () => {
    const sha256 = randomBytes(32).toString('hex');
    const { release, purge, events } = await purgeBlockedInDelete(sha256);
    const service = new AssetService(fakeS3(events) as unknown as S3Service);

    const init = track(service.initUpload(await insertUser(), sha256, 10, 'image/png'));

    await waitForLockWaiter(sha256, init, 'initUpload');
    expect(await liveRowsFor(sha256)).toEqual([]);

    release.open();
    await purge;
    const { fileId } = await init;
    expect((await liveRowsFor(sha256)).map((r) => r.id)).toEqual([fileId]);
  });
});

describe('deleteFile', () => {
  it('owes nothing for a row that is already deleted — its keys may belong to a newer live row', async () => {
    const sha256 = randomBytes(32).toString('hex');
    const owner = await insertUser();
    const [tombstone] = await getDb().insert(files).values({
      sha256, size: 1, mime: 'image/png', ext: 'png', storageKey: `public/content/${sha256}.png`, ownerUserId: owner, status: 'deleted',
    }).returning({ id: files.id });
    const [live] = await getDb().insert(files).values({
      sha256, size: 1, mime: 'image/png', ext: 'png', storageKey: `public/content/${sha256}.png`, ownerUserId: owner, status: 'active',
    }).returning({ id: files.id });
    const s3 = { deleteFile: jest.fn(async () => undefined), listFiles: jest.fn(async () => []) };
    const service = new AssetService(s3 as unknown as S3Service);

    await service.deleteFile(tombstone.id, true);

    expect(s3.deleteFile).not.toHaveBeenCalled();
    expect(await getDb().select().from(storageObjectDeletions).where(eq(storageObjectDeletions.sha256, sha256))).toEqual([]);
    expect((await liveRowsFor(sha256)).map((r) => r.id)).toEqual([live.id]);
  });

  it('records what it owes in the tombstone commit and purges it', async () => {
    const sha256 = randomBytes(32).toString('hex');
    const owner = await insertUser();
    const [row] = await getDb().insert(files).values({
      sha256, size: 1, mime: 'image/png', ext: 'png', storageKey: `public/content/${sha256}.png`, ownerUserId: owner, status: 'active',
    }).returning({ id: files.id });
    const s3 = { deleteFile: jest.fn(async () => undefined), listFiles: jest.fn(async () => []) };
    const service = new AssetService(s3 as unknown as S3Service);

    await service.deleteFile(row.id, true);

    const ledger = await getDb().select().from(storageObjectDeletions).where(eq(storageObjectDeletions.sha256, sha256));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ reason: 'file.deleted', kind: 'object', target: `content/${sha256}.png`, outcome: 'deleted' });
    expect(s3.deleteFile).toHaveBeenCalledWith(`public/content/${sha256}.png`);
  });
});

describe('deleteCachedMedia', () => {
  it('owes the whole variant directory, so a cached video’s HLS segments go too', async () => {
    const sha256 = randomBytes(32).toString('hex');
    const variantDir = `variants/2026/09/${sha256.slice(0, 2)}/${sha256}/`;
    const [row] = await getDb().insert(files).values({
      sha256, size: 1, mime: 'video/mp4', ext: 'mp4', storageKey: `public/content/${sha256}.mp4`,
      systemOwner: '__federation_media_cache__', purpose: 'federation-media-cache', status: 'active', visibility: 'public',
    }).returning({ id: files.id });
    await getDb().insert(fileVariants).values({ fileId: row.id, type: 'hls_720p', key: `public/${variantDir}hls_720p.m3u8`, readyAt: new Date() });
    const segment = `public/${variantDir}hls_720p_segment_720p_000.ts.ts`;
    const s3 = {
      deleteFile: jest.fn(async () => undefined),
      listFiles: jest.fn(async (prefix: string) =>
        prefix === `public/${variantDir}` && !s3.deleteFile.mock.calls.some(([k]) => k === segment)
          ? [{ key: segment, size: 1, lastModified: new Date(), bucket: 'b' }]
          : []),
    };
    const service = new AssetService(s3 as unknown as S3Service);

    expect(await service.deleteCachedMedia(row.id)).toEqual({ deleted: true, outOfScope: false });

    const ledger = await getDb().select().from(storageObjectDeletions).where(eq(storageObjectDeletions.sha256, sha256));
    expect(ledger.map((r) => [r.kind, r.target]).sort()).toEqual([
      ['object', `content/${sha256}.mp4`],
      ['prefix', variantDir],
    ]);
    expect(s3.deleteFile).toHaveBeenCalledWith(segment);
  });
});
