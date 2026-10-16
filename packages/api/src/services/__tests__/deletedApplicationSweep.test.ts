/**
 * Applications deleted BEFORE ADR 0042 D8 shipped kept their files and their
 * references. The lifecycle sweep's `deletedApplications` step finds them and,
 * in `enforce`, runs D8 on them — the same path the console's delete runs —
 * against a REAL Postgres, with the default actions (the real `assetService`
 * over an in-memory object store) and a recording CDN queue.
 *
 * Invariants:
 *  1. `report` counts and names each such application (files and references it
 *     still has) and changes NOTHING.
 *  2. `enforce` tombstones every file it owns — active, trash, blocked; no
 *     trash — owes each its purge (`storage_object_deletions`, `app:<id>`,
 *     `file.deleted`), removes every reference it holds, and tells every OTHER
 *     application using one of its files `file.deleted`; the purge runs.
 *  3. An account's file it referenced stays `active`, now *not in use*.
 *  4. Idempotent: a second run finds nothing of it and queues nothing new.
 *  5. An application that is not `deleted` is never touched.
 *
 * The test database is shared with other files in this worker; assertions read
 * only what this file creates, and an enforce run may first clean somebody
 * else's leftovers (oldest first, ten a run), so the clean-up is run until this
 * file's application is reached.
 */

import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

const mockObjects = new Map<string, Buffer>();
const mockS3 = {
  uploadStream: jest.fn(),
  fileExists: jest.fn(async (key: string) => mockObjects.has(key)),
  copyFile: jest.fn(async (from: string, to: string) => {
    const bytes = mockObjects.get(from);
    if (!bytes) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    mockObjects.set(to, bytes);
  }),
  deleteFile: jest.fn(async (key: string) => {
    mockObjects.delete(key);
  }),
  listFiles: jest.fn(async (prefix: string) =>
    [...mockObjects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
  ),
};

const mockInvalidatedPaths: string[] = [];
jest.mock('../cdnInvalidation', () => ({
  ...jest.requireActual('../cdnInvalidation'),
  getCdnInvalidationQueue: () => ({
    enqueueDeletedKey: () => undefined,
    enqueuePath: (path: string) => mockInvalidatedPaths.push(path),
  }),
}));
jest.mock('../s3ServiceSingleton', () => ({ s3Service: mockS3 }));
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

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  applications,
  fileEventDeliveries,
  fileReferences,
  files,
  storageObjectDeletions,
  users,
} from '../../db/schema';
import { purgeDeletedApplicationContent } from '../applicationDeletion.service';
import { assetService } from '../assetServiceSingleton';
import { sealFileWebhookSecret } from '../fileEvents.service';
import { runFileLifecycleSweep } from '../fileLifecycle.worker';
import { addFileReferences } from '../fileRepository';

jest.setTimeout(60_000);

const noStorage = async () => ({
  applicationsWithFiles: 0,
  totalStoredBytes: 0,
  totalBytesAdded24h: 0,
  anomalies: [],
  published: [],
});

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function application(withWebhook = false): Promise<string> {
  const id = randomBytes(12).toString('hex');
  const owner = await account();
  await getDb()
    .insert(applications)
    .values({
      id,
      name: `Leftovers ${id.slice(0, 6)}`,
      type: 'third_party',
      ownerAccountId: owner,
      createdByUserId: owner,
      ...(withWebhook
        ? {
            filesWebhookUrl: 'https://receiver.example/files',
            filesWebhookSecretCiphertext: sealFileWebhookSecret(id, 'whsec_test'),
            filesWebhookVerifiedAt: new Date(),
          }
        : {}),
    });
  return id;
}

async function storedFile(
  owner: { ownerUserId?: string; ownerApplicationId?: string },
  status: 'active' | 'trash' | 'blocked' | 'deleted' = 'active',
) {
  const sha = randomBytes(32).toString('hex');
  const storageKey = `public/content/2026/10/${sha.slice(0, 2)}/${sha}.png`;
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: sha,
      size: 10,
      mime: 'image/png',
      ext: 'png',
      ownerUserId: owner.ownerUserId ?? null,
      ownerApplicationId: owner.ownerApplicationId ?? null,
      status,
      visibility: status === 'active' ? 'public' : 'private',
      storageKey: status === 'active' ? storageKey : storageKey.replace(/^public\//, ''),
      originalName: 'x.png',
      ...(status === 'trash' ? { trashedAt: new Date() } : {}),
    })
    .returning();
  mockObjects.set(row.storageKey, Buffer.from('x'));
  return row;
}

