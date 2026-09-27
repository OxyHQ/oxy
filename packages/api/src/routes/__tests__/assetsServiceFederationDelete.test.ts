/**
 * `DELETE /assets/service/federation/:id` and `POST /assets/service/federation/delete`
 * — end to end over real `node:http`, the REAL AssetService and a REAL Postgres.
 *
 * Only three things are stubbed: the service-token middleware (so a case can set
 * the verified `serviceApp`), the rate limiter, and S3 (a recording fake). The
 * authorization decision lives in one conditional `UPDATE`, so it is exercised
 * against real rows: the owner's `users.type`, the row's `metadata`, `purpose`,
 * `status`, and every table that can hold a file id.
 *
 * Invariants:
 *  1. The uploading app deletes its own federated media: the row is tombstoned
 *     and its storage (original, variant directory incl. HLS segments) recorded
 *     in `storage_object_deletions` in the same transaction, then purged.
 *  2. Never a local user's asset, never another app's upload, never a cache
 *     object, never a row the federation upload path did not write — 403 (or
 *     `forbidden` in a batch), the row untouched and ZERO storage calls.
 *  3. Never an asset ANOTHER account holds (a link it created, a mail
 *     attachment, a listing screenshot) — 200 `in_use`, kept, nothing owed.
 *  4. A purge that fails stays owed: the ledger row is pending and the
 *     storage-deletion worker finishes it later.
 *  5. Idempotent: unknown and already-deleted ids are 200 `not_found`.
 *  6. Both scopes are required, and the app id comes from the token only.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const mockServiceAuthMiddleware = jest.fn();

const mockS3 = {
  deleteFile: jest.fn(),
  fileExists: jest.fn(),
  listFiles: jest.fn(),
};

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(401).json({ error: 'session auth not under test' }),
  serviceAuthMiddleware: (...args: unknown[]) => mockServiceAuthMiddleware(...args),
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../services/s3ServiceSingleton', () => ({
  s3Service: mockS3,
}));

jest.mock('../../services/variantService', () => ({
  VariantService: class {
    generateVariants = jest.fn(() => Promise.resolve());
  },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  appCategories,
  appListings,
  appListingScreenshots,
  applications,
  fileLinks,
  files,
  fileVariants,
  mailboxes,
  messageAttachments,
  messages,
  storageObjectDeletions,
  users,
} from '../../db/schema';
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import fileCache from '../../utils/fileCache';
import { assetService } from '../../services/assetServiceSingleton';
import { runStorageDeletionBatch } from '../../services/accountStorageDeletion.worker';

const APP_ID = `app-mention-${randomBytes(4).toString('hex')}`;
const OTHER_APP_ID = `app-other-${randomBytes(4).toString('hex')}`;

interface JsonResponse {
  status: number;
  body: Record<string, unknown> & {
    data?: { id?: string; result?: string; results?: Array<{ id: string; result: string }> };
  };
}

let server: http.Server;

function request(method: string, path: string, payload?: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: body
          ? { 'content-type': 'application/json', 'content-length': String(body.length) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Issue a request and wait for the background purge it started. */
async function call(method: string, path: string, payload?: unknown): Promise<JsonResponse> {
  const res = await request(method, path, payload);
  await assetService.settleStoragePurges();
  return res;
}

function actAs(appId: string, scopes: string[] = ['files:write', 'federation:write']): void {
  mockServiceAuthMiddleware.mockImplementation(
    (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
      req.serviceApp = {
        type: 'service',
        appId,
        appName: 'test-app',
        credentialId: 'cred-1',
        ownerAccountId: 'acct-1',
        environment: 'production',
        scopes,
      };
      next();
    },
  );
}

async function insertUser(type: 'federated' | 'local'): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal', type }).returning({ id: users.id });
  return row.id;
}

interface FixtureOptions {
  ownerUserId?: string | null;
  systemOwner?: '__federation_media_cache__' | null;
  purpose?: 'user' | 'federation-media-cache';
  status?: 'active' | 'trash' | 'deleted';
  metadata?: Record<string, unknown>;
  variantTypes?: string[];
}

