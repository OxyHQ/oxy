/**
 * The cleanup of an unfinished upload or import never deletes an object a live
 * row uses (`deleteObjectsNoLiveRowUses`), against a REAL Postgres:
 *
 *  1. A key a live row's original or rendition names is kept, in its own
 *     spelling; a tombstone keeps nothing.
 *  2. THE RACE that left `active` rows with no object: the cleanup's "does a
 *     live row name it?" ran OUTSIDE the content-hash lock, so it could not
 *     see the insert of the row that was about to name the key, and deleted
 *     its object. Under the lock it waits for that insert and keeps the object.
 *  3. Every other path that deletes stored bytes is one this file names
 *     (a census of `deleteFile(` / `deleteObject(` call sites).
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { inArray } from 'drizzle-orm';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { fileVariants, files, users } from '../../db/schema';
import { deleteObjectsNoLiveRowUses } from '../accountStorageDeletion.worker';
import { withContentHashLock } from '../contentHashLock';

jest.setTimeout(60_000);

class Bucket {
  readonly deleted: string[] = [];
  async deleteObject(key: string): Promise<void> {
    this.deleted.push(key);
  }
}

const sha = () => randomBytes(32).toString('hex');
const keyFor = (hash: string) => `content/2026/10/${hash.slice(0, 2)}/${hash}-abc.png`;

async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

function row(hash: string, ownerUserId: string, storageKey: string) {
  return {
    sha256: hash,
    size: 3,
    mime: 'image/png',
    ext: '.png',
    ownerUserId,
    visibility: 'private' as const,
    storageKey,
  };
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('deleteObjectsNoLiveRowUses', () => {
  it('keeps what a live row names, in that spelling only, and deletes the rest', async () => {
    const hash = sha();
    const key = keyFor(hash);
    const person = await owner();
    const [live] = await getDb()
      .insert(files)
      .values(row(hash, person, key))
      .returning();
    const rendition = `variants/2026/10/${hash.slice(0, 2)}/${hash}/w320.webp`;
    await getDb().insert(fileVariants).values({ fileId: live.id, type: 'w320', key: rendition });

    const bucket = new Bucket();
    const result = await deleteObjectsNoLiveRowUses(
      hash,
      [key, `public/${key}`, rendition, `${key}.staging`],
      bucket,
    );

    expect(result.kept.sort()).toEqual([key, rendition].sort());
    expect(bucket.deleted.sort()).toEqual([`public/${key}`, `${key}.staging`].sort());
  });

  it('keeps nothing for a tombstone', async () => {
    const hash = sha();
    const key = keyFor(hash);
    await getDb()
      .insert(files)
      .values({ ...row(hash, await owner(), key), status: 'deleted' });
    const bucket = new Bucket();
    await deleteObjectsNoLiveRowUses(hash, [key], bucket);
    expect(bucket.deleted).toEqual([key]);
  });

  it('waits for an insert that is naming the key and keeps its object (the race)', async () => {
    const hash = sha();
    const key = keyFor(hash);
    const person = await owner();
    const bucket = new Bucket();

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted: () => void = () => undefined;
    const insertedSignal = new Promise<void>((resolve) => {
      inserted = resolve;
    });

    // An upload's finalize: under the lock, insert the row naming `key`, and
    // commit only later.
    const finalize = withContentHashLock(hash, async (tx) => {
      await tx.insert(files).values(row(hash, person, key));
      inserted();
      await held;
    });
    await insertedSignal;

    // What the cleanup used to do: read outside the lock. It cannot see the
    // row yet, so it would have deleted the object.
    const seen = await getDb()
      .select({ id: files.id })
      .from(files)
      .where(inArray(files.storageKey, [key]));
    expect(seen).toHaveLength(0);

    const cleanup = deleteObjectsNoLiveRowUses(hash, [key], bucket);
    // Still waiting on the lock: nothing deleted while the insert is open.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(bucket.deleted).toEqual([]);

    release();
    await finalize;
    const result = await cleanup;
    expect(result).toEqual({ deleted: [], kept: [key] });
    expect(bucket.deleted).toEqual([]);
  });
});

/**
 * Every place that deletes stored bytes directly. Each is either the guarded
 * path (the ledger worker, `deleteObjectsNoLiveRowUses` and the stores handed
 * to it) or a key no live row can name: a uuid temp key, a staging key whose
 * bytes never verified, an admission key with a random suffix whose row never
 * committed. A new direct delete must be added here, with that argument.
 */
const DIRECT_DELETES: Record<string, number> = {
  // The ledger worker's store, and its guarded deletes (prefix, object, the guard).
  'services/accountStorageDeletion.worker.ts': 4,
  // The guarded store for a large upload's leftovers; an admitted stream's own
  // uuid key whose row never committed; a stream's uuid temp key.
  'services/assetService.ts': 4,
  // The guarded store for a failed session; an SVG's unsanitized upload (its
  // row, if any, names the sanitized key).
  'services/fileUploadSession.service.ts': 2,
  // A fetch that never completed; an empty recording; the guarded store, and
  // an unverified ingest's keys (no row can name them).
  'services/fileIngest.service.ts': 4,
  // An admitted rendition's own random-suffixed key whose row never committed.
  'services/variantService.ts': 2,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('the census of direct storage deletes', () => {
  it('names every call site', () => {
    const root = join(__dirname, '..', '..');
    const found: Record<string, number> = {};
    for (const path of sourceFiles(join(root, 'services'))) {
      const source = readFileSync(path, 'utf8');
      // The object store's delete — not `assetService.deleteFile`, which
      // tombstones a row and owes its purge to the ledger.
      const count = (source.match(/(?:s3Service|s3)\.deleteFile\(|\.deleteObject\(/g) ?? []).length;
      // `s3Service.ts` defines `deleteFile`; it is not a caller.
      if (count > 0 && !path.endsWith('s3Service.ts')) found[relative(root, path)] = count;
    }
    expect(found).toEqual(DIRECT_DELETES);
  });
});
