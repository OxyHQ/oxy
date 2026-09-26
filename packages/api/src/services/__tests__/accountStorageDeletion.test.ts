/**
 * A deleted account's stored uploads (OxyHQ/Mention#1178), against a REAL
 * Postgres: which storage is recorded for deletion in the deletion's own
 * transaction, and the worker that deletes it — idempotent, retried, guarded
 * against content somebody else still uses. The object store is an in-memory
 * fake with S3's semantics (a delete of a missing key succeeds).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files } from '../../db/schema/files';
import { fileVariants } from '../../db/schema/fileVariants';
import { mailboxes } from '../../db/schema/mailboxes';
import { messageAttachments } from '../../db/schema/messageAttachments';
import { messages } from '../../db/schema/messages';
import { storageObjectDeletions } from '../../db/schema/storageObjectDeletions';
import { users } from '../../db/schema/users';
import {
  recordAccountStorageDeletion,
  storageTargetsForAsset,
} from '../accountStorageDeletion.service';
import {
  STORAGE_DELETION_LEASE_MS,
  countPendingStorageDeletions,
  runStorageDeletionBatch,
  storageDeletionBackoffMs,
  type StorageDeletionStore,
} from '../accountStorageDeletion.worker';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.setTimeout(60_000);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** An in-memory bucket. `failNext` makes the next N deletes throw, like a throttled S3. */
class FakeBucket implements StorageDeletionStore {
  readonly objects = new Set<string>();
  readonly deleted: string[] = [];
  failNext = 0;

  put(...keys: string[]) {
    for (const key of keys) this.objects.add(key);
  }

  async deleteObject(key: string): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('SlowDown: please reduce your request rate');
    }
    this.deleted.push(key);
    this.objects.delete(key);
  }

  async listKeys(prefix: string, maxKeys: number): Promise<string[]> {
    return [...this.objects].filter((key) => key.startsWith(prefix)).sort().slice(0, maxKeys);
  }
}

const sha = () => randomBytes(32).toString('hex');

async function createUser(prefix: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb()
    .insert(users)
    .values({ username: `${prefix}-${suffix}`, email: `${prefix}-${suffix}@example.test` })
    .returning({ id: users.id });
  return user!.id;
}

async function createAsset(
  owner: { ownerUserId: string } | { systemOwner: '__federation_media_cache__' },
  options: { sha256?: string; storageKey?: string; variants?: string[]; status?: 'active' | 'trash' | 'deleted' } = {},
) {
  const sha256 = options.sha256 ?? sha();
  const storageKey = options.storageKey ?? `content/2026/09/${sha256.slice(0, 2)}/${sha256}.jpg`;
  const [file] = await getDb()
    .insert(files)
    .values({
      sha256,
      size: 10,
      mime: 'image/jpeg',
      ext: 'jpg',
      storageKey,
      status: options.status ?? 'active',
      ...('ownerUserId' in owner
        ? { ownerUserId: owner.ownerUserId }
        : { systemOwner: owner.systemOwner, purpose: 'federation-media-cache' as const }),
    })
    .returning({ id: files.id });
  for (const key of options.variants ?? []) {
    await getDb().insert(fileVariants).values({ fileId: file!.id, type: key.split('/').pop()!, key, readyAt: new Date() });
  }
  return { id: file!.id, sha256, storageKey };
}

async function rowsFor(accountId: string) {
  return getDb().select().from(storageObjectDeletions).where(eq(storageObjectDeletions.accountId, accountId));
}

/** Only this account's rows are claimable, so parallel suites never interfere. */
async function parkOtherRows(accountId: string) {
  const others = await getDb()
    .select({ id: storageObjectDeletions.id, accountId: storageObjectDeletions.accountId })
    .from(storageObjectDeletions);
  const ids = others.filter((row) => row.accountId !== accountId).map((row) => row.id);
  if (ids.length > 0) {
    await getDb()
      .update(storageObjectDeletions)
      .set({ nextAttemptAt: new Date(Date.now() + 365 * 24 * 3600 * 1000) })
      .where(inArray(storageObjectDeletions.id, ids));
  }
}

