/**
 * Deleting an application deletes its files, now (ADR 0042 D8) — through
 * `DELETE /applications/:appId` and through an account's archive, against a
 * REAL Postgres. The object store is an in-memory map; the CDN invalidation
 * queue is a recorder.
 *
 * Invariants:
 *  1. The body's `confirmName` must be the application's current name
 *     (trimmed, case-sensitive); otherwise 400 and NOTHING changes.
 *  2. In the delete's own commit: every file the application owns is
 *     tombstoned and owed its purge (`storage_object_deletions`, `app:<id>`,
 *     `file.deleted`) — no trash — and every reference it registered is gone.
 *  3. An account's file the application used is untouched: still `active`,
 *     now *not in use*.
 *  4. The purge runs: the application's public objects leave the bucket and the
 *     CDN paths are invalidated; bytes another owner still holds are kept.
 *  5. Every OTHER application using one of its files is told `file.deleted`,
 *     with only its own references; the deleted application is told nothing.
 *  6. An account's archive deletes its applications the same way first.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
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
const mockInvalidatedKeys: string[] = [];
jest.mock('../../services/cdnInvalidation', () => {
  const actual = jest.requireActual('../../services/cdnInvalidation');
  return {
    ...actual,
    getCdnInvalidationQueue: () => ({
      enqueueDeletedKey: (key: string) => mockInvalidatedKeys.push(key),
      enqueuePath: (path: string) => mockInvalidatedPaths.push(path),
    }),
  };
});

const accountServiceMock = {
  resolveEffectiveAccess: jest.fn(async (userId: string, accountId: string) =>
    userId === accountId
      ? {
          role: 'owner',
          permissions: jest
            .requireActual('../../utils/accountRoles')
            .permissionsForAccountRole('owner'),
          source: 'self',
          membership: null,
        }
      : null,
  ),
  listAccessibleAccounts: jest.fn(async (userId: string) => [
    { accountId: userId, relationship: 'self', callerMembership: null },
  ]),
};
jest.mock('../../services/account.service', () => ({
  __esModule: true,
  accountService: accountServiceMock,
}));

let mockCurrentUserId = '';
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { _id: { toString: () => mockCurrentUserId }, isStaff: false };
    next();
  },
}));
jest.mock('../../config/dynamicOriginRegistry', () => ({
  __esModule: true,
  refreshOriginRegistry: async () => {},
}));
jest.mock('../../services/s3ServiceSingleton', () => ({ s3Service: mockS3 }));
jest.mock('../../services/variantService', () => ({
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
  fileVariants,
  files,
  storageObjectDeletions,
  users,
} from '../../db/schema';
import applicationsRouter from '../applications';
import { errorHandler } from '../../middleware/errorHandler';
import { assetService } from '../../services/assetServiceSingleton';
import { addFileReferences } from '../../services/fileRepository';
import { sealFileWebhookSecret } from '../../services/fileEvents.service';

jest.setTimeout(60_000);

let server: http.Server;

function request(
  method: string,
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? '' : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
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
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function account(kind?: 'channel'): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [row] = await getDb()
    .insert(users)
    .values({
      username: `u-${suffix}`,
      ...(kind ? { kind } : {}),
    } as typeof users.$inferInsert)
    .returning({ id: users.id });
  return row.id;
}

async function application(ownerAccountId: string, withWebhook = false): Promise<string> {
  const id = randomBytes(12).toString('hex');
  await getDb()
    .insert(applications)
    .values({
      id,
      name: `Photos ${id.slice(0, 6)}`,
      type: 'third_party',
      ownerAccountId,
      createdByUserId: ownerAccountId,
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

/** A public file row with its object (and one rendition) in the bucket. */
async function storedFile(
  owner: { ownerUserId?: string; ownerApplicationId?: string },
  sha = randomBytes(32).toString('hex'),
) {
  const storageKey = `public/content/2026/10/${sha.slice(0, 2)}/${sha}.png`;
  const variantKey = `public/variants/2026/10/${sha.slice(0, 2)}/${sha}/thumb.webp`;
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: sha,
      size: 10,
      mime: 'image/png',
      ext: 'png',
      ownerUserId: owner.ownerUserId ?? null,
      ownerApplicationId: owner.ownerApplicationId ?? null,
      status: 'active',
      visibility: 'public',
      storageKey,
      originalName: 'x.png',
    })
    .returning();
  await getDb()
    .insert(fileVariants)
    .values({ fileId: row.id, type: 'thumb', key: variantKey, width: 10, height: 10 });
  mockObjects.set(storageKey, Buffer.from('x'));
  mockObjects.set(variantKey, Buffer.from('v'));
  return { ...row, variantKey };
}