async function fileRow(id: string) {
  const [row] = await getDb()
    .select({ status: files.status, unreferencedSince: files.unreferencedSince })
    .from(files)
    .where(eq(files.id, id));
  return row;
}

async function referencesOf(applicationId: string) {
  return getDb()
    .select({ fileId: fileReferences.fileId })
    .from(fileReferences)
    .where(eq(fileReferences.applicationId, applicationId));
}

/**
 * An application deleted the old way — its row `deleted`, its content left —
 * and the world around it.
 */
async function scenario() {
  const appId = await application();
  const otherAppId = await application(true);
  const liveAppId = await application();
  const person = await account();

  const active = await storedFile({ ownerApplicationId: appId });
  const trashed = await storedFile({ ownerApplicationId: appId }, 'trash');
  const blocked = await storedFile({ ownerApplicationId: appId }, 'blocked');
  const alreadyGone = await storedFile({ ownerApplicationId: appId }, 'deleted');
  const personFile = await storedFile({ ownerUserId: person });
  const liveAppFile = await storedFile({ ownerApplicationId: liveAppId });

  await addFileReferences([
    { fileId: active.id, applicationId: appId, entityType: 'listing', entityId: 'l1' },
    { fileId: active.id, applicationId: otherAppId, entityType: 'post', entityId: 'p1' },
    { fileId: personFile.id, applicationId: appId, entityType: 'avatar', entityId: 'a1' },
    { fileId: liveAppFile.id, applicationId: liveAppId, entityType: 'tile', entityId: 't1' },
  ]);
  // Deleted before D8: the row only.
  await getDb().update(applications).set({ status: 'deleted' }).where(eq(applications.id, appId));
  // A second application deleted the old way that only HELD a reference.
  const referrerId = await application();
  await addFileReferences([
    { fileId: personFile.id, applicationId: referrerId, entityType: 'avatar', entityId: 'a2' },
  ]);
  await getDb()
    .update(applications)
    .set({ status: 'deleted' })
    .where(eq(applications.id, referrerId));

  return {
    appId,
    otherAppId,
    liveAppId,
    referrerId,
    active,
    trashed,
    blocked,
    alreadyGone,
    personFile,
    liveAppFile,
  };
}

type Report = NonNullable<Awaited<ReturnType<typeof runFileLifecycleSweep>>>;

async function sweep(mode: 'report' | 'enforce'): Promise<Report> {
  const report = await runFileLifecycleSweep({ mode, force: true, observeStorage: noStorage });
  if (!report) throw new Error('sweep was not claimed');
  return report;
}

/** Enforce until neither application is due any more (another file's leftovers go first). */
async function enforceUntilClean(applicationIds: string[]): Promise<Report[]> {
  const runs: Report[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const report = await sweep('enforce');
    runs.push(report);
    const pending = await getDb()
      .select({ id: files.id })
      .from(files)
      .where(
        and(
          inArray(files.ownerApplicationId, applicationIds),
          inArray(files.status, ['active', 'trash', 'blocked']),
        ),
      );
    const held = await getDb()
      .select({ id: fileReferences.id })
      .from(fileReferences)
      .where(inArray(fileReferences.applicationId, applicationIds));
    if (pending.length === 0 && held.length === 0) return runs;
  }
  throw new Error('the deleted applications were never cleaned');
}

beforeAll(async () => {
  process.env.DEVICE_ID_SALT ??= 'test-device-id-salt-that-is-long-enough-000';
  await connectPostgres();
});

afterAll(async () => {
  await assetService.settleStoragePurges();
  await closePostgres();
});

beforeEach(() => {
  mockInvalidatedPaths.length = 0;
});

