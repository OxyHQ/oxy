/**
 * The data migration for cross-owner shares left by one-live-row-per-hash,
 * against a REAL Postgres (`fileOwnerSplit.service.ts`).
 *
 * Every case scopes the scan to an application name it owns (`--app`), so rows
 * other suites leave in the shared database are never counted or changed.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { fileLinks, files, fileVariants, users } from '../../db/schema';
import { runFileOwnerSplit, type FileOwnerSplitRecord } from '../fileOwnerSplit.service';

const sha = () => randomBytes(32).toString('hex');

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

/** Alice's public file, with a rendition and application metadata, linked by Alice, Bob and Carol. */
async function sharedFixture() {
  const app = `split-${randomUUID().slice(0, 8)}`;
  const otherApp = `${app}-other`;
  const [alice, bob, carol] = [await insertUser(), await insertUser(), await insertUser()];
  const sha256 = sha();
  const storageKey = `public/content/2026/09/${sha256.slice(0, 2)}/${sha256}.png`;
  const [source] = await getDb()
    .insert(files)
    .values({
      sha256,
      size: 42,
      mime: 'image/png',
      ext: '.png',
      ownerUserId: alice,
      visibility: 'public',
      storageKey,
      originalName: 'alice.png',
      metadata: { media: { width: 4, height: 3 }, source: 'federation', serviceAppId: 'app-alice' },
    })
    .returning();
  const variantKey = `public/variants/2026/09/${sha256.slice(0, 2)}/${sha256}/thumb.webp`;
  await getDb()
    .insert(fileVariants)
    .values({ fileId: source.id, type: 'thumb', key: variantKey, readyAt: new Date() });
  const link = (createdBy: string, entityId: string, onApp = app) =>
    getDb()
      .insert(fileLinks)
      .values({ fileId: source.id, app: onApp, entityType: 'post', entityId, createdBy });
  await link(alice, 'a-1');
  await link(bob, 'b-1');
  await link(bob, 'b-2');
  await link(carol, 'c-1', otherApp);
  return { app, otherApp, alice, bob, carol, sha256, source, storageKey, variantKey };
}

async function liveRowsFor(sha256: string) {
  return getDb()
    .select()
    .from(files)
    .where(and(eq(files.sha256, sha256), ne(files.status, 'deleted')));
}

async function linksOf(fileId: string) {
  const rows = await getDb().select().from(fileLinks).where(eq(fileLinks.fileId, fileId));
  return rows.map((row) => row.entityId).sort();
}