async function statusOf(fileId: string) {
  const [row] = await getDb()
    .select({ status: files.status, unreferencedSince: files.unreferencedSince })
    .from(files)
    .where(eq(files.id, fileId));
  return row;
}

/** The developer's application, its two files, the uses around them. */
async function scenario() {
  const developer = await account();
  const appId = await application(developer, true);
  const otherAppId = await application(await account(), true);
  const person = await account();

  const used = await storedFile({ ownerApplicationId: appId });
  const unused = await storedFile({ ownerApplicationId: appId });
  // A person's file with the SAME bytes as `unused`: the purge must keep them.
  const sharedBytes = await storedFile({ ownerUserId: person }, unused.sha256);
  // A person's file the application used.
  const personFile = await storedFile({ ownerUserId: person });

  await addFileReferences([
    { fileId: used.id, applicationId: appId, entityType: 'listing', entityId: 'l1' },
    { fileId: used.id, applicationId: otherAppId, entityType: 'post', entityId: 'p1' },
    { fileId: personFile.id, applicationId: appId, entityType: 'avatar', entityId: 'a1' },
  ]);
  return { developer, appId, otherAppId, person, used, unused, sharedBytes, personFile };
}

beforeAll(async () => {
  process.env.DEVICE_ID_SALT ??= 'test-device-id-salt-that-is-long-enough-000';
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/applications', applicationsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await closePostgres();
});

beforeEach(() => {
  mockInvalidatedPaths.length = 0;
  mockInvalidatedKeys.length = 0;
});

