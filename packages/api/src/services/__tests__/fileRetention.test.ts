/**
 * The file retention pass (`fileRetention.service.ts`) against a REAL Postgres
 * and the REAL `S3Service` over an in-memory bucket:
 *
 *  - selection: a tombstone's rendition and source rows are due, unless an
 *    open claim holds its bytes; an active image nobody has used for the
 *    cutoff loses every ladder rendition row but one per directory; a recent,
 *    a referenced (even with a stale `unreferenced_since`), a video's and a
 *    platform namespace's renditions are never selected;
 *  - a dry run changes nothing, and reports the counts and bytes an apply then
 *    removes;
 *  - an apply owes each tombstone's directories a delete before its rows go,
 *    keeps every storage object of an unused image, and a second apply finds
 *    nothing (idempotent);
 *  - the federation-cache expiry runs only when named, tombstones and purges
 *    only an old, unheld cache entry, and never an account's file;
 *  - a bounded run resumes from its `lastFileId`; it stops outside the off-peak
 *    window and after consecutive slow batches; an apply needs its confirmation.
 *
 * The test database is shared with other files in this worker, so each case
 * scans only the rows it creates (`after` = the newest id before it started).
 */

import { randomBytes } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';

jest.mock('../variantService', () => ({
  VariantService: class {
    generateVariants = jest.fn(() => Promise.resolve());
  },
}));

jest.mock('../../queue/assetVariants.queue', () => ({
  enqueueAssetVariantGeneration: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../cdnInvalidation', () => ({
  ...jest.requireActual('../cdnInvalidation'),
  getCdnInvalidationQueue: () => ({
    enqueueDeletedKey: () => undefined,
    enqueuePath: () => undefined,
  }),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  applications,
  contentClaims,
  contentClaimTargets,
  fileSources,
  fileVariants,
  files,
  storageObjectDeletions,
  users,
} from '../../db/schema';
import { AssetService } from '../assetService';
import { addFileReferences, insertFile, type NewFile } from '../fileRepository';
import {
  FILE_RETENTION_CONFIRMATION,
  type FileRetentionOptions,
  type FileRetentionRecord,
  REGENERABLE_IMAGE_VARIANT_TYPES,
  runFileRetention,
} from '../fileRetention.service';
import { S3Service } from '../s3Service';

jest.setTimeout(60_000);

const DAY = 24 * 60 * 60 * 1000;
/** 03:00 UTC: inside the default off-peak window. */
const NOW = new Date('2026-11-28T03:00:00.000Z');

/** An in-memory bucket behind the real `S3Service`. */
class MemoryBucket {
  readonly objects = new Map<string, Buffer>();

  async send(command: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }): Promise<unknown> {
    const input = command.input;
    const key = String(input.Key ?? '');
    switch (command.constructor.name) {
      case 'HeadObjectCommand':
        if (!this.objects.has(key))
          throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
        return { ContentLength: this.objects.get(key)?.length };
      case 'PutObjectCommand':
        this.objects.set(key, Buffer.isBuffer(input.Body) ? input.Body : Buffer.alloc(0));
        return {};
      case 'DeleteObjectCommand':
        this.objects.delete(key);
        return {};
      case 'ListObjectsV2Command': {
        const prefix = String(input.Prefix ?? '');
        return {
          Contents: [...this.objects.keys()]
            .filter((k) => k.startsWith(prefix))
            .map((k) => ({ Key: k, Size: this.objects.get(k)?.length ?? 0 })),
        };
      }
      default:
        throw new Error(`MemoryBucket: unexpected ${command.constructor.name}`);
    }
  }
}

function harness() {
  const bucket = new MemoryBucket();
  const s3 = new S3Service(
    { accessKeyId: 'test', secretAccessKey: 'test', bucketName: 'media', region: 'us-east-1' },
    { enqueueDeletedKey: () => undefined },
  );
  const client: unknown = Reflect.get(s3, 's3Client');
  if (typeof client !== 'object' || client === null) throw new Error('S3Service has no client');
  Reflect.set(client, 'send', (command: Parameters<MemoryBucket['send']>[0]) =>
    bucket.send(command),
  );
  const service = new AssetService(s3);
  return {
    bucket,
    actions: {
      expireFederationCacheEntry: (id: string, cutoff: Date) =>
        service.expireFederationCacheEntry(id, cutoff),
    },
  };
}

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function application(): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `app-${randomBytes(4).toString('hex')}`,
      ownerAccountId: await account(),
      type: 'first_party',
    })
    .returning({ id: applications.id });
  return row.id;
}