describe('the deletedApplications step (ADR 0042 D8 for applications deleted before it)', () => {
  it('report names what is left and changes nothing; enforce runs D8; again is a no-op', async () => {
    const s = await scenario();

    // 1. Report.
    const report = await sweep('report');
    const step = report.counts.deletedApplications;
    expect(step.due).toBeGreaterThanOrEqual(2);
    expect(step.acted).toBe(0);
    expect(step.files).toBeGreaterThanOrEqual(3);
    expect(step.references).toBeGreaterThanOrEqual(3);
    expect(report.samples.deletedApplications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ applicationId: s.appId, files: 3, bytes: 30, references: 2 }),
        expect.objectContaining({ applicationId: s.referrerId, files: 0, references: 1 }),
      ]),
    );
    expect(report.samples.deletedApplications.some((x) => x.applicationId === s.liveAppId)).toBe(
      false,
    );
    for (const file of [s.active, s.trashed, s.blocked]) {
      expect((await fileRow(file.id)).status).toBe(file.status);
    }
    expect(await referencesOf(s.appId)).toHaveLength(2);

    // 2. Enforce.
    const runs = await enforceUntilClean([s.appId, s.referrerId]);
    expect(runs.some((run) => run.counts.deletedApplications.acted >= 1)).toBe(true);
    await assetService.settleStoragePurges();

    for (const file of [s.active, s.trashed, s.blocked]) {
      expect((await fileRow(file.id)).status).toBe('deleted');
    }
    const owed = await getDb()
      .select({
        accountId: storageObjectDeletions.accountId,
        reason: storageObjectDeletions.reason,
        sha256: storageObjectDeletions.sha256,
      })
      .from(storageObjectDeletions)
      .where(
        inArray(storageObjectDeletions.sha256, [
          s.active.sha256,
          s.trashed.sha256,
          s.blocked.sha256,
        ]),
      );
    expect(new Set(owed.map((row) => row.sha256))).toEqual(
      new Set([s.active.sha256, s.trashed.sha256, s.blocked.sha256]),
    );
    for (const row of owed) {
      expect(row).toMatchObject({ accountId: `app:${s.appId}`, reason: 'file.deleted' });
    }
    // The purge ran and the public file left the CDN.
    expect(mockObjects.has(s.active.storageKey)).toBe(false);
    expect(mockInvalidatedPaths).toContain(`/${s.active.id}`);

    // Its references are gone; the other application's stays.
    expect(await referencesOf(s.appId)).toHaveLength(0);
    expect(await referencesOf(s.referrerId)).toHaveLength(0);
    expect(await referencesOf(s.otherAppId)).toEqual([{ fileId: s.active.id }]);

    // 3. The person's file: active, not in use.
    const person = await fileRow(s.personFile.id);
    expect(person.status).toBe('active');
    expect(person.unreferencedSince).toBeInstanceOf(Date);
    expect(mockObjects.has(s.personFile.storageKey)).toBe(true);

    // The other application is told, with its own reference only; the deleted one is not.
    const events = await getDb()
      .select()
      .from(fileEventDeliveries)
      .where(inArray(fileEventDeliveries.applicationId, [s.appId, s.otherAppId]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ applicationId: s.otherAppId, type: 'file.deleted' });
    expect(events[0].payload).toMatchObject({
      file: { id: s.active.id, ownerKind: 'application', status: 'deleted' },
      references: [{ entityType: 'post', entityId: 'p1' }],
    });

    // 5. The active application is untouched.
    expect((await fileRow(s.liveAppFile.id)).status).toBe('active');
    expect(await referencesOf(s.liveAppId)).toHaveLength(1);

    // 4. Again: nothing of it is due, nothing new is queued.
    const again = await sweep('enforce');
    expect(again.samples.deletedApplications.some((x) => x.applicationId === s.appId)).toBe(false);
    expect(
      await getDb()
        .select({ id: fileEventDeliveries.id })
        .from(fileEventDeliveries)
        .where(eq(fileEventDeliveries.applicationId, s.otherAppId)),
    ).toHaveLength(1);
    expect((await fileRow(s.alreadyGone.id)).status).toBe('deleted');
  });

  it('runs only on an application that is still deleted, and is idempotent', async () => {
    const live = await application();
    const file = await storedFile({ ownerApplicationId: live });

    expect(await purgeDeletedApplicationContent(live)).toBeNull();
    expect(await purgeDeletedApplicationContent('000000000000000000000000')).toBeNull();
    expect((await fileRow(file.id)).status).toBe('active');

    await getDb().update(applications).set({ status: 'deleted' }).where(eq(applications.id, live));
    const first = await purgeDeletedApplicationContent(live);
    expect(first?.files.map((f) => f.id)).toEqual([file.id]);
    expect(first?.ledgerIds.length).toBeGreaterThan(0);
    const second = await purgeDeletedApplicationContent(live);
    expect(second).toMatchObject({ files: [], referencesRemoved: 0, ledgerIds: [] });
  });
});