/** A files row plus its variants; returns the id and the keys it owns. */
async function insertFile(options: FixtureOptions) {
  const sha256 = randomBytes(32).toString('hex');
  const storageKey = `public/files/${sha256}.mp4`;
  const variantDir = `variants/2026/09/${sha256.slice(0, 2)}/${sha256}/`;
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256,
      size: 10,
      mime: 'video/mp4',
      ext: 'mp4',
      storageKey,
      ownerUserId: options.ownerUserId ?? null,
      systemOwner: options.systemOwner ?? null,
      purpose: options.purpose ?? 'user',
      status: options.status ?? 'active',
      visibility: 'public',
      metadata: options.metadata ?? { source: 'federation', serviceAppId: APP_ID },
    })
    .returning({ id: files.id });
  const variantKeys = (options.variantTypes ?? []).map((type) => `public/${variantDir}${type}`);
  if (variantKeys.length > 0) {
    await getDb()
      .insert(fileVariants)
      .values(variantKeys.map((key, i) => ({ fileId: row.id, type: `v${i}`, key, readyAt: new Date() })));
  }
  return { id: row.id, sha256, storageKey, variantDir, variantKeys };
}

async function statusOf(id: string): Promise<string | undefined> {
  const [row] = await getDb().select({ status: files.status }).from(files).where(eq(files.id, id));
  return row?.status;
}

async function ledgerFor(sha256: string) {
  return getDb()
    .select({
      kind: storageObjectDeletions.kind,
      target: storageObjectDeletions.target,
      reason: storageObjectDeletions.reason,
      outcome: storageObjectDeletions.outcome,
      completedAt: storageObjectDeletions.completedAt,
      lastError: storageObjectDeletions.lastError,
    })
    .from(storageObjectDeletions)
    .where(eq(storageObjectDeletions.sha256, sha256));
}

let federatedOwner: string;
let localOwner: string;
let otherLocal: string;
const createdIds: string[] = [];