type Owner = Pick<NewFile, 'ownerUserId' | 'ownerApplicationId' | 'systemOwner'>;

/** A file through `insertFile`, its original object in `bucket`. */
async function stored(owner: Owner, values: Partial<NewFile> = {}, bucket?: MemoryBucket) {
  const sha256 = randomBytes(32).toString('hex');
  const visibility = values.visibility ?? 'private';
  const storageKey = `${visibility === 'public' ? 'public/' : ''}content/2026/10/${sha256.slice(0, 2)}/${sha256}.png`;
  const file = await insertFile({
    sha256,
    size: 1000,
    mime: 'image/png',
    ext: '.png',
    status: 'active',
    storageKey,
    originalName: 'photo.png',
    metadata: {},
    ...owner,
    ...values,
    visibility,
  });
  bucket?.objects.set(file.storageKey, Buffer.from('png-bytes'));
  return file;
}

const rootOf = (sha256: string) => `variants/2026/10/${sha256.slice(0, 2)}/${sha256}/`;

/** The whole image ladder, one directory, 100 bytes each; objects in `bucket`. */
async function ladder(
  file: { id: string; sha256: string },
  bucket?: MemoryBucket,
  types: readonly string[] = REGENERABLE_IMAGE_VARIANT_TYPES,
) {
  const rows = types.map((type) => ({
    fileId: file.id,
    type,
    key: `${rootOf(file.sha256)}${type}.webp`,
    width: 100,
    height: 100,
    readyAt: new Date(),
    size: 100,
  }));
  await getDb().insert(fileVariants).values(rows);
  for (const row of rows) bucket?.objects.set(row.key, Buffer.from('webp'));
}

async function source(file: { id: string; sha256: string }, owner: Owner) {
  await getDb()
    .insert(fileSources)
    .values({
      ownerUserId: owner.ownerUserId ?? null,
      ownerApplicationId: owner.ownerApplicationId ?? null,
      sourceUrlSha256: randomBytes(32).toString('hex'),
      sourceHost: 'example.com',
      sourceUrlCiphertext: 'sealed',
      fileId: file.id,
      contentSha256: file.sha256,
      fetchedAt: new Date(),
      lastStatus: 200,
    });
}

async function variantTypes(fileId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ type: fileVariants.type })
    .from(fileVariants)
    .where(eq(fileVariants.fileId, fileId));
  return rows.map((row) => row.type).sort();
}

async function sourceCount(fileId: string): Promise<number> {
  const rows = await getDb().select().from(fileSources).where(eq(fileSources.fileId, fileId));
  return rows.length;
}

async function backdate(id: string, patch: Partial<typeof files.$inferInsert>) {
  await getDb().update(files).set(patch).where(eq(files.id, id));
}

async function newestFileId(): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ id: sql<string | null>`max(${files.id})` })
    .from(files);
  // The next ids are uuidv7 of a later millisecond.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return row?.id ?? undefined;
}

async function holdAsEvidence(fileId: string, sha256: string) {
  const [claim] = await getDb()
    .insert(contentClaims)
    .values({
      reference: `OXY-${randomBytes(2).toString('hex').toUpperCase()}-TEST`,
      kind: 'copyright',
      relationship: 'rights_holder',
      state: 'reviewing',
    } as typeof contentClaims.$inferInsert)
    .returning({ id: contentClaims.id });
  await getDb()
    .insert(contentClaimTargets)
    .values({ claimId: claim.id, source: 'staff', resolution: 'file', fileId, sha256 });
}