describe('storageTargetsForAsset', () => {
  it('records the original by its base key and the variant directory as one prefix', () => {
    const hash = 'ab'.repeat(32);
    const targets = storageTargetsForAsset(
      { sha256: hash, storageKey: `public/content/2026/09/ab/${hash}.jpg` },
      [
        `public/variants/2026/09/ab/${hash}/thumb.webp`,
        `public/variants/2026/09/ab/${hash}/hls_master.m3u8`,
      ],
    );
    expect(targets).toEqual([
      { kind: 'object', target: `content/2026/09/ab/${hash}.jpg`, sha256: hash },
      { kind: 'prefix', target: `variants/2026/09/ab/${hash}/`, sha256: hash },
    ]);
  });

  it('never widens an unrecognised variant key into a directory delete', () => {
    const hash = 'cd'.repeat(32);
    const targets = storageTargetsForAsset(
      { sha256: hash, storageKey: `content/2026/09/cd/${hash}.png` },
      ['legacy/thumbs/some-thumb.webp', `variants/2026/09/cd/${'ef'.repeat(32)}/thumb.webp`],
    );
    expect(targets.map((target) => [target.kind, target.target])).toEqual([
      ['object', `content/2026/09/cd/${hash}.png`],
      ['object', 'legacy/thumbs/some-thumb.webp'],
      ['object', `variants/2026/09/cd/${'ef'.repeat(32)}/thumb.webp`],
    ]);
  });
});

describe('recordAccountStorageDeletion', () => {
  it("records every asset the account owns and none of anybody else's", async () => {
    const person = await createUser('leaving');
    const bystander = await createUser('staying');
    const photo = await createAsset({ ownerUserId: person });
    const video = await createAsset({ ownerUserId: person }, { variants: [] });
    await getDb().insert(fileVariants).values({
      fileId: video.id,
      type: 'hls_master',
      key: `variants/2026/09/${video.sha256.slice(0, 2)}/${video.sha256}/hls_master.m3u8`,
    });
    const trashed = await createAsset({ ownerUserId: person }, { status: 'trash' });
    const theirs = await createAsset({ ownerUserId: bystander });
    const cached = await createAsset({ systemOwner: '__federation_media_cache__' });

    const recorded = await getDb().transaction((tx) =>
      recordAccountStorageDeletion(tx, person, { removeAssetRows: false }));

    expect(recorded.fileIds.sort()).toEqual([photo.id, video.id, trashed.id].sort());
    const rows = await rowsFor(person);
    expect(rows.map((row) => `${row.kind}:${row.target}`).sort()).toEqual([
      `object:${photo.storageKey}`,
      `object:${trashed.storageKey}`,
      `object:${video.storageKey}`,
      `prefix:variants/2026/09/${video.sha256.slice(0, 2)}/${video.sha256}/`,
    ].sort());
    expect(rows.every((row) => row.reason === 'account.deleted' && row.completedAt === null)).toBe(true);
    expect(rows.some((row) => row.sha256 === theirs.sha256 || row.sha256 === cached.sha256)).toBe(false);

    // A retried deletion records nothing twice.
    await getDb().transaction((tx) => recordAccountStorageDeletion(tx, person, { removeAssetRows: false }));
    expect(await rowsFor(person)).toHaveLength(4);

    // Without removeAssetRows the rows are the caller's cascade to remove.
    expect(await getDb().select({ id: files.id }).from(files).where(eq(files.ownerUserId, person))).toHaveLength(3);
  });

  it('removes the asset rows itself on the archive path, sparing one another mailbox still uses', async () => {
    const person = await createUser('archived');
    const recipient = await createUser('recipient');
    const photo = await createAsset({ ownerUserId: person }, {
      variants: [],
    });
    await getDb().insert(fileVariants).values({ fileId: photo.id, type: 'thumb', key: `variants/2026/09/${photo.sha256.slice(0, 2)}/${photo.sha256}/thumb.webp` });
    const attached = await createAsset({ ownerUserId: person });
    const [mailbox] = await getDb()
      .insert(mailboxes)
      .values({ userId: recipient, name: 'Inbox', path: `Inbox-${randomUUID()}` })
      .returning({ id: mailboxes.id });
    const [message] = await getDb()
      .insert(messages)
      .values({
        userId: recipient,
        mailboxId: mailbox!.id,
        messageId: `<${randomUUID()}@example.test>`,
        fromAddress: 'archived@example.test',
        subject: 'A file for you',
        size: 10,
        date: new Date(),
      })
      .returning({ id: messages.id });
    await getDb().insert(messageAttachments).values({
      messageId: message!.id,
      ord: 0,
      fileId: attached.id,
      name: 'photo.jpg',
      contentType: 'image/jpeg',
      size: 10,
    });

    const recorded = await getDb().transaction((tx) =>
      recordAccountStorageDeletion(tx, person, { removeAssetRows: true }));

    expect(recorded.fileIds).toEqual([photo.id]);
    const remaining = await getDb().select({ id: files.id }).from(files).where(eq(files.ownerUserId, person));
    expect(remaining.map((row) => row.id)).toEqual([attached.id]);
    expect(await getDb().select().from(fileVariants).where(eq(fileVariants.fileId, photo.id))).toHaveLength(0);
    expect((await rowsFor(person)).map((row) => row.target).sort()).toEqual([
      photo.storageKey,
      `variants/2026/09/${photo.sha256.slice(0, 2)}/${photo.sha256}/`,
    ].sort());
  });

  it('records nothing when the transaction rolls back', async () => {
    const person = await createUser('rolled-back');
    await createAsset({ ownerUserId: person });
    await expect(getDb().transaction(async (tx) => {
      await recordAccountStorageDeletion(tx, person, { removeAssetRows: true });
      throw new Error('deletion refused');
    })).rejects.toThrow('deletion refused');
    expect(await rowsFor(person)).toHaveLength(0);
    expect(await getDb().select({ id: files.id }).from(files).where(eq(files.ownerUserId, person))).toHaveLength(1);
  });
});

