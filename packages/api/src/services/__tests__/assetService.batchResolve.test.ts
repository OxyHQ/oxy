/**
 * AssetService batch resolution, against a REAL Postgres.
 *
 * Two guarantees, and the migration changed WHERE each one is enforced:
 *
 * 1. **A malformed id cannot fail the batch.** It used to be able to: a
 *    non-ObjectId string reached `File.find` and threw a `CastError`, turning
 *    the whole batch into an HTTP 500, so the resolver filtered ids by shape
 *    first. `files.id` is `text`; an id of any shape is a value that matches no
 *    row. The filter is deleted and the leniency is now structural — the test
 *    passes real garbage and checks it is simply absent.
 *
 * 2. **One hash resolves to ONE id, stably.** Callers map `sha256 -> fileId`
 *    (Mention's MTN materializer, node-blob sync) and that mapping must not move
 *    between calls. `files_sha256_live_key` — unique on `sha256` among
 *    `active`/`trash` rows — is what makes it true, so the test checks the
 *    CONSTRAINT rather than a collapse branch the constraint makes unreachable.
 */

import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files, users } from '../../db/schema';
import type { S3Service } from '../s3Service';
import { AssetService } from '../assetService';
import { isUniqueViolation } from '../fileRepository';
import fileCache from '../../utils/fileCache';

const service = new AssetService({} as unknown as S3Service);

/**
 * A globally unique 64-hex content hash. Jest runs suites in PARALLEL against
 * ONE throwaway database and `files_sha256_live_key` spans the whole table, so a
 * per-file counter would collide with another suite's fixture rows.
 */
const sha = () => randomBytes(32).toString('hex');

async function insertUser(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal' })
    .returning({ id: users.id });
  return row.id;
}

async function insertFile(
  values: Partial<typeof files.$inferInsert> & { sha256: string; ownerUserId: string }
): Promise<string> {
  const [row] = await getDb()
    .insert(files)
    .values({
      size: 1024,
      mime: 'image/png',
      ext: 'png',
      storageKey: `content/${values.sha256}.png`,
      ...values,
    })
    .returning({ id: files.id });
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(() => {
  fileCache.clear();
});

afterAll(async () => {
  await closePostgres();
});

describe('getFilesByIds is lenient about ids it cannot resolve', () => {
  it('resolves the ids that exist and silently omits the rest', async () => {
    const ownerId = await insertUser();
    const fileId = await insertFile({ sha256: sha(), ownerUserId: ownerId });

    const result = await service.getFilesByIds([fileId, 'not-an-object-id', '']);

    expect(result.map((f) => f.id)).toEqual([fileId]);
  });

  it('returns [] rather than throwing when NO id resolves', async () => {
    // The whole point of the deleted shape filter: none of these can be cast to
    // anything, and none of them can make the query fail.
    await expect(service.getFilesByIds(['nope', '123', 'xyz'])).resolves.toEqual([]);
  });

  it('short-circuits an empty batch', async () => {
    await expect(service.getFilesByIds([])).resolves.toEqual([]);
  });

  it('carries each file\'s links and variants — a file is never returned bare', async () => {
    // `links.length` IS the usage count and decides whether an unlinked file
    // falls to `trash`, so a batch read that dropped the children would report
    // every file as unused.
    const ownerId = await insertUser();
    const fileId = await insertFile({ sha256: sha(), ownerUserId: ownerId });

    const [record] = await service.getFilesByIds([fileId]);

    expect(record.links).toEqual([]);
    expect(record.variants).toEqual([]);
  });
});

describe('findActiveFilesBySha256 — one live record per hash', () => {
  it('the database refuses a second LIVE row for the same content hash', async () => {
    const contentHash = sha();
    const first = await insertUser();
    const second = await insertUser();
    await insertFile({ sha256: contentHash, ownerUserId: first });

    // This is the guarantee the `sha256 -> fileId` mapping rests on. Under
    // Mongo it was a boot-time index reconciliation that could be absent;
    // `files_sha256_live_key` is created by a migration and cannot be.
    const error = await insertFile({ sha256: contentHash, ownerUserId: second }).then(
      () => null,
      (thrown: unknown) => thrown
    );
    expect(error).not.toBeNull();

    // And the rejection must be RECOGNISABLE as a unique violation, because the
    // dedup race path branches on it. Drizzle wraps the driver error — the
    // postgres.js error with `code: '23505'` is the `cause` — so a predicate
    // reading `error.code` off the thrown value sees `undefined` and every
    // concurrent duplicate upload becomes a 500 instead of resolving to the
    // winner. Asserting through the real predicate is what pins that.
    expect(isUniqueViolation(error)).toBe(true);
  });

  it('resolves a hash to its live row while a tombstone for the same content exists', async () => {
    const contentHash = sha();
    const ownerId = await insertUser();
    // A tombstone does NOT hold a claim on its hash (the unique index covers
    // only `active`/`trash`), so the same content can live again — and the
    // resolver must answer with the LIVE row, never the tombstone.
    await insertFile({ sha256: contentHash, ownerUserId: ownerId, status: 'deleted' });
    const liveId = await insertFile({ sha256: contentHash, ownerUserId: ownerId });

    const result = await service.findActiveFilesBySha256([contentHash]);

    expect(result.map((f) => f.id)).toEqual([liveId]);
  });

  it('returns the SAME id across repeated calls', async () => {
    const contentHash = sha();
    const ownerId = await insertUser();
    const fileId = await insertFile({ sha256: contentHash, ownerUserId: ownerId });

    const first = await service.findActiveFilesBySha256([contentHash]);
    const second = await service.findActiveFilesBySha256([contentHash]);

    expect(first[0].id).toBe(fileId);
    expect(second[0].id).toBe(first[0].id);
  });

  it('resolves multiple hashes independently, one record each', async () => {
    const shaA = sha();
    const shaB = sha();
    const ownerId = await insertUser();
    const idA = await insertFile({ sha256: shaA, ownerUserId: ownerId });
    const idB = await insertFile({ sha256: shaB, ownerUserId: ownerId });

    const result = await service.findActiveFilesBySha256([shaA, shaB]);

    expect(result.map((f) => f.id).sort()).toEqual([idA, idB].sort());
  });

  it('omits a hash whose only record is a tombstone', async () => {
    const contentHash = sha();
    const ownerId = await insertUser();
    await insertFile({ sha256: contentHash, ownerUserId: ownerId, status: 'deleted' });

    await expect(service.findActiveFilesBySha256([contentHash])).resolves.toEqual([]);
  });

  it('short-circuits empty input', async () => {
    await expect(service.findActiveFilesBySha256([])).resolves.toEqual([]);
  });
});

describe('listFilesByUser', () => {
  it('pages one account\'s own live files, newest first, with a total', async () => {
    const ownerId = await insertUser();
    const other = await insertUser();
    await insertFile({ sha256: sha(), ownerUserId: ownerId });
    await insertFile({ sha256: sha(), ownerUserId: ownerId });
    await insertFile({ sha256: sha(), ownerUserId: ownerId, status: 'deleted' });
    await insertFile({ sha256: sha(), ownerUserId: other });

    const page = await service.listFilesByUser(ownerId, 1, 0);

    expect(page.total).toBe(2);
    expect(page.files).toHaveLength(1);
    expect(page.files[0].ownerUserId).toBe(ownerId);

    // The deleted row is excluded from both the page and the count.
    const owned = await getDb()
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.ownerUserId, ownerId), eq(files.status, 'deleted')));
    expect(owned).toHaveLength(1);
  });
});