function run(after: string | undefined, options: Partial<FileRetentionOptions> = {}) {
  const records: FileRetentionRecord[] = [];
  return runFileRetention({
    apply: false,
    after,
    now: () => NOW,
    pauseMs: 0,
    actions: { expireFederationCacheEntry: () => Promise.resolve(false) },
    emit: (record) => records.push(record),
    ...options,
  }).then((summary) => ({ summary, records }));
}

const apply = { apply: true, confirm: FILE_RETENTION_CONFIRMATION } as const;
const ids = (records: FileRetentionRecord[], step: FileRetentionRecord['step']) =>
  records.filter((record) => record.step === step).map((record) => record.fileId);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** Every case's fixture: what may go, and what must stay. */
async function fixture(bucket?: MemoryBucket) {
  const owner = await account();
  const app = await application();
  const mine: Owner = { ownerUserId: owner };

  const tombstone = await stored(mine, { status: 'deleted' }, bucket);
  await ladder(tombstone, bucket);
  await source(tombstone, mine);

  const evidence = await stored(mine, { status: 'deleted' }, bucket);
  await ladder(evidence, bucket);
  await holdAsEvidence(evidence.id, evidence.sha256);

  const bareTombstone = await stored(mine, { status: 'deleted' });

  const unused = await stored(mine, {}, bucket);
  await ladder(unused, bucket);
  await backdate(unused.id, { unreferencedSince: new Date(NOW.getTime() - 40 * DAY) });

  const recent = await stored(mine, {}, bucket);
  await ladder(recent, bucket);
  await backdate(recent.id, { unreferencedSince: new Date(NOW.getTime() - 10 * DAY) });

  // Referenced, with a stale stamp: the reference set itself decides.
  const referenced = await stored(mine, {}, bucket);
  await ladder(referenced, bucket);
  await addFileReferences([
    {
      fileId: referenced.id,
      applicationId: app,
      entityType: 'post',
      entityId: randomBytes(4).toString('hex'),
      createdByUserId: null,
    },
  ]);
  await backdate(referenced.id, { unreferencedSince: new Date(NOW.getTime() - 40 * DAY) });

  const video = await stored(mine, { mime: 'video/mp4', ext: '.mp4' }, bucket);
  await ladder(video, bucket, ['poster', '720p', 'thumb', 'w320']);
  await backdate(video.id, { unreferencedSince: new Date(NOW.getTime() - 40 * DAY) });

  const appImage = await stored({ ownerApplicationId: app }, {}, bucket);
  await ladder(appImage, bucket);
  await backdate(appImage.id, { unreferencedSince: new Date(NOW.getTime() - 40 * DAY) });

  const sticker = await stored({ systemOwner: '__stickers__' }, { purpose: 'sticker' }, bucket);
  await ladder(sticker, bucket);
  await backdate(sticker.id, { unreferencedSince: new Date(NOW.getTime() - 40 * DAY) });

  return {
    tombstone,
    evidence,
    bareTombstone,
    unused,
    recent,
    referenced,
    video,
    appImage,
    sticker,
  };
}

