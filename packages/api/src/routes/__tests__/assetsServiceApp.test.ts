/**
 * `/assets/service/app` — files an APPLICATION owns (ADR 0043) — end to end
 * over real `node:http`, the REAL AssetService and a REAL Postgres.
 *
 * Stubbed: the two auth middlewares (so a case sets the verified `serviceApp`
 * or session user), the rate limiter, and S3 (an in-memory object map).
 *
 * Invariants:
 *  1. The owner is the TOKEN's `appId` — never a header — and only an ACTIVE
 *     application holding the scope may write, of any type (ADR 0043 D11).
 *  2. `x-visibility` is required; image/video only.
 *  3. Idempotent per (application, bytes).
 *  4. Another application's file is 404 on every route, and left untouched.
 *  5. A private application file is invisible to every session (`GET /:id`
 *     404, media access denied) and readable by its own application only
 *     (`/service/linked-url`).
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';

const mockServiceAuthMiddleware = jest.fn();
let mockSessionUserId = 'nobody';

const mockObjects = new Map<string, Buffer>();
const mockS3 = {
  uploadStream: jest.fn(async (key: string, body: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    mockObjects.set(key, Buffer.concat(chunks));
    return {};
  }),
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
  getPresignedDownloadUrl: jest.fn(async (key: string) => `https://signed.example/${key}`),
};

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { _id: string } }, _res: unknown, next: () => void) => {
    req.user = { _id: mockSessionUserId };
    next();
  },
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

jest.mock('../../queue/assetVariants.queue', () => ({
  enqueueAssetVariantGeneration: jest.fn(() => Promise.resolve()),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications, files, users } from '../../db/schema';
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';
import { mediaPrivacyService } from '../../services/mediaPrivacyService';
import fileCache from '../../utils/fileCache';

jest.setTimeout(60_000);

const ALL_SCOPES = ['files:app:write', 'files:app:delete', 'files:linked:read', 'files:read'];

interface JsonResponse {
  status: number;
  body: {
    data?: Record<string, unknown> & {
      file?: Record<string, unknown>;
      files?: Array<Record<string, unknown>>;
      nextCursor?: string;
      deduplicated?: boolean;
    };
    message?: string;
    code?: string;
  };
}

let server: http.Server;

function send(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: Buffer } = {},
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          ...(options.body ? { 'content-length': String(options.body.length) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function json(method: string, path: string, payload: unknown): Promise<JsonResponse> {
  return send(method, path, {
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload)),
  });
}

function actAs(
  appId: string,
  scopes: string[] = ALL_SCOPES,
  tier: 'internal' | 'external' = 'internal',
  authority: 'first_party' | 'external' = 'external',
): void {
  mockServiceAuthMiddleware.mockImplementation(
    (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
      req.serviceApp = {
        type: 'service',
        appId,
        appName: 'test-app',
        credentialId: 'cred-1',
        ownerAccountId: 'acct-1',
        environment: 'production',
        tier,
        authority,
        ...(authority === 'first_party' ? {} : { scopes }),
      };
      next();
    },
  );
}

const png = () =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(24)]);

function upload(
  bytes: Buffer,
  headers: Record<string, string> = { 'x-visibility': 'public' },
): Promise<JsonResponse> {
  return send('POST', '/assets/service/app', {
    headers: { 'content-type': 'image/png', ...headers },
    body: bytes,
  });
}

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function application(
  values: Partial<typeof applications.$inferInsert> = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `app-${randomBytes(4).toString('hex')}`,
      ownerAccountId: await account(),
      type: 'first_party',
      ...values,
    })
    .returning({ id: applications.id });
  return row.id;
}

async function row(id: string) {
  const [stored] = await getDb().select().from(files).where(eq(files.id, id));
  return stored;
}

beforeAll(async () => {
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

beforeEach(() => {
  fileCache.clear();
});

describe('POST /assets/service/app — who may write, and as whom', () => {
  it("stores the file as the TOKEN's application, ignoring any owner header", async () => {
    const appId = await application();
    const someone = await account();
    actAs(appId);

    const res = await upload(png(), { 'x-visibility': 'unlisted', 'x-owner-user-id': someone });

    expect(res.status).toBe(200);
    const id = String(res.body.data?.file?.id);
    expect(res.body.data?.file).toMatchObject({
      ownerApplicationId: appId,
      visibility: 'unlisted',
    });
    expect(await row(id)).toMatchObject({
      ownerApplicationId: appId,
      ownerUserId: null,
      systemOwner: null,
      visibility: 'unlisted',
    });
  });

  it('is idempotent per (application, bytes)', async () => {
    const appId = await application();
    actAs(appId);
    const bytes = png();

    const first = await upload(bytes);
    const second = await upload(bytes, { 'x-visibility': 'private' });

    expect(second.status).toBe(200);
    expect(second.body.data?.deduplicated).toBe(true);
    expect(second.body.data?.file?.id).toBe(first.body.data?.file?.id);
    expect(second.body.data?.file?.visibility).toBe('public');
  });

  it('refuses a token without files:app:write, writing nothing', async () => {
    const appId = await application();
    actAs(appId, ['files:write', 'files:user-media:write', 'files:app:delete']);
    const before = mockS3.uploadStream.mock.calls.length;

    const res = await upload(png());

    expect(res.status).toBe(403);
    expect(mockS3.uploadStream.mock.calls.length).toBe(before);
  });

  it('lets a third_party application holding the scope own a file (ADR 0043 D3)', async () => {
    const appId = await application({ type: 'third_party' });
    actAs(appId);

    const res = await upload(png());

    expect(res.status).toBe(200);
    expect(await row(String(res.body.data?.file?.id))).toMatchObject({
      ownerApplicationId: appId,
      ownerUserId: null,
    });
  });

  it('refuses a suspended application of any type, whatever the token carries', async () => {
    for (const type of ['first_party', 'third_party'] as const) {
      actAs(await application({ type, status: 'suspended' }));
      const before = mockS3.uploadStream.mock.calls.length;
      const res = await upload(png());
      expect({ type, status: res.status }).toEqual({ type, status: 403 });
      expect(mockS3.uploadStream.mock.calls.length).toBe(before);
    }
  });

  it('requires x-visibility, and an image or video type', async () => {
    actAs(await application());

    expect((await upload(png(), {})).status).toBe(400);
    expect((await upload(png(), { 'x-visibility': 'everyone' })).status).toBe(400);
    const pdf = await send('POST', '/assets/service/app', {
      headers: { 'content-type': 'application/pdf', 'x-visibility': 'public' },
      body: Buffer.from('%PDF-1.4'),
    });
    expect(pdf.status).toBe(415);
  });
});

describe('another application’s file is not found, on every route', () => {
  it('404s PATCH and DELETE across applications, lists only its own, and leaves the row untouched', async () => {
    const ownerApp = await application();
    const otherApp = await application();
    actAs(ownerApp);
    const id = String((await upload(png())).body.data?.file?.id);

    actAs(otherApp);
    expect(
      (await json('PATCH', `/assets/service/app/${id}/visibility`, { visibility: 'private' }))
        .status,
    ).toBe(404);
    expect((await send('DELETE', `/assets/service/app/${id}`)).status).toBe(404);
    const listed = await send('GET', '/assets/service/app');
    expect(listed.status).toBe(200);
    expect(listed.body.data?.files?.map((file) => file.id)).not.toContain(id);

    expect(await row(id)).toMatchObject({ status: 'active', visibility: 'public' });
  });

  it('lets the owning application change visibility, list with a cursor, and delete', async () => {
    const appId = await application();
    actAs(appId);
    const first = String((await upload(png())).body.data?.file?.id);
    const second = String((await upload(png())).body.data?.file?.id);

    const patched = await json('PATCH', `/assets/service/app/${first}/visibility`, {
      visibility: 'private',
    });
    expect(patched.status).toBe(200);
    expect((await row(first)).visibility).toBe('private');

    const page1 = await send('GET', '/assets/service/app?limit=1');
    expect(page1.body.data?.files).toHaveLength(1);
    const cursor = page1.body.data?.nextCursor;
    expect(typeof cursor).toBe('string');
    const page2 = await send('GET', `/assets/service/app?limit=1&cursor=${cursor}`);
    expect(page2.body.data?.files).toHaveLength(1);
    expect(page2.body.data?.nextCursor).toBeUndefined();
    expect(new Set([page1.body.data?.files?.[0]?.id, page2.body.data?.files?.[0]?.id])).toEqual(
      new Set([first, second]),
    );

    const deleted = await send('DELETE', `/assets/service/app/${second}`);
    expect(deleted.status).toBe(200);
    expect((await row(second)).status).toBe('deleted');
    expect((await send('DELETE', `/assets/service/app/${second}`)).status).toBe(404);
  });

  it('requires files:app:delete to delete, and files:app:write to change visibility', async () => {
    const appId = await application();
    actAs(appId);
    const id = String((await upload(png())).body.data?.file?.id);

    actAs(appId, ['files:app:write']);
    expect((await send('DELETE', `/assets/service/app/${id}`)).status).toBe(403);
    actAs(appId, ['files:app:delete']);
    expect(
      (await json('PATCH', `/assets/service/app/${id}/visibility`, { visibility: 'private' }))
        .status,
    ).toBe(403);
    expect((await row(id)).status).toBe('active');
  });
});

describe('a private application file is readable by its application only', () => {
  it('is 404 to every session, and the media check denies even its owning account', async () => {
    const owner = await account();
    const appId = await application({ ownerAccountId: owner });
    actAs(appId);
    const privateId = String(
      (await upload(png(), { 'x-visibility': 'private' })).body.data?.file?.id,
    );
    const publicId = String((await upload(png())).body.data?.file?.id);

    mockSessionUserId = owner;
    expect((await send('GET', `/assets/${privateId}`)).status).toBe(404);
    const visible = await send('GET', `/assets/${publicId}`);
    expect(visible.status).toBe(200);
    expect(visible.body.data?.file).toMatchObject({ ownerApplicationId: appId, ownerUserId: null });

    const privateRow = await row(privateId);
    const access = await mediaPrivacyService.checkMediaAccess(
      { ...privateRow, links: [], variants: [], accessGrants: [] },
      owner,
    );
    expect(access).toEqual({ allowed: false, reason: 'application_private' });
  });

  it('mints a download URL for the owning application and omits it for any other', async () => {
    const appId = await application();
    actAs(appId);
    const id = String((await upload(png(), { 'x-visibility': 'private' })).body.data?.file?.id);

    const own = await json('POST', '/assets/service/linked-url', { ids: [id] });
    expect(own.status).toBe(200);
    expect((own.body.data as unknown as Array<{ id: string }>).map((entry) => entry.id)).toEqual([
      id,
    ]);

    actAs(await application());
    const other = await json('POST', '/assets/service/linked-url', { ids: [id] });
    expect(other.status).toBe(200);
    expect(other.body.data).toEqual([]);
  });

  it('reveals ownerApplicationId only to verified own authority, never a branded external key', async () => {
    const appId = await application();
    actAs(appId);
    const id = String((await upload(png())).body.data?.file?.id);

    actAs(appId, [], 'internal', 'first_party');
    const internal = await json('POST', '/assets/service/by-ids', { ids: [id] });
    expect((internal.body.data as unknown as Array<Record<string, unknown>>)[0]).toMatchObject({
      id,
      ownerUserId: null,
      ownerApplicationId: appId,
    });

    actAs(appId, ALL_SCOPES, 'internal', 'external');
    const external = await json('POST', '/assets/service/by-ids', { ids: [id] });
    expect((external.body.data as unknown as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      'ownerApplicationId',
    );
  });
});
