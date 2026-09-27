/**
 * `DELETE /assets/service/federation/:id` and `POST /assets/service/federation/delete`
 * — end to end over real `node:http`, the REAL AssetService and a REAL Postgres.
 *
 * Only three things are stubbed: the service-token middleware (so a case can set
 * the verified `serviceApp`), the rate limiter, and S3 (a recording fake). The
 * authorization decision lives in one conditional `UPDATE`, so it is exercised
 * against real rows: the owner's `users.type`, the row's `metadata`, `purpose`,
 * `system_owner` and `status` are all what production would read.
 *
 * Invariants:
 *  1. The uploading app deletes its own federated media: row tombstoned, the
 *     original, every variant and every HLS segment removed from storage.
 *  2. Never a local user's asset, never another app's upload, never a cache
 *     object, never a row the federation upload path did not write — 403 (or
 *     `forbidden` in a batch), the row untouched and ZERO storage calls.
 *  3. Idempotent: unknown and already-deleted ids are 200 `not_found`.
 *  4. Both scopes are required, and the app id comes from the token only.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

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
import { files, fileVariants, users } from '../../db/schema';
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import fileCache from '../../utils/fileCache';

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
  variants?: Array<{ type: string; key: string }>;
}

/** A files row plus its variants; returns the id and the keys it owns. */
async function insertFile(options: FixtureOptions) {
  const sha256 = randomBytes(32).toString('hex');
  const storageKey = `public/files/${sha256}.mp4`;
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
  const variants = (options.variants ?? []).map((v) => ({ ...v, key: v.key.replace('<sha>', sha256) }));
  if (variants.length > 0) {
    await getDb()
      .insert(fileVariants)
      .values(variants.map((v) => ({ fileId: row.id, type: v.type, key: v.key, readyAt: new Date() })));
  }
  return { id: row.id, sha256, storageKey, variantKeys: variants.map((v) => v.key) };
}

async function statusOf(id: string): Promise<string | undefined> {
  const [row] = await getDb().select({ status: files.status }).from(files).where(eq(files.id, id));
  return row?.status;
}

let federatedOwner: string;
let localOwner: string;
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
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await getDb().delete(files).where(inArray(files.id, createdIds));
  }
  await getDb().delete(users).where(inArray(users.id, [federatedOwner, localOwner]));
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