describe('file retention', () => {
  it('a dry run selects exactly what may go, with its counts and bytes, and changes nothing', async () => {
    const after = await newestFileId();
    const f = await fixture();

    const { summary, records } = await run(after, { offPeakWindow: null });

    expect(ids(records, 'tombstoneRenditions')).toEqual([f.tombstone.id]);
    expect(ids(records, 'unusedRenditions').sort()).toEqual([f.unused.id, f.appImage.id].sort());
    expect(ids(records, 'federationCacheExpiry')).toEqual([]);

    const tombstone = records.find((record) => record.fileId === f.tombstone.id);
    expect(tombstone).toMatchObject({ variantRows: 7, variantBytes: 700, sourceRows: 1 });
    const unused = records.find((record) => record.fileId === f.unused.id);
    // Six of seven: one rendition per directory stays.
    expect(unused).toMatchObject({ variantRows: 6, variantBytes: 600, sourceRows: 0 });

    expect(summary).toMatchObject({ apply: false, stoppedBecause: 'complete' });
    expect(summary.totals.tombstoneRenditions).toMatchObject({ files: 1, variantRows: 7 });
    expect(summary.totals.unusedRenditions).toMatchObject({ files: 2, variantRows: 12 });
    expect(summary.lastFileId).toBe(f.sticker.id);

    // Nothing changed.
    expect(await variantTypes(f.tombstone.id)).toHaveLength(7);
    expect(await sourceCount(f.tombstone.id)).toBe(1);
    expect(await variantTypes(f.unused.id)).toHaveLength(7);
  });

  it('an apply removes what the dry run named, owes the directories, keeps every object; a second finds nothing', async () => {
    const { bucket } = harness();
    const after = await newestFileId();
    const f = await fixture(bucket);
    const objectsBefore = bucket.objects.size;

    const { summary, records } = await run(after, { ...apply, offPeakWindow: null });

    expect(summary.totals.tombstoneRenditions).toMatchObject({
      files: 1,
      variantRows: 7,
      sourceRows: 1,
    });
    expect(summary.totals.unusedRenditions).toMatchObject({ files: 2, variantRows: 12 });
    expect(records.every((record) => record.outcome === 'done')).toBe(true);

    // The tombstone: rows gone, its directory owed a delete.
    expect(await variantTypes(f.tombstone.id)).toEqual([]);
    expect(await sourceCount(f.tombstone.id)).toBe(0);
    const owed = await getDb()
      .select()
      .from(storageObjectDeletions)
      .where(eq(storageObjectDeletions.target, rootOf(f.tombstone.sha256)));
    expect(owed).toEqual([
      expect.objectContaining({
        kind: 'prefix',
        accountId: f.tombstone.ownerUserId,
        reason: 'file.deleted',
      }),
    ]);

    // Unused images: one rendition left (thumb), the original untouched.
    expect(await variantTypes(f.unused.id)).toEqual(['thumb']);
    expect(await variantTypes(f.appImage.id)).toEqual(['thumb']);
    const [unused] = await getDb().select().from(files).where(eq(files.id, f.unused.id));
    expect(unused.status).toBe('active');

    // Never touched.
    expect(await variantTypes(f.evidence.id)).toHaveLength(7);
    expect(await variantTypes(f.recent.id)).toHaveLength(7);
    expect(await variantTypes(f.referenced.id)).toHaveLength(7);
    expect(await variantTypes(f.video.id)).toEqual(['720p', 'poster', 'thumb', 'w320']);
    expect(await variantTypes(f.sticker.id)).toHaveLength(7);

    // Rows only: no object was deleted by the pass itself.
    expect(bucket.objects.size).toBe(objectsBefore);

    const again = await run(after, { ...apply, offPeakWindow: null });
    expect(again.records).toEqual([]);
    expect(again.summary.estimate.databaseBytes ?? 0).toBe(0);
  });

  it('refuses to apply without the confirmation phrase', async () => {
    await expect(run(undefined, { apply: true, offPeakWindow: null })).rejects.toThrow(
      FILE_RETENTION_CONFIRMATION,
    );
    await expect(
      run(undefined, { apply: true, confirm: 'yes', offPeakWindow: null }),
    ).rejects.toThrow(FILE_RETENTION_CONFIRMATION);
  });

  it('expires an old, unheld federation cache entry only when the step is named', async () => {
    const { bucket, actions } = harness();
    const after = await newestFileId();
    const cache: Owner = { systemOwner: '__federation_media_cache__' };
    const old = await stored(
      cache,
      { purpose: 'federation-media-cache', visibility: 'public' },
      bucket,
    );
    await ladder(old, bucket);
    await backdate(old.id, { createdAt: new Date(NOW.getTime() - 100 * DAY) });
    const fresh = await stored(
      cache,
      { purpose: 'federation-media-cache', visibility: 'public' },
      bucket,
    );
    await backdate(fresh.id, { createdAt: new Date(NOW.getTime() - 10 * DAY) });
    const person = await stored({ ownerUserId: await account() }, {}, bucket);
    await backdate(person.id, { createdAt: new Date(NOW.getTime() - 400 * DAY) });

    // Not by default.
    const byDefault = await run(after, { ...apply, offPeakWindow: null, actions });
    expect(ids(byDefault.records, 'federationCacheExpiry')).toEqual([]);

    const dry = await run(after, {
      offPeakWindow: null,
      steps: ['federationCacheExpiry', 'tombstoneRenditions'],
    });
    expect(ids(dry.records, 'federationCacheExpiry')).toEqual([old.id]);
    // Its rows are counted once, as the tombstone step will remove them.
    expect(dry.summary.totals.federationCacheExpiry).toMatchObject({
      files: 1,
      variantRows: 7,
      originalBytes: 1000,
    });

    const applied = await run(after, {
      ...apply,
      offPeakWindow: null,
      actions,
      steps: ['federationCacheExpiry', 'tombstoneRenditions'],
    });
    expect(ids(applied.records, 'federationCacheExpiry')).toEqual([old.id]);
    // The same pass removes the new tombstone's rows.
    expect(ids(applied.records, 'tombstoneRenditions')).toEqual([old.id]);

    const rows = await getDb()
      .select({ id: files.id, status: files.status })
      .from(files)
      .where(inArray(files.id, [old.id, fresh.id, person.id]));
    expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
      [old.id]: 'deleted',
      [fresh.id]: 'active',
      [person.id]: 'active',
    });
    expect(await variantTypes(old.id)).toEqual([]);
    // Purged through the ledger: the original and its renditions are gone.
    expect(bucket.objects.has(old.storageKey)).toBe(false);
    expect([...bucket.objects.keys()].some((key) => key.includes(old.sha256))).toBe(false);
    expect(bucket.objects.has(fresh.storageKey)).toBe(true);
  });

  it('a bounded run resumes from its lastFileId and the whole converges', async () => {
    const after = await newestFileId();
    const mine: Owner = { ownerUserId: await account() };
    const tombstones = [];
    for (let i = 0; i < 4; i += 1) {
      const file = await stored(mine, { status: 'deleted' });
      await ladder(file, undefined, ['thumb', 'w320']);
      tombstones.push(file);
    }

    const first = await run(after, { ...apply, offPeakWindow: null, scanWindow: 1, maxBatches: 2 });
    expect(first.summary).toMatchObject({ stoppedBecause: 'maxBatches', batches: 2, scanned: 2 });
    expect(first.summary.lastFileId).toBe(tombstones[1].id);
    expect(ids(first.records, 'tombstoneRenditions')).toEqual([tombstones[0].id, tombstones[1].id]);
    expect(await variantTypes(tombstones[2].id)).toHaveLength(2);

    const rest = await run(first.summary.lastFileId ?? undefined, {
      ...apply,
      offPeakWindow: null,
      scanWindow: 1,
    });
    expect(rest.summary.stoppedBecause).toBe('complete');
    expect(ids(rest.records, 'tombstoneRenditions')).toEqual([tombstones[2].id, tombstones[3].id]);
    for (const file of tombstones) expect(await variantTypes(file.id)).toEqual([]);
  });

  it('stops outside the off-peak window, and after consecutive slow batches', async () => {
    const after = await newestFileId();
    const mine: Owner = { ownerUserId: await account() };
    for (let i = 0; i < 3; i += 1) {
      const file = await stored(mine, { status: 'deleted' });
      await ladder(file, undefined, ['thumb']);
    }

    const midday = await run(after, { ...apply, now: () => new Date('2026-11-28T12:00:00Z') });
    expect(midday.summary).toMatchObject({ stoppedBecause: 'outsideOffPeakWindow', batches: 0 });
    expect(midday.records).toEqual([]);

    const sleep = jest.fn(() => Promise.resolve());
    const slow = await run(after, {
      offPeakWindow: null,
      scanWindow: 1,
      slowBatchMs: -1,
      maxSlowBatches: 2,
      sleep,
    });
    expect(slow.summary).toMatchObject({ stoppedBecause: 'databaseSlow', batches: 2 });
    // One back-off pause between the first slow batch and the second.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(15_000);
  });
});