describe('DELETE /applications/:appId (ADR 0042 D8)', () => {
  it('refuses a name that is not exactly the current one, and changes nothing', async () => {
    const s = await scenario();
    mockCurrentUserId = s.developer;
    const [app] = await getDb()
      .select({ name: applications.name })
      .from(applications)
      .where(eq(applications.id, s.appId));

    for (const payload of [
      undefined,
      {},
      { confirmName: app.name.toLowerCase() },
      { confirmName: app.name.slice(0, -1) },
    ]) {
      const res = await request('DELETE', `/applications/${s.appId}`, payload);
      expect(res.status).toBe(400);
    }
    const mismatch = await request('DELETE', `/applications/${s.appId}`, {
      confirmName: 'Someone else',
    });
    expect(mismatch.body.error).toBe('CONFIRM_NAME_MISMATCH');

    const [after] = await getDb()
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.id, s.appId));
    expect(after.status).toBe('active');
    expect((await statusOf(s.used.id)).status).toBe('active');
    expect((await statusOf(s.unused.id)).status).toBe('active');
    const refs = await getDb()
      .select({ id: fileReferences.id })
      .from(fileReferences)
      .where(eq(fileReferences.applicationId, s.appId));
    expect(refs).toHaveLength(2);
  });

  it('deletes every file it owns and every reference it holds, in one commit, and purges', async () => {
    const s = await scenario();
    mockCurrentUserId = s.developer;
    const [app] = await getDb()
      .select({ name: applications.name })
      .from(applications)
      .where(eq(applications.id, s.appId));

    const res = await request('DELETE', `/applications/${s.appId}`, {
      confirmName: `  ${app.name} `,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, filesDeleted: 2, referencesRemoved: 2 });
    await assetService.settleStoragePurges();

    const [after] = await getDb()
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.id, s.appId));
    expect(after.status).toBe('deleted');

    // 2. Tombstoned — not trashed — and owed under the application's ledger owner.
    expect((await statusOf(s.used.id)).status).toBe('deleted');
    expect((await statusOf(s.unused.id)).status).toBe('deleted');
    const owed = await getDb()
      .select({
        accountId: storageObjectDeletions.accountId,
        reason: storageObjectDeletions.reason,
        kind: storageObjectDeletions.kind,
        target: storageObjectDeletions.target,
        outcome: storageObjectDeletions.outcome,
      })
      .from(storageObjectDeletions)
      .where(inArray(storageObjectDeletions.sha256, [s.used.sha256, s.unused.sha256]));
    expect(owed.length).toBeGreaterThanOrEqual(4);
    for (const row of owed) {
      expect(row.accountId).toBe(`app:${s.appId}`);
      expect(row.reason).toBe('file.deleted');
    }
    expect(owed.map((row) => `${row.kind}:${row.target}`)).toEqual(
      expect.arrayContaining([
        `object:${s.used.storageKey.replace(/^public\//, '')}`,
        `object:${s.unused.storageKey.replace(/^public\//, '')}`,
      ]),
    );

    // 4. The purge ran: the application's objects are gone, shared bytes kept.
    expect(mockObjects.has(s.used.storageKey)).toBe(false);
    expect(mockObjects.has(s.used.variantKey)).toBe(false);
    expect(mockObjects.has(s.sharedBytes.storageKey)).toBe(true);
    expect(owed.find((row) => row.target.endsWith(`${s.unused.sha256}.png`))?.outcome).toBe(
      'retained_shared',
    );
    expect(mockInvalidatedPaths).toEqual(
      expect.arrayContaining([`/${s.used.id}`, `/${s.unused.id}`]),
    );
    expect(mockInvalidatedKeys).toEqual(expect.arrayContaining([s.used.storageKey]));

    // 2./3. Its references are gone; the person's file is untouched, not in use.
    const refs = await getDb()
      .select({ applicationId: fileReferences.applicationId })
      .from(fileReferences)
      .where(inArray(fileReferences.fileId, [s.used.id, s.personFile.id]));
    expect(refs.map((row) => row.applicationId)).toEqual([s.otherAppId]);
    const person = await statusOf(s.personFile.id);
    expect(person.status).toBe('active');
    expect(person.unreferencedSince).not.toBeNull();
    expect(mockObjects.has(s.personFile.storageKey)).toBe(true);
    expect((await statusOf(s.sharedBytes.id)).status).toBe('active');

    // 5. The other application is told, with only its own reference; the deleted one is not.
    const events = await getDb()
      .select()
      .from(fileEventDeliveries)
      .where(inArray(fileEventDeliveries.applicationId, [s.appId, s.otherAppId]));
    expect(events).toHaveLength(1);
    expect(events[0].applicationId).toBe(s.otherAppId);
    expect(events[0].type).toBe('file.deleted');
    expect(events[0].payload).toMatchObject({
      type: 'file.deleted',
      file: { id: s.used.id, ownerKind: 'application', status: 'deleted', visibility: 'public' },
      references: [{ entityType: 'post', entityId: 'p1' }],
    });

    // A second delete finds nothing.
    const again = await request('DELETE', `/applications/${s.appId}`, { confirmName: app.name });
    expect(again.status).toBe(404);
  });

  it('nothing can be referenced for, or uploaded by, a deleted application afterwards', async () => {
    const s = await scenario();
    mockCurrentUserId = s.developer;
    const [app] = await getDb()
      .select({ name: applications.name })
      .from(applications)
      .where(eq(applications.id, s.appId));
    expect(
      (await request('DELETE', `/applications/${s.appId}`, { confirmName: app.name })).status,
    ).toBe(200);

    const added = await addFileReferences([
      { fileId: s.personFile.id, applicationId: s.appId, entityType: 'avatar', entityId: 'late' },
    ]);
    expect(added.created).toBe(0);
    const { insertFile } = jest.requireActual('../../services/fileRepository');
    await expect(
      insertFile({
        sha256: randomBytes(32).toString('hex'),
        size: 1,
        mime: 'image/png',
        ext: 'png',
        ownerUserId: null,
        systemOwner: null,
        ownerApplicationId: s.appId,
        storageKey: 'content/late.png',
        visibility: 'public',
      }),
    ).rejects.toThrow('This application was deleted');
  });
});

