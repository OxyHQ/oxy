/**
 * `POST /assets/:id/trash` — the owner moves their own file to trash (ADR
 * 0042 D5) — over real `node:http`, the REAL AssetService and a REAL Postgres.
 * Stubbed: the session middleware, the rate limiter, S3 (an in-memory map).
 *
 *  1. Only the file's owner; anyone else (and a deleted file) gets 404.
 *  2. The file leaves `active`: not served any more, `trashedAt` set, its
 *     public objects moved off `public/`.
 *  3. Every application using it is told `file.trashed`; restoring tells
 *     them `file.restored` and serves it again.
 *  4. Idempotent: trashing a trashed file answers it as it is.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';

let mockSessionUserId = 'nobody';
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
  listFiles: jest.fn(async () => []),
  getPresignedDownloadUrl: jest.fn(async (key: string) => `https://signed.example/${key}`),
};

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { _id: string } }, _res: unknown, next: () => void) => {
    req.user = { _id: mockSessionUserId };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/optionalAuth', () => ({
  optionalAuthMiddleware: (req: { user?: { _id: string } }, _res: unknown, next: () => void) => {
    req.user = { _id: mockSessionUserId };
    next();
  },
  getMediaViewerUserId: (req: { user?: { _id: string } }) => req.user?._id,
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
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

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications, fileEventDeliveries, files, users } from '../../db/schema';
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';
import { addFileReferences } from '../../services/fileRepository';
import { sealFileWebhookSecret } from '../../services/fileEvents.service';
import fileCache from '../../utils/fileCache';

jest.setTimeout(60_000);

let server: http.Server;

// biome-ignore lint/suspicious/noExplicitAny: a JSON response read loosely in assertions
function send(method: string, path: string): Promise<{ status: number; body: any }> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({ method, host: '127.0.0.1', port: address.port, path }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        let body: unknown = raw;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          // a redirect or bytes
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function subscribedApplication(): Promise<string> {
  const id = randomBytes(12).toString('hex');
  await getDb()
    .insert(applications)
    .values({
      id,
      name: `app-${id.slice(0, 6)}`,
      ownerAccountId: await account(),
      filesWebhookUrl: 'https://receiver.example/files',
      filesWebhookSecretCiphertext: sealFileWebhookSecret(id, 'whsec_x'),
      filesWebhookVerifiedAt: new Date(),
    });
  return id;
}

async function publicFile(ownerUserId: string) {
  const sha = randomBytes(32).toString('hex');
  const storageKey = `public/content/2026/10/${sha.slice(0, 2)}/${sha}.png`;
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: sha,
      size: 1,
      mime: 'image/png',
      ext: 'png',
      ownerUserId,
      visibility: 'public',
      storageKey,
      originalName: 'x.png',
    })
    .returning();
  mockObjects.set(storageKey, Buffer.from('x'));
  return row;
}

beforeAll(async () => {
  process.env.DEVICE_ID_SALT ??= 'test-device-id-salt-that-is-long-enough-000';
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/assets', assetsRouter);
  app.use(errorHandler);
  server = app.listen(0);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

beforeEach(() => fileCache.clear());

describe('POST /assets/:id/trash', () => {
  it("is the owner's alone: anyone else gets 404 and changes nothing", async () => {
    const owner = await account();
    const file = await publicFile(owner);
    mockSessionUserId = await account();
    expect((await send('POST', `/assets/${file.id}/trash`)).status).toBe(404);
    expect((await send('POST', '/assets/no-such-file/trash')).status).toBe(404);
    const [row] = await getDb().select().from(files).where(eq(files.id, file.id));
    expect(row.status).toBe('active');
  });

  it('stops serving the file, tells the applications using it, and restore brings it back', async () => {
    const owner = await account();
    const file = await publicFile(owner);
    const appId = await subscribedApplication();
    await addFileReferences([
      { fileId: file.id, applicationId: appId, entityType: 'post', entityId: 'p' },
    ]);
    mockSessionUserId = owner;

    const res = await send('POST', `/assets/${file.id}/trash`);
    expect(res.status).toBe(200);
    expect(res.body.data.file).toMatchObject({ id: file.id, status: 'trash', usageCount: 1 });
    expect(res.body.data.file.trashedAt).toEqual(expect.any(String));

    const [row] = await getDb().select().from(files).where(eq(files.id, file.id));
    expect(row.status).toBe('trash');
    expect(row.storageKey.startsWith('public/')).toBe(false);
    expect(mockObjects.has(row.storageKey)).toBe(true);
    expect((await send('GET', `/assets/${file.id}/stream`)).status).toBe(404);

    // Idempotent.
    const again = await send('POST', `/assets/${file.id}/trash`);
    expect(again.status).toBe(200);
    expect(again.body.data.file.status).toBe('trash');

    expect((await send('POST', `/assets/${file.id}/restore`)).status).toBe(200);
    const [restored] = await getDb().select().from(files).where(eq(files.id, file.id));
    expect(restored.status).toBe('active');
    expect(restored.trashedAt).toBeNull();

    const events = await getDb()
      .select({ type: fileEventDeliveries.type, payload: fileEventDeliveries.payload })
      .from(fileEventDeliveries)
      .where(eq(fileEventDeliveries.fileId, file.id))
      .orderBy(fileEventDeliveries.createdAt);
    expect(events.map((event) => event.type)).toEqual(['file.trashed', 'file.restored']);
    expect(events[0].payload).toMatchObject({
      file: { id: file.id, ownerKind: 'account', status: 'trash' },
      references: [{ entityType: 'post', entityId: 'p' }],
    });
  });
});

describe('GET /assets — the library and the trash', () => {
  async function fileWithStatus(
    ownerUserId: string,
    status: 'active' | 'trash' | 'blocked' | 'deleted',
    trashedAt: Date | null = null,
  ) {
    const sha = randomBytes(32).toString('hex');
    const [row] = await getDb()
      .insert(files)
      .values({
        sha256: sha,
        size: 1,
        mime: 'image/png',
        ext: 'png',
        ownerUserId,
        storageKey: `content/2026/10/${sha.slice(0, 2)}/${sha}.png`,
        originalName: `${status}.png`,
        status,
        trashedAt,
      })
      .returning();
    return row;
  }

  it('the library holds active and blocked files, never trashed or deleted ones', async () => {
    const owner = await account();
    const active = await fileWithStatus(owner, 'active');
    const blocked = await fileWithStatus(owner, 'blocked');
    await fileWithStatus(owner, 'trash', new Date());
    await fileWithStatus(owner, 'deleted');
    mockSessionUserId = owner;

    const res = await send('GET', '/assets');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.files.map((file: { id: string }) => file.id).sort()).toEqual(
      [active.id, blocked.id].sort(),
    );
  });

  it('status=trash lists only the owner’s trash, most recently trashed first, paged', async () => {
    const owner = await account();
    await fileWithStatus(owner, 'active');
    await fileWithStatus(owner, 'blocked');
    const older = await fileWithStatus(owner, 'trash', new Date(Date.now() - 60_000));
    const newer = await fileWithStatus(owner, 'trash', new Date());
    // Somebody else's trash is never listed.
    await fileWithStatus(await account(), 'trash', new Date());
    mockSessionUserId = owner;

    const res = await send('GET', '/assets?status=trash');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.files.map((file: { id: string }) => file.id)).toEqual([
      newer.id,
      older.id,
    ]);
    expect(res.body.data.files[0]).toMatchObject({ status: 'trash' });
    expect(res.body.data.files[0].trashedAt).toEqual(expect.any(String));

    const firstPage = await send('GET', '/assets?status=trash&limit=1');
    expect(firstPage.body.data).toMatchObject({ total: 2, hasMore: true });
    expect(firstPage.body.data.files.map((file: { id: string }) => file.id)).toEqual([newer.id]);
    const secondPage = await send('GET', '/assets?status=trash&limit=1&offset=1');
    expect(secondPage.body.data.files.map((file: { id: string }) => file.id)).toEqual([older.id]);
  });

  it('refuses a status it does not know', async () => {
    mockSessionUserId = await account();
    expect((await send('GET', '/assets?status=deleted')).status).toBe(400);
  });

  it('a file moved to trash leaves the library for the trash, and restore brings it back', async () => {
    const owner = await account();
    const file = await publicFile(owner);
    mockSessionUserId = owner;

    expect((await send('POST', `/assets/${file.id}/trash`)).status).toBe(200);
    const ids = async (path: string) =>
      (await send('GET', path)).body.data.files.map((row: { id: string }) => row.id);
    expect(await ids('/assets')).not.toContain(file.id);
    expect(await ids('/assets?status=trash')).toEqual([file.id]);

    expect((await send('POST', `/assets/${file.id}/restore`)).status).toBe(200);
    expect(await ids('/assets')).toContain(file.id);
    expect(await ids('/assets?status=trash')).toEqual([]);
  });
});

describe('POST /assets/:id/restore on a file that is not in trash', () => {
  it('is a 409 FILE_NOT_IN_TRASH naming the status, for an active and a blocked file', async () => {
    const owner = await account();
    const active = await publicFile(owner);
    const [blocked] = await getDb()
      .update(files)
      .set({ status: 'blocked' })
      .where(eq(files.id, (await publicFile(owner)).id))
      .returning();
    mockSessionUserId = owner;

    const notTrashed = await send('POST', `/assets/${active.id}/restore`);
    expect(notTrashed.status).toBe(409);
    expect(notTrashed.body).toMatchObject({
      error: 'FILE_NOT_IN_TRASH',
      details: { status: 'active' },
    });

    const takenDown = await send('POST', `/assets/${blocked.id}/restore`);
    expect(takenDown.status).toBe(409);
    expect(takenDown.body).toMatchObject({
      error: 'FILE_NOT_IN_TRASH',
      details: { status: 'blocked' },
    });
    const [row] = await getDb().select().from(files).where(eq(files.id, blocked.id));
    expect(row.status).toBe('blocked');
  });
});