function collect() {
  const records: FileOwnerSplitRecord[] = [];
  return { records, emit: (record: FileOwnerSplitRecord) => records.push(record) };
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('report (the dry run)', () => {
  it('lists each (file, linking account) pair and writes nothing', async () => {
    const f = await sharedFixture();
    const { records, emit } = collect();

    const summary = await runFileOwnerSplit({ mode: 'report', batchSize: 50, app: f.app, emit });

    expect(summary).toMatchObject({ pairs: 1, linksScanned: 2, rowsCreated: 0, finished: true });
    expect(records).toEqual([
      expect.objectContaining({
        sourceFileId: f.source.id,
        ownerUserId: f.bob,
        fileId: null,
        links: [
          { app: f.app, entityType: 'post', entityId: 'b-1' },
          { app: f.app, entityType: 'post', entityId: 'b-2' },
        ],
      }),
    ]);
    expect(await liveRowsFor(f.sha256)).toHaveLength(1);
  });
});

describe('create-rows', () => {
  it('gives the linking account its own row sharing storage and renditions, leaving every link where it was', async () => {
    const f = await sharedFixture();
    const { records, emit } = collect();

    const summary = await runFileOwnerSplit({
      mode: 'create-rows',
      batchSize: 50,
      app: f.app,
      emit,
    });

    expect(summary).toMatchObject({ pairs: 1, rowsCreated: 1, rowsReused: 0, linksRepointed: 0 });
    const bobRowId = records[0].fileId;
    if (!bobRowId) throw new Error('no row');
    const [bobRow] = await getDb().select().from(files).where(eq(files.id, bobRowId));
    expect(bobRow).toMatchObject({
      ownerUserId: f.bob,
      storageKey: f.storageKey,
      visibility: 'public',
      status: 'active',
      purpose: 'user',
    });
    // Intrinsic metadata only — never the original's application metadata,
    // which is what the federated delete route authorizes by.
    expect(bobRow.metadata).toEqual({
      media: { width: 4, height: 3 },
      splitFromFileId: f.source.id,
    });
    const variants = await getDb()
      .select()
      .from(fileVariants)
      .where(eq(fileVariants.fileId, bobRowId));
    expect(variants.map((v) => v.key)).toEqual([f.variantKey]);
    // Nothing that references the original moved.
    expect(await linksOf(f.source.id)).toEqual(['a-1', 'b-1', 'b-2', 'c-1']);
    expect(await linksOf(bobRowId)).toEqual([]);
  });

  it('is idempotent: a second run reuses the row it made', async () => {
    const f = await sharedFixture();
    const first = collect();
    await runFileOwnerSplit({ mode: 'create-rows', batchSize: 50, app: f.app, emit: first.emit });
    const second = collect();

    const summary = await runFileOwnerSplit({
      mode: 'create-rows',
      batchSize: 50,
      app: f.app,
      emit: second.emit,
    });

    expect(summary).toMatchObject({ rowsCreated: 0, rowsReused: 1 });
    expect(second.records[0].fileId).toBe(first.records[0].fileId);
    expect(await liveRowsFor(f.sha256)).toHaveLength(2);
  });

  it('reuses the row the account already holds for those bytes', async () => {
    const f = await sharedFixture();
    const [own] = await getDb()
      .insert(files)
      .values({
        sha256: f.sha256,
        size: 42,
        mime: 'image/png',
        ext: '.png',
        ownerUserId: f.bob,
        storageKey: f.storageKey,
      })
      .returning({ id: files.id });
    const { records, emit } = collect();

    await runFileOwnerSplit({ mode: 'create-rows', batchSize: 50, app: f.app, emit });

    expect(records[0]).toMatchObject({ fileId: own.id, created: false });
  });

  it('resumes from `lastLinkId` across bounded batches to the same result', async () => {
    const f = await sharedFixture();
    const { records, emit } = collect();

    const firstPart = await runFileOwnerSplit({
      mode: 'create-rows',
      batchSize: 1,
      maxBatches: 1,
      app: f.app,
      emit,
    });
    expect(firstPart.finished).toBe(false);
    const rest = await runFileOwnerSplit({
      mode: 'create-rows',
      batchSize: 1,
      app: f.app,
      after: firstPart.lastLinkId ?? undefined,
      emit,
    });

    expect(rest.finished).toBe(true);
    // Two links, one pair: both batches resolve to the SAME new row.
    expect(new Set(records.map((record) => record.fileId)).size).toBe(1);
    expect(await liveRowsFor(f.sha256)).toHaveLength(2);
  });
});

describe('repoint-links', () => {
  it('refuses to run without an application to scope it to', async () => {
    await expect(
      runFileOwnerSplit({ mode: 'repoint-links', batchSize: 50, emit: () => undefined }),
    ).rejects.toThrow('--app');
  });

  it("moves only that application's cross-owner links to the linking account's own row", async () => {
    const f = await sharedFixture();
    const { records, emit } = collect();

    const summary = await runFileOwnerSplit({
      mode: 'repoint-links',
      batchSize: 50,
      app: f.app,
      emit,
    });

    expect(summary).toMatchObject({ linksRepointed: 2 });
    const bobRowId = records[0].fileId;
    if (!bobRowId) throw new Error('no row');
    expect(await linksOf(bobRowId)).toEqual(['b-1', 'b-2']);
    // The owner's own link, and the other application's, stay on the original.
    expect(await linksOf(f.source.id)).toEqual(['a-1', 'c-1']);

    // Nothing left to do for that application.
    const again = await runFileOwnerSplit({
      mode: 'repoint-links',
      batchSize: 50,
      app: f.app,
      emit: () => undefined,
    });
    expect(again).toMatchObject({ linksScanned: 0, pairs: 0, finished: true });
  });

  it('drops a link the target already carries instead of violating the link unique', async () => {
    const f = await sharedFixture();
    const created = collect();
    await runFileOwnerSplit({ mode: 'create-rows', batchSize: 50, app: f.app, emit: created.emit });
    const bobRowId = created.records[0].fileId;
    if (!bobRowId) throw new Error('no row');
    await getDb().insert(fileLinks).values({
      fileId: bobRowId,
      app: f.app,
      entityType: 'post',
      entityId: 'b-1',
      createdBy: f.bob,
    });

    await runFileOwnerSplit({
      mode: 'repoint-links',
      batchSize: 50,
      app: f.app,
      emit: () => undefined,
    });

    expect(await linksOf(bobRowId)).toEqual(['b-1', 'b-2']);
    expect(await linksOf(f.source.id)).toEqual(['a-1', 'c-1']);
  });
});