describe("an account's archive deletes its applications first (ADR 0042 D8)", () => {
  it('tombstones the application, its files and references, and removes the rows', async () => {
    const { accountService: realAccountService } = jest.requireActual(
      '../../services/account.service',
    );
    const channel = await account('channel');
    const appId = await application(channel);
    const owned = await storedFile({ ownerApplicationId: appId });
    const person = await account();
    const personFile = await storedFile({ ownerUserId: person });
    await addFileReferences([
      { fileId: personFile.id, applicationId: appId, entityType: 'avatar', entityId: 'a' },
    ]);

    await realAccountService.archiveAccount(channel);
    await assetService.settleStoragePurges();

    const [after] = await getDb()
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.id, appId));
    expect(after.status).toBe('deleted');
    expect(await getDb().select().from(files).where(eq(files.id, owned.id))).toHaveLength(0);
    const owed = await getDb()
      .select({ accountId: storageObjectDeletions.accountId })
      .from(storageObjectDeletions)
      .where(
        and(
          eq(storageObjectDeletions.sha256, owned.sha256),
          eq(storageObjectDeletions.accountId, `app:${appId}`),
        ),
      );
    expect(owed.length).toBeGreaterThan(0);
    expect(
      await getDb().select().from(fileReferences).where(eq(fileReferences.applicationId, appId)),
    ).toHaveLength(0);
    expect((await statusOf(personFile.id)).status).toBe('active');
    expect((await statusOf(personFile.id)).unreferencedSince).not.toBeNull();
  });
});

describe("an account's archive tells the applications using its files (ADR 0042 D9, stage 4b)", () => {
  it('queues exactly one file.deleted per (file, subscribed application), never to its own deleted application', async () => {
    const { accountService: realAccountService } = jest.requireActual(
      '../../services/account.service',
    );
    const channel = await account('channel');
    const ownApp = await application(channel, true);
    const subscribed = await application(await account(), true);
    const unsubscribed = await application(await account(), false);
    const photo = await storedFile({ ownerUserId: channel });
    await addFileReferences([
      { fileId: photo.id, applicationId: ownApp, entityType: 'banner', entityId: 'b' },
      { fileId: photo.id, applicationId: subscribed, entityType: 'post', entityId: 'p1' },
      { fileId: photo.id, applicationId: subscribed, entityType: 'post', entityId: 'p2' },
      { fileId: photo.id, applicationId: unsubscribed, entityType: 'post', entityId: 'p3' },
    ]);

    await realAccountService.archiveAccount(channel);

    expect(await getDb().select().from(files).where(eq(files.id, photo.id))).toHaveLength(0);
    const deliveries = await getDb()
      .select({
        applicationId: fileEventDeliveries.applicationId,
        type: fileEventDeliveries.type,
        payload: fileEventDeliveries.payload,
      })
      .from(fileEventDeliveries)
      .where(eq(fileEventDeliveries.fileId, photo.id));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      applicationId: subscribed,
      type: 'file.deleted',
      payload: {
        type: 'file.deleted',
        file: { id: photo.id, ownerKind: 'account', status: 'deleted', visibility: 'public' },
      },
    });
    expect(
      (deliveries[0].payload as { references: unknown[] }).references.sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    ).toEqual([
      { entityType: 'post', entityId: 'p1' },
      { entityType: 'post', entityId: 'p2' },
    ]);
    // The account is never named.
    expect(JSON.stringify(deliveries[0].payload)).not.toContain(channel);
  });
});