beforeAll((done) => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/assets', assetsRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});

beforeAll(async () => {
  await connectPostgres();
  federatedOwner = await insertUser('federated');
  localOwner = await insertUser('local');
  otherLocal = await insertUser('local');
});

afterAll(async () => {
  await assetService.settleStoragePurges();
  await closePostgres();
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  fileCache.clear();
  actAs(APP_ID);
  mockS3.deleteFile.mockResolvedValue(undefined);
  mockS3.fileExists.mockResolvedValue(false);
  mockS3.listFiles.mockResolvedValue([]);
});

async function fixture(options: FixtureOptions) {
  const created = await insertFile(options);
  createdIds.push(created.id);
  return created;
}

const listing = (keys: string[]) => keys.map((key) => ({ key, size: 1, lastModified: new Date(), bucket: 'b' }));

describe('DELETE /assets/service/federation/:id — the uploading app deletes its federated media', () => {
  it('tombstones the row, records its storage in the same commit, and purges original, variants and HLS segments', async () => {
    const file = await fixture({ ownerUserId: federatedOwner, variantTypes: ['poster.jpg', 'hls_720p.m3u8', 'hls_master.m3u8'] });
    const publicDir = `public/${file.variantDir}`;
    const dirObjects = [
      ...file.variantKeys,
      `${publicDir}hls_720p_segment_720p_000.ts.ts`,
      `${publicDir}hls_720p_segment_720p_001.ts.ts`,
    ];
    let listed = false;
    mockS3.listFiles.mockImplementation(async (prefix: string) => {
      if (prefix === publicDir && !listed) {
        listed = true;
        return listing(dirObjects);
      }
      return [];
    });

    const res = await call('DELETE', `/assets/service/federation/${file.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: file.id, result: 'deleted' });
    expect(await statusOf(file.id)).toBe('deleted');

    // Owed in the ledger — the original and the WHOLE variant directory — and done.
    const ledger = await ledgerFor(file.sha256);
    expect(ledger.map(({ kind, target }) => ({ kind, target })).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: 'object', target: `files/${file.sha256}.mp4` },
      { kind: 'prefix', target: file.variantDir },
    ]);
    expect(ledger.every((row) => row.reason === 'file.deleted' && row.outcome === 'deleted')).toBe(true);

    const deletedKeys = mockS3.deleteFile.mock.calls.map(([k]) => k);
    expect(deletedKeys).toEqual(expect.arrayContaining([file.storageKey, ...dirObjects]));

    expect(logger.info).toHaveBeenCalledWith(
      'Audit: federated media delete',
      expect.objectContaining({ event: 'federated_media_delete', appId: APP_ID, fileId: file.id, result: 'deleted' }),
    );
  });

  it('deletes a trashed row too — trash still holds bytes', async () => {
    const file = await fixture({ ownerUserId: federatedOwner, status: 'trash' });

    const res = await call('DELETE', `/assets/service/federation/${file.id}`);

    expect(res.body.data?.result).toBe('deleted');
    expect(await statusOf(file.id)).toBe('deleted');
  });

  it('a link the OWNER created does not block the delete', async () => {
    const file = await fixture({ ownerUserId: federatedOwner });
    await getDb().insert(fileLinks).values({
      fileId: file.id, app: 'mention', entityType: 'post', entityId: randomUUID(), createdBy: federatedOwner,
    });

    const res = await call('DELETE', `/assets/service/federation/${file.id}`);

    expect(res.body.data?.result).toBe('deleted');
  });

  it('is idempotent: a second delete, an already-deleted row and an unknown id are 200 not_found and owe nothing', async () => {
    const file = await fixture({ ownerUserId: federatedOwner });
    expect((await call('DELETE', `/assets/service/federation/${file.id}`)).body.data?.result).toBe('deleted');
    mockS3.deleteFile.mockClear();

    const again = await call('DELETE', `/assets/service/federation/${file.id}`);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ id: file.id, result: 'not_found' });

    const tombstone = await fixture({ ownerUserId: federatedOwner, status: 'deleted' });
    const deleted = await call('DELETE', `/assets/service/federation/${tombstone.id}`);
    expect(deleted.body.data?.result).toBe('not_found');
    expect(await ledgerFor(tombstone.sha256)).toEqual([]);

    const unknown = await call('DELETE', '/assets/service/federation/0190aaaa-0000-7000-8000-000000000000');
    expect(unknown.body.data?.result).toBe('not_found');

    expect(mockS3.deleteFile).not.toHaveBeenCalled();
  });

  it('a purge that fails stays OWED: the worker finishes it later', async () => {
    const file = await fixture({ ownerUserId: federatedOwner });
    mockS3.deleteFile.mockRejectedValue(new Error('S3 unavailable'));

    const res = await call('DELETE', `/assets/service/federation/${file.id}`);

    // The delete itself succeeded — nothing serves a tombstone …
    expect(res.status).toBe(200);
    expect(res.body.data?.result).toBe('deleted');
    expect(await statusOf(file.id)).toBe('deleted');
    // … and the storage is still owed, with the failure recorded.
    const pending = await ledgerFor(file.sha256);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((row) => row.completedAt === null && row.lastError !== null)).toBe(true);

    // S3 recovers; the storage-deletion worker's next pass finishes the job.
    mockS3.deleteFile.mockReset().mockResolvedValue(undefined);
    await getDb()
      .update(storageObjectDeletions)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(storageObjectDeletions.sha256, file.sha256));
    await runStorageDeletionBatch({
      ownerId: 'test-worker',
      store: {
        deleteObject: (key) => mockS3.deleteFile(key),
        listKeys: async () => [],
      },
    });

    const done = await ledgerFor(file.sha256);
    expect(done.every((row) => row.outcome === 'deleted')).toBe(true);
    expect(mockS3.deleteFile).toHaveBeenCalledWith(file.storageKey);
  });
});

describe('DELETE /assets/service/federation/:id — another account holds it (in_use)', () => {
  async function expectKept(file: { id: string; sha256: string }) {
    const res = await call('DELETE', `/assets/service/federation/${file.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: file.id, result: 'in_use' });
    expect(await statusOf(file.id)).toBe('active');
    expect(await ledgerFor(file.sha256)).toEqual([]);
    expect(mockS3.deleteFile).not.toHaveBeenCalled();
  }

  it('keeps an asset a LOCAL user linked (dedup handed them the federated row)', async () => {
    const file = await fixture({ ownerUserId: federatedOwner });
    await getDb().insert(fileLinks).values({
      fileId: file.id, app: 'mention', entityType: 'avatar', entityId: randomUUID(), createdBy: otherLocal,
    });
    await expectKept(file);
  });

  it("keeps an asset attached to a message in somebody's mailbox", async () => {
    const file = await fixture({ ownerUserId: federatedOwner });
    const [mailbox] = await getDb()
      .insert(mailboxes)
      .values({ userId: otherLocal, name: 'Inbox', path: `Inbox-${randomUUID()}` })
      .returning({ id: mailboxes.id });
    const [message] = await getDb()
      .insert(messages)
      .values({
        userId: otherLocal,
        mailboxId: mailbox!.id,
        messageId: `<${randomUUID()}@example.test>`,
        fromAddress: 'a@example.test',
        subject: 'A file',
        size: 10,
        date: new Date(),
      })
      .returning({ id: messages.id });
    await getDb().insert(messageAttachments).values({
      messageId: message!.id, ord: 0, fileId: file.id, name: 'x.mp4', contentType: 'video/mp4', size: 10,
    });
    await expectKept(file);
  });

  it('keeps an asset used as an app listing screenshot', async () => {
    const file = await fixture({ ownerUserId: federatedOwner });
    const [app] = await getDb()
      .insert(applications)
      .values({ name: `App ${randomUUID().slice(0, 8)}`, ownerAccountId: otherLocal })
      .returning({ id: applications.id });
    const [category] = await getDb()
      .insert(appCategories)
      .values({ slug: `cat-${randomUUID().slice(0, 8)}`, label: 'Tools' })
      .returning({ id: appCategories.id });
    const [listingRow] = await getDb()
      .insert(appListings)
      .values({ applicationId: app!.id, slug: `listing-${randomUUID().slice(0, 8)}`, categoryId: category!.id })
      .returning({ id: appListings.id });
    await getDb().insert(appListingScreenshots).values({ listingId: listingRow!.id, fileId: file.id });
    await expectKept(file);
  });

  it('answers forbidden, not in_use, for a held asset that is not this app’s — no oracle', async () => {
    const file = await fixture({
      ownerUserId: federatedOwner,
      metadata: { source: 'federation', serviceAppId: OTHER_APP_ID },
    });
    await getDb().insert(fileLinks).values({
      fileId: file.id, app: 'mention', entityType: 'post', entityId: randomUUID(), createdBy: otherLocal,
    });

    const res = await call('DELETE', `/assets/service/federation/${file.id}`);
    expect(res.status).toBe(403);
  });
});

describe('DELETE /assets/service/federation/:id — strict authorization (negative cases)', () => {
  const refusals: Array<[string, () => Promise<{ id: string; sha256: string }>]> = [
    [
      "a LOCAL user's asset, even with federation metadata naming this app",
      () => fixture({ ownerUserId: localOwner }),
    ],
    [
      'federated media uploaded by ANOTHER application',
      () => fixture({ ownerUserId: federatedOwner, metadata: { source: 'federation', serviceAppId: OTHER_APP_ID } }),
    ],
    [
      'a federated-owned row with no uploader recorded',
      () => fixture({ ownerUserId: federatedOwner, metadata: { source: 'federation' } }),
    ],
    [
      'a federated-owned row the federation upload path did not write',
      () => fixture({ ownerUserId: federatedOwner, metadata: { source: 'mention-service', serviceAppId: APP_ID } }),
    ],
    [
      'a federated-owned row with no metadata at all',
      () => fixture({ ownerUserId: federatedOwner, metadata: {} }),
    ],
    [
      'a federated-owned row still in the cache purpose',
      () => fixture({ ownerUserId: federatedOwner, purpose: 'federation-media-cache' }),
    ],
    [
      'a media-cache object (its own eviction route owns it)',
      () =>
        fixture({
          ownerUserId: null,
          systemOwner: '__federation_media_cache__',
          purpose: 'federation-media-cache',
        }),
    ],
  ];

  it.each(refusals)('refuses %s: 403, row untouched, nothing owed, zero storage calls', async (_label, make) => {
    const file = await make();

    const res = await call('DELETE', `/assets/service/federation/${file.id}`);

    expect(res.status).toBe(403);
    expect(await statusOf(file.id)).not.toBe('deleted');
    expect(await ledgerFor(file.sha256)).toEqual([]);
    expect(mockS3.deleteFile).not.toHaveBeenCalled();
    expect(mockS3.listFiles).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Audit: federated media delete refused',
      expect.objectContaining({ fileId: file.id, result: 'forbidden', appId: APP_ID }),
    );
  });

  it.each([
    ['files:write missing', ['federation:write']],
    ['federation:write missing', ['files:write']],
    ['no scopes', []],
  ])('requires both scopes (%s): 403 and nothing deleted', async (_label, scopes) => {
    const file = await fixture({ ownerUserId: federatedOwner });
    actAs(APP_ID, scopes);

    const res = await call('DELETE', `/assets/service/federation/${file.id}`);

    expect(res.status).toBe(403);
    expect(await statusOf(file.id)).toBe('active');
    expect(mockS3.deleteFile).not.toHaveBeenCalled();
  });

  it('takes the application id from the token only — a query or body naming the uploader changes nothing', async () => {
    const file = await fixture({ ownerUserId: federatedOwner });
    actAs(OTHER_APP_ID);

    const res = await call('DELETE', `/assets/service/federation/${file.id}?appId=${APP_ID}`, {
      appId: APP_ID,
      serviceAppId: APP_ID,
    });

    expect(res.status).toBe(403);
    expect(await statusOf(file.id)).toBe('active');
  });
});

describe('POST /assets/service/federation/delete — batch', () => {
  it('returns one result per distinct id, in order, deleting only what qualifies', async () => {
    const mine = await fixture({ ownerUserId: federatedOwner });
    const held = await fixture({ ownerUserId: federatedOwner });
    await getDb().insert(fileLinks).values({
      fileId: held.id, app: 'mention', entityType: 'post', entityId: randomUUID(), createdBy: otherLocal,
    });
    const local = await fixture({ ownerUserId: localOwner });
    const theirs = await fixture({
      ownerUserId: federatedOwner,
      metadata: { source: 'federation', serviceAppId: OTHER_APP_ID },
    });
    const unknown = '0190bbbb-0000-7000-8000-000000000000';

    const res = await call('POST', '/assets/service/federation/delete', {
      ids: [mine.id, held.id, local.id, mine.id, theirs.id, unknown],
    });

    expect(res.status).toBe(200);
    expect(res.body.data?.results).toEqual([
      { id: mine.id, result: 'deleted' },
      { id: held.id, result: 'in_use' },
      { id: local.id, result: 'forbidden' },
      { id: theirs.id, result: 'forbidden' },
      { id: unknown, result: 'not_found' },
    ]);
    expect(await statusOf(mine.id)).toBe('deleted');
    for (const kept of [held, local, theirs]) {
      expect(await statusOf(kept.id)).toBe('active');
    }
    // Storage was touched for the one qualifying row only (both key spellings).
    expect([...new Set(mockS3.deleteFile.mock.calls.map(([k]) => k))].sort()).toEqual(
      [`files/${mine.sha256}.mp4`, mine.storageKey].sort(),
    );
  });

  it.each([
    ['an empty list', { ids: [] }],
    ['more than 20 ids', { ids: Array.from({ length: 21 }, (_, i) => `id-${i}`) }],
    ['a missing ids field', {}],
    ['an unknown field', { ids: ['x'], appId: 'forged' }],
    ['a non-string id', { ids: [42] }],
  ])('rejects %s with 400', async (_label, payload) => {
    const res = await call('POST', '/assets/service/federation/delete', payload);
    expect(res.status).toBe(400);
    expect(mockS3.deleteFile).not.toHaveBeenCalled();
  });

  it('requires both scopes', async () => {
    const file = await fixture({ ownerUserId: federatedOwner });
    actAs(APP_ID, ['files:write']);

    const res = await call('POST', '/assets/service/federation/delete', { ids: [file.id] });

    expect(res.status).toBe(403);
    expect(await statusOf(file.id)).toBe('active');
  });
});
