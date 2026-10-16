/**
 * The file lifecycle (ADR 0043 D5) against a REAL Postgres and the REAL
 * `S3Service` over an in-memory bucket:
 *
 *  - `unreferenced_since` is maintained in the transaction that changes a
 *    file's references — set at insert and when the last reference goes (any
 *    path), cleared by a new one — and two concurrent removals of the last two
 *    references cannot both miss it;
 *  - removing the last reference NEVER trashes, on any path: an account's file
 *    stays `active` (only *not in use*), an application's too;
 *  - the sweep in `report` mode counts and names and changes nothing; in
 *    `enforce` it trashes an application's file unused for 24 hours (off the
 *    CDN, invalidated), purges one 30 days in trash through the
 *    `storage_object_deletions` ledger, tombstones a never-completed upload
 *    that holds no object, and never touches an account's unused file or a
 *    platform namespace;
 *  - a new reference restores a trashed application file and republishes it.
 *
 * Time travel is by injection: rows are back-dated and the sweep runs at a
 * chosen `now`. The test database is shared with other files in this worker,
 * so assertions are scoped to the files each case creates.
 */

import { randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

jest.mock('../variantService', () => ({
  VariantService: class {
    generateVariants = jest.fn(() => Promise.resolve());
  },
}));

jest.mock('../../queue/assetVariants.queue', () => ({
  enqueueAssetVariantGeneration: jest.fn(() => Promise.resolve()),
}));

jest.mock('../productBillingCatalogue.service', () => ({
  ...jest.requireActual('../productBillingCatalogue.service'),
  loadProductBillingCatalogue: () =>
    Promise.resolve(
      jest.requireActual('../productBillingCatalogue.service').EMPTY_PRODUCT_BILLING_CATALOGUE,
    ),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockEnqueueDeletedKey = jest.fn();
const mockEnqueuePath = jest.fn();
jest.mock('../cdnInvalidation', () => ({
  ...jest.requireActual('../cdnInvalidation'),
  getCdnInvalidationQueue: () => ({
    enqueueDeletedKey: (key: string) => mockEnqueueDeletedKey(key),
    enqueuePath: (path: string) => mockEnqueuePath(path),
  }),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  applications,
  fileLifecycleSweeps,
  files,
  storageObjectDeletions,
  users,
} from '../../db/schema';
import { purgeDeletedApplicationContent } from '../applicationDeletion.service';
import { AssetService } from '../assetService';
import {
  addFileReferences,
  deleteFileReference,
  insertFile,
  type NewFile,
} from '../fileRepository';
import {
  claimFileLifecycleSweep,
  type FileLifecycleActions,
  runFileLifecycleSweep,
} from '../fileLifecycle.worker';
import { S3Service } from '../s3Service';

jest.setTimeout(60_000);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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
      case 'CopyObjectCommand': {
        const source = String(input.CopySource).split('/').slice(1).join('/');
        const bytes = this.objects.get(source);
        if (!bytes) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        this.objects.set(key, bytes);
        return {};
      }
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
  const actions: FileLifecycleActions = {
    trashUnusedApplicationFile: (id, now) => service.trashUnusedApplicationFile(id, now),
    purgeTrashedApplicationFile: (id, now) => service.purgeTrashedApplicationFile(id, now),
    sweepStaleUpload: (id, now) => service.sweepStaleUpload(id, now),
    storedObjectExists: (id) => service.storedObjectExists(id),
    unpublishTrashedFile: (id) => service.unpublishTrashedFile(id),
    purgeBlockedApplicationFile: (id, now) => service.purgeBlockedApplicationFile(id, now),
    purgeDeletedApplication: async (id) => {
      const content = await purgeDeletedApplicationContent(id);
      if (content) service.finishApplicationDeletion(content);
      return content;
    },
  };
  return { bucket, service, actions };
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

/** A row through `insertFile` — the path every upload takes — with its object in `bucket`. */
async function stored(
  bucket: MemoryBucket | null,
  owner: Pick<NewFile, 'ownerUserId' | 'ownerApplicationId' | 'systemOwner'>,
  values: Partial<NewFile> = {},
) {
  const sha256 = randomBytes(32).toString('hex');
  const visibility = values.visibility ?? 'private';
  const storageKey = `${visibility === 'public' ? 'public/' : ''}content/2026/10/${sha256.slice(0, 2)}/${sha256}.png`;
  const file = await insertFile({
    sha256,
    size: 10,
    mime: 'image/png',
    ext: '.png',
    status: 'active',
    storageKey,
    originalName: 'tile.png',
    metadata: {},
    ...owner,
    ...values,
    visibility,
  });
  bucket?.objects.set(file.storageKey, Buffer.from('png-bytes'));
  return file;
}

async function row(id: string) {
  const [found] = await getDb().select().from(files).where(eq(files.id, id));
  return found;
}

async function backdate(id: string, patch: Partial<typeof files.$inferInsert>) {
  await getDb().update(files).set(patch).where(eq(files.id, id));
}

const ref = (fileId: string, applicationId: string, entityId = randomBytes(4).toString('hex')) => ({
  fileId,
  applicationId,
  entityType: 'listing',
  entityId,
  createdByUserId: null,
});

/** Run a forced sweep at `now`; `null` only if a run is still held (never, here). */
async function sweep(mode: 'report' | 'enforce', now: Date, actions: FileLifecycleActions) {
  const report = await runFileLifecycleSweep({
    mode,
    now: () => now,
    force: true,
    batchSize: 1000,
    actions,
  });
  if (!report) throw new Error('sweep was not claimed');
  return report;
}

const sampled = (report: Awaited<ReturnType<typeof sweep>>, step: keyof typeof report.samples) =>
  report.samples[step].map((sample) => sample.fileId);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  mockEnqueueDeletedKey.mockClear();
  mockEnqueuePath.mockClear();
});

describe('unreferenced_since is maintained with the reference set', () => {
  it('is set at insert, cleared by a reference, and set again when the last one goes', async () => {
    const appId = await application();
    const file = await stored(null, { ownerApplicationId: appId });
    expect((await row(file.id)).unreferencedSince).toBeInstanceOf(Date);

    const one = ref(file.id, appId, 'a');
    const two = ref(file.id, appId, 'b');
    await addFileReferences([one, two]);
    expect((await row(file.id)).unreferencedSince).toBeNull();

    await deleteFileReference(file.id, one);
    expect((await row(file.id)).unreferencedSince).toBeNull();
    await deleteFileReference(file.id, two);
    expect((await row(file.id)).unreferencedSince).toBeInstanceOf(Date);
    expect((await row(file.id)).status).toBe('active');
  });

  it('two concurrent removals of the last two references cannot both miss the stamp', async () => {
    const appId = await application();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const file = await stored(null, { ownerApplicationId: appId });
      const refs = [ref(file.id, appId), ref(file.id, appId)];
      await addFileReferences(refs);
      await Promise.all(refs.map((reference) => deleteFileReference(file.id, reference)));
      expect((await row(file.id)).unreferencedSince).toBeInstanceOf(Date);
    }
  });

  it("an account's file whose last reference goes stays active — not in use, never trashed", async () => {
    const { service } = harness();
    const owner = await account();
    const appId = await application();
    const file = await stored(null, { ownerUserId: owner });
    await service.linkFile(file.id, {
      applicationId: appId,
      entityType: 'post',
      entityId: 'post-1',
      createdByUserId: owner,
    });

    const { file: after, removed } = await service.unlinkFile(file.id, {
      applicationId: appId,
      entityType: 'post',
      entityId: 'post-1',
    });

    expect(removed).toBe(true);
    expect(after.status).toBe('active');
    expect(after.links).toHaveLength(0);
    expect(after.unreferencedSince).toBeInstanceOf(Date);
  });
});

describe('the sweep: report mode changes nothing', () => {
  it('counts and names an application file unused for 24 hours and leaves it active', async () => {
    const { bucket, actions } = harness();
    const appId = await application();
    const now = new Date();
    const due = await stored(bucket, { ownerApplicationId: appId });
    const fresh = await stored(bucket, { ownerApplicationId: appId });
    await backdate(due.id, { unreferencedSince: new Date(now.getTime() - 25 * HOUR) });
    await backdate(fresh.id, { unreferencedSince: new Date(now.getTime() - 23 * HOUR) });

    const report = await sweep('report', now, actions);

    expect(report.counts.trash.due).toBeGreaterThanOrEqual(1);
    expect(report.counts.trash.acted).toBe(0);
    expect(sampled(report, 'trash')).toContain(due.id);
    expect(sampled(report, 'trash')).not.toContain(fresh.id);
    expect((await row(due.id)).status).toBe('active');

    const [recorded] = await getDb()
      .select()
      .from(fileLifecycleSweeps)
      .where(eq(fileLifecycleSweeps.id, report.id));
    expect(recorded).toMatchObject({ mode: 'report', status: 'completed' });
    expect(recorded.counts.trash.due).toBe(report.counts.trash.due);
  });
});

describe('the sweep in enforce mode', () => {
  it("trashes an application's unused file, takes it off the CDN and invalidates it", async () => {
    const { bucket, actions } = harness();
    const appId = await application();
    const now = new Date();
    const file = await stored(bucket, { ownerApplicationId: appId }, { visibility: 'public' });
    await backdate(file.id, { unreferencedSince: new Date(now.getTime() - 25 * HOUR) });
    expect(file.storageKey.startsWith('public/')).toBe(true);

    const report = await sweep('enforce', now, actions);

    expect(report.counts.trash.acted).toBeGreaterThanOrEqual(1);
    const after = await row(file.id);
    expect(after.status).toBe('trash');
    expect(after.trashedAt?.getTime()).toBe(now.getTime());
    expect(after.visibility).toBe('public');
    // Off `public/`: the bytes moved to the bare spelling, the CDN copy deleted.
    expect(after.storageKey).toBe(file.storageKey.slice('public/'.length));
    expect(bucket.objects.has(after.storageKey)).toBe(true);
    expect(bucket.objects.has(file.storageKey)).toBe(false);
    expect(mockEnqueuePath).toHaveBeenCalledWith(`/${file.id}`);
    expect(mockEnqueueDeletedKey).toHaveBeenCalledWith(file.storageKey);
  });

  it('never collects a file that is referenced, whatever its stale stamp says', async () => {
    const { bucket, actions } = harness();
    const appId = await application();
    const now = new Date();
    const file = await stored(bucket, { ownerApplicationId: appId });
    await addFileReferences([ref(file.id, appId)]);
    // A stamp left behind by a writer that did not maintain it.
    await backdate(file.id, { unreferencedSince: new Date(now.getTime() - 40 * DAY) });

    const report = await sweep('enforce', now, actions);

    expect(sampled(report, 'trash')).not.toContain(file.id);
    expect((await row(file.id)).status).toBe('active');
  });

  it("never trashes or deletes an account's unused file, nor a platform namespace's", async () => {
    const { bucket, actions } = harness();
    const now = new Date();
    const person = await stored(bucket, { ownerUserId: await account() });
    const sticker = await stored(bucket, { systemOwner: '__stickers__' }, { purpose: 'sticker' });
    for (const id of [person.id, sticker.id]) {
      await backdate(id, { unreferencedSince: new Date(now.getTime() - 400 * DAY) });
    }
    const trashed = await stored(bucket, { ownerUserId: await account() });
    await backdate(trashed.id, { status: 'trash', trashedAt: new Date(now.getTime() - 400 * DAY) });

    await sweep('enforce', now, actions);

    expect((await row(person.id)).status).toBe('active');
    expect((await row(sticker.id)).status).toBe('active');
    expect((await row(trashed.id)).status).toBe('trash');
  });

  it('purges an application file 30 days in trash through the storage-deletion ledger', async () => {
    const { bucket, actions } = harness();
    const appId = await application();
    const now = new Date();
    const file = await stored(bucket, { ownerApplicationId: appId });
    const young = await stored(bucket, { ownerApplicationId: appId });
    await backdate(file.id, { status: 'trash', trashedAt: new Date(now.getTime() - 31 * DAY) });
    await backdate(young.id, { status: 'trash', trashedAt: new Date(now.getTime() - 29 * DAY) });

    const report = await sweep('enforce', now, actions);

    expect(report.counts.purge.acted).toBeGreaterThanOrEqual(1);
    expect((await row(file.id)).status).toBe('deleted');
    expect((await row(young.id)).status).toBe('trash');
    const owed = await getDb()
      .select()
      .from(storageObjectDeletions)
      .where(eq(storageObjectDeletions.sha256, file.sha256));
    expect(owed).toEqual([
      expect.objectContaining({
        reason: 'file.deleted',
        accountId: `app:${appId}`,
        target: file.storageKey,
        outcome: 'deleted',
      }),
    ]);
    expect(bucket.objects.has(file.storageKey)).toBe(false);
  });

  it('a new reference within the 30 days restores the file and republishes it', async () => {
    const { bucket, actions, service } = harness();
    const appId = await application();
    const now = new Date();
    const file = await stored(bucket, { ownerApplicationId: appId }, { visibility: 'public' });
    await backdate(file.id, { unreferencedSince: new Date(now.getTime() - 25 * HOUR) });
    await sweep('enforce', now, actions);
    expect((await row(file.id)).status).toBe('trash');

    const { file: restored, created } = await service.linkFile(file.id, {
      applicationId: appId,
      entityType: 'listing',
      entityId: 'listing-1',
      createdByUserId: null,
    });

    expect(created).toBe(true);
    expect(restored.status).toBe('active');
    expect(restored.trashedAt).toBeNull();
    expect(restored.unreferencedSince).toBeNull();
    // Back under `public/`, so the CDN serves it again.
    expect(restored.storageKey).toBe(file.storageKey);
    expect(bucket.objects.has(file.storageKey)).toBe(true);
  });

  it("an application's re-upload of a trashed file of its own restores it with a fresh clock", async () => {
    const { bucket, service } = harness();
    const appId = await application();
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      randomBytes(24),
    ]);
    const { Readable } = await import('node:stream');
    const first = await service.uploadApplicationFileStream(
      Readable.from(bytes),
      'image/png',
      'tile.png',
      1_000_000,
      appId,
      'private',
    );
    const stale = new Date(Date.now() - 3 * DAY);
    await backdate(first.file.id, { status: 'trash', trashedAt: stale, unreferencedSince: stale });

    const again = await service.uploadApplicationFileStream(
      Readable.from(bytes),
      'image/png',
      'tile.png',
      1_000_000,
      appId,
      'private',
    );

    expect(again).toMatchObject({ deduplicated: true });
    const after = await row(first.file.id);
    expect(after.status).toBe('active');
    expect(after.trashedAt).toBeNull();
    expect(after.unreferencedSince?.getTime()).toBeGreaterThan(stale.getTime());
    expect(bucket.objects.size).toBeGreaterThan(0);
  });
});

describe('the sweep: uploads that never completed', () => {
  async function pendingUpload(bucket: MemoryBucket, withObject: boolean, ageMs: number) {
    const owner = await account();
    const file = await stored(withObject ? bucket : null, { ownerUserId: owner });
    // What `POST /assets/init` leaves before `/complete`: no name, no metadata.
    await backdate(file.id, {
      originalName: null,
      metadata: null,
      createdAt: new Date(Date.now() - ageMs),
    });
    return file;
  }

  it('reports a stale upload and touches nothing in report mode', async () => {
    const { bucket, actions } = harness();
    const file = await pendingUpload(bucket, false, 25 * HOUR);

    const report = await sweep('report', new Date(), actions);

    expect(sampled(report, 'staleUploads')).toContain(file.id);
    expect(report.counts.staleUploads.withoutObject).toBeGreaterThanOrEqual(1);
    expect((await row(file.id)).status).toBe('active');
  });

  it('tombstones one with no object after 24 hours; keeps one with an object, and a young one', async () => {
    const { bucket, actions } = harness();
    const empty = await pendingUpload(bucket, false, 25 * HOUR);
    const holding = await pendingUpload(bucket, true, 25 * HOUR);
    const young = await pendingUpload(bucket, false, 23 * HOUR);

    const report = await sweep('enforce', new Date(), actions);

    expect((await row(empty.id)).status).toBe('deleted');
    expect((await row(holding.id)).status).toBe('active');
    expect((await row(young.id)).status).toBe('active');
    expect(report.counts.staleUploads.withObject).toBeGreaterThanOrEqual(1);
  });

  it('never sweeps a completed upload, however old', async () => {
    const { actions } = harness();
    const completed = await stored(null, { ownerUserId: await account() });
    await backdate(completed.id, { createdAt: new Date(Date.now() - 400 * DAY) });

    await sweep('enforce', new Date(), actions);

    expect((await row(completed.id)).status).toBe('active');
  });
});

describe('the sweep: a public file trashed before trash left the CDN', () => {
  it('is moved off public/ in enforce mode only', async () => {
    const { bucket, actions } = harness();
    const file = await stored(bucket, { ownerUserId: await account() }, { visibility: 'public' });
    await backdate(file.id, { status: 'trash', trashedAt: new Date() });

    await sweep('report', new Date(), actions);
    expect((await row(file.id)).storageKey).toBe(file.storageKey);

    await sweep('enforce', new Date(), actions);
    const after = await row(file.id);
    expect(after.storageKey).toBe(file.storageKey.slice('public/'.length));
    expect(bucket.objects.has(file.storageKey)).toBe(false);
    expect(mockEnqueuePath).toHaveBeenCalledWith(`/${file.id}`);
  });
});

describe('one sweeper at a time, on a schedule', () => {
  it('refuses a second claim while a run holds its lease, and retires a dead one', async () => {
    const now = new Date();
    const first = await claimFileLifecycleSweep({ mode: 'report', force: true }, now);
    expect(first).not.toBeNull();
    expect(await claimFileLifecycleSweep({ mode: 'report', force: true }, now)).toBeNull();

    // Past its lease: the next claim retires it and takes over.
    const later = new Date(now.getTime() + 16 * 60 * 1000);
    const second = await claimFileLifecycleSweep({ mode: 'report', force: true }, later);
    expect(second).not.toBeNull();
    const rows = await getDb()
      .select({ id: fileLifecycleSweeps.id, status: fileLifecycleSweeps.status })
      .from(fileLifecycleSweeps)
      .where(inArray(fileLifecycleSweeps.id, [first?.id ?? '', second?.id ?? '']));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      [first?.id ?? '']: 'abandoned',
      [second?.id ?? '']: 'running',
    });
    await getDb()
      .update(fileLifecycleSweeps)
      .set({ status: 'completed', finishedAt: later })
      .where(eq(fileLifecycleSweeps.id, second?.id ?? ''));
  });

  it('is not due again within the interval after a completed run', async () => {
    const { actions } = harness();
    const now = new Date(Date.now() + 365 * DAY);
    await sweep('report', now, actions);
    expect(
      await runFileLifecycleSweep({ mode: 'report', now: () => now, actions, intervalMs: HOUR }),
    ).toBeNull();
    expect(
      await runFileLifecycleSweep({
        mode: 'report',
        now: () => new Date(now.getTime() + HOUR + 1),
        actions,
        intervalMs: HOUR,
      }),
    ).not.toBeNull();
  });
});