describe('runStorageDeletionBatch', () => {
  async function deletedAccountWith(options: { variants?: boolean } = {}) {
    const person = await createUser('erased');
    const asset = await createAsset({ ownerUserId: person });
    const directory = `variants/2026/09/${asset.sha256.slice(0, 2)}/${asset.sha256}/`;
    if (options.variants) {
      await getDb().insert(fileVariants).values({ fileId: asset.id, type: 'hls_master', key: `public/${directory}hls_master.m3u8` });
    }
    await getDb().transaction(async (tx) => {
      await recordAccountStorageDeletion(tx, person, { removeAssetRows: false });
      await tx.delete(users).where(eq(users.id, person));
    });
    await parkOtherRows(person);
    return { person, asset, directory };
  }

  it('deletes the original in both spellings and every object under the variant directory', async () => {
    const { person, asset, directory } = await deletedAccountWith({ variants: true });
    const bucket = new FakeBucket();
    const segments = Array.from({ length: 5 }, (_, i) => `public/${directory}hls_360p_segment_${i}.ts`);
    const unrelated = `public/variants/2026/09/${asset.sha256.slice(0, 2)}/${sha()}/thumb.webp`;
    bucket.put(asset.storageKey, `public/${asset.storageKey}`, `public/${directory}hls_master.m3u8`, ...segments, unrelated);

    const result = await runStorageDeletionBatch({ ownerId: 'test-worker', store: bucket });

    expect(result).toMatchObject({ claimed: 2, deleted: 2, failed: 0 });
    expect([...bucket.objects]).toEqual([unrelated]);
    const rows = await rowsFor(person);
    expect(rows.every((row) => row.outcome === 'deleted' && row.completedAt !== null && row.attempts === 1)).toBe(true);
    expect(await countPendingStorageDeletions(person)).toBe(0);

    // Converged: nothing is claimable again, and a second run deletes nothing.
    const again = await runStorageDeletionBatch({ ownerId: 'test-worker', store: bucket });
    expect(again.claimed).toBe(0);
  });

  it('succeeds when the objects are already gone (S3 answers a missing key with success)', async () => {
    const { person } = await deletedAccountWith();
    const bucket = new FakeBucket();
    const result = await runStorageDeletionBatch({ ownerId: 'test-worker', store: bucket });
    expect(result).toMatchObject({ claimed: 1, deleted: 1 });
    expect((await rowsFor(person))[0]).toMatchObject({ outcome: 'deleted' });
  });

  it('keeps bytes a live asset with the same content still uses, and says so', async () => {
    const { person, asset } = await deletedAccountWith();
    // Somebody uploads the same bytes after the deletion and is given the same key.
    const reuploader = await createUser('reuploader');
    await createAsset({ ownerUserId: reuploader }, { sha256: asset.sha256, storageKey: `public/${asset.storageKey}` });
    const bucket = new FakeBucket();
    bucket.put(`public/${asset.storageKey}`);

    const result = await runStorageDeletionBatch({ ownerId: 'test-worker', store: bucket });

    expect(result).toMatchObject({ claimed: 1, deleted: 0, retainedShared: 1 });
    expect(bucket.deleted).toEqual([]);
    expect((await rowsFor(person))[0]).toMatchObject({ outcome: 'retained_shared' });
  });

  it('retries a failure with backoff instead of giving up, then converges', async () => {
    const { person, asset } = await deletedAccountWith();
    const bucket = new FakeBucket();
    bucket.put(asset.storageKey);
    bucket.failNext = 1;
    const start = new Date();

    const failed = await runStorageDeletionBatch({ ownerId: 'test-worker', store: bucket, now: () => start });
    expect(failed).toMatchObject({ claimed: 1, failed: 1, deleted: 0 });
    const [row] = await rowsFor(person);
    expect(row).toMatchObject({ attempts: 1, completedAt: null, claimedBy: null });
    expect(row!.lastError).toContain('SlowDown');
    expect(row!.nextAttemptAt.getTime()).toBe(start.getTime() + storageDeletionBackoffMs(1));

    // Not due yet.
    expect((await runStorageDeletionBatch({ ownerId: 'test-worker', store: bucket, now: () => start })).claimed).toBe(0);

    const later = new Date(start.getTime() + storageDeletionBackoffMs(1) + 1);
    const retried = await runStorageDeletionBatch({ ownerId: 'test-worker', store: bucket, now: () => later });
    expect(retried).toMatchObject({ claimed: 1, deleted: 1 });
    expect(bucket.objects.size).toBe(0);
    expect((await rowsFor(person))[0]).toMatchObject({ attempts: 2, outcome: 'deleted', lastError: null });
  });

  it('never hands a leased row to a second worker until the lease lapses', async () => {
    const { person } = await deletedAccountWith();
    const start = new Date();
    await getDb()
      .update(storageObjectDeletions)
      .set({ claimedAt: start, claimedBy: 'crashed-worker' })
      .where(eq(storageObjectDeletions.accountId, person));
    const bucket = new FakeBucket();

    expect((await runStorageDeletionBatch({ ownerId: 'other', store: bucket, now: () => start })).claimed).toBe(0);

    const lapsed = new Date(start.getTime() + STORAGE_DELETION_LEASE_MS + 1);
    const taken = await runStorageDeletionBatch({ ownerId: 'other', store: bucket, now: () => lapsed });
    expect(taken).toMatchObject({ claimed: 1, deleted: 1 });
  });

  it('caps the backoff at six hours', () => {
    expect(storageDeletionBackoffMs(1)).toBe(60_000);
    expect(storageDeletionBackoffMs(2)).toBe(120_000);
    expect(storageDeletionBackoffMs(50)).toBe(6 * 60 * 60 * 1000);
  });
});