describe('DELETE /assets/service/federation/:id — the uploading app deletes its federated media', () => {
  it('tombstones the row and removes the original, every variant and every HLS segment', async () => {
    const file = await fixture({
      ownerUserId: federatedOwner,
      variants: [
        { type: 'poster', key: 'public/variants/2026/09/ab/<sha>/poster.jpg' },
        { type: 'hls_720p', key: 'public/variants/2026/09/ab/<sha>/hls_720p.m3u8' },
        { type: 'hls_master', key: 'public/variants/2026/09/ab/<sha>/hls_master.m3u8' },
      ],
    });
    const hlsPlaylist = file.variantKeys[1];
    const segmentPrefix = `${hlsPlaylist.slice(0, -'.m3u8'.length)}_segment_`;
    const segments = [`${segmentPrefix}720p_000.ts.ts`, `${segmentPrefix}720p_001.ts.ts`];
    mockS3.listFiles.mockImplementation(async (prefix: string) =>
      prefix === segmentPrefix && mockS3.deleteFile.mock.calls.every(([k]) => !segments.includes(k))
        ? segments.map((key) => ({ key, size: 1, lastModified: new Date(), bucket: 'b' }))
        : [],
    );

    const res = await request('DELETE', `/assets/service/federation/${file.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: file.id, result: 'deleted' });
    expect(await statusOf(file.id)).toBe('deleted');

    const deletedKeys = mockS3.deleteFile.mock.calls.map(([k]) => k);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([file.storageKey, ...file.variantKeys, ...segments]),
    );
    // Listed by the rendition playlist's own prefix — never the master's, never wider.
    expect(mockS3.listFiles).toHaveBeenCalledWith(segmentPrefix);
    expect(mockS3.listFiles.mock.calls.every(([p]) => p === segmentPrefix)).toBe(true);

    expect(logger.info).toHaveBeenCalledWith(
      'Audit: federated media delete',
      expect.objectContaining({ event: 'federated_media_delete', appId: APP_ID, fileId: file.id, result: 'deleted' }),
    );
  });

  it('deletes a trashed row too — trash still holds bytes', async () => {
    const file = await fixture({ ownerUserId: federatedOwner, status: 'trash' });

    const res = await request('DELETE', `/assets/service/federation/${file.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data?.result).toBe('deleted');
    expect(await statusOf(file.id)).toBe('deleted');
  });

  it('is idempotent: a second delete, an already-deleted row and an unknown id are 200 not_found with no storage calls', async () => {
    const file = await fixture({ ownerUserId: federatedOwner });
    expect((await request('DELETE', `/assets/service/federation/${file.id}`)).body.data?.result).toBe('deleted');
    mockS3.deleteFile.mockClear();

    const again = await request('DELETE', `/assets/service/federation/${file.id}`);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ id: file.id, result: 'not_found' });

    const tombstone = await fixture({ ownerUserId: federatedOwner, status: 'deleted' });
    const deleted = await request('DELETE', `/assets/service/federation/${tombstone.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.data?.result).toBe('not_found');

    const unknown = await request('DELETE', '/assets/service/federation/0190aaaa-0000-7000-8000-000000000000');
    expect(unknown.status).toBe(200);
    expect(unknown.body.data?.result).toBe('not_found');

    expect(mockS3.deleteFile).not.toHaveBeenCalled();
  });

  it('keeps the row tombstoned and answers 5xx when the original cannot be removed from storage', async () => {
    const file = await fixture({ ownerUserId: federatedOwner });
    mockS3.deleteFile.mockRejectedValueOnce(new Error('S3 unavailable'));

    const res = await request('DELETE', `/assets/service/federation/${file.id}`);

    expect(res.status).toBeGreaterThanOrEqual(500);
    // Never served again (every read path refuses a non-active row) …
    expect(await statusOf(file.id)).toBe('deleted');
    // … and the stranded key is named for an operator.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not be deleted from storage'),
      expect.objectContaining({ fileId: file.id, storageKey: file.storageKey }),
    );
  });
});

describe('DELETE /assets/service/federation/:id — strict authorization (negative cases)', () => {
  const refusals: Array<[string, () => Promise<{ id: string }>]> = [
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

  it.each(refusals)('refuses %s: 403, row untouched, zero storage calls', async (_label, make) => {
    const file = await make();

    const res = await request('DELETE', `/assets/service/federation/${file.id}`);

    expect(res.status).toBe(403);
    expect(await statusOf(file.id)).not.toBe('deleted');
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

    const res = await request('DELETE', `/assets/service/federation/${file.id}`);

    expect(res.status).toBe(403);
    expect(await statusOf(file.id)).toBe('active');
    expect(mockS3.deleteFile).not.toHaveBeenCalled();
  });

  it('takes the application id from the token only — a query or body naming the uploader changes nothing', async () => {
    const file = await fixture({ ownerUserId: federatedOwner });
    actAs(OTHER_APP_ID);

    const res = await request('DELETE', `/assets/service/federation/${file.id}?appId=${APP_ID}`, {
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
    const local = await fixture({ ownerUserId: localOwner });
    const theirs = await fixture({
      ownerUserId: federatedOwner,
      metadata: { source: 'federation', serviceAppId: OTHER_APP_ID },
    });
    const unknown = '0190bbbb-0000-7000-8000-000000000000';

    const res = await request('POST', '/assets/service/federation/delete', {
      ids: [mine.id, local.id, mine.id, theirs.id, unknown],
    });

    expect(res.status).toBe(200);
    expect(res.body.data?.results).toEqual([
      { id: mine.id, result: 'deleted' },
      { id: local.id, result: 'forbidden' },
      { id: theirs.id, result: 'forbidden' },
      { id: unknown, result: 'not_found' },
    ]);
    expect(await statusOf(mine.id)).toBe('deleted');
    expect(await statusOf(local.id)).toBe('active');
    expect(await statusOf(theirs.id)).toBe('active');
    // Storage was touched for the one qualifying row only.
    expect(mockS3.deleteFile.mock.calls.map(([k]) => k)).toEqual([mine.storageKey]);
  });

  it.each([
    ['an empty list', { ids: [] }],
    ['more than 50 ids', { ids: Array.from({ length: 51 }, (_, i) => `id-${i}`) }],
    ['a missing ids field', {}],
    ['an unknown field', { ids: ['x'], appId: 'forged' }],
    ['a non-string id', { ids: [42] }],
  ])('rejects %s with 400', async (_label, payload) => {
    const res = await request('POST', '/assets/service/federation/delete', payload);
    expect(res.status).toBe(400);
    expect(mockS3.deleteFile).not.toHaveBeenCalled();
  });

  it('requires both scopes', async () => {
    const file = await fixture({ ownerUserId: federatedOwner });
    actAs(APP_ID, ['files:write']);

    const res = await request('POST', '/assets/service/federation/delete', { ids: [file.id] });

    expect(res.status).toBe(403);
    expect(await statusOf(file.id)).toBe('active');
  });
});
