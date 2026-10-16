/**
 * A person's consent for an application to read their file (ADR 0043 stage
 * 4c) — over real `node:http`, the REAL AssetService, the real grant service
 * and a REAL Postgres. Stubbed: the two auth middlewares (a mutable session
 * user and service application), the rate limiter, S3 (in memory) and the
 * rendition queue.
 *
 * Invariants:
 *  1. `/service/user-media` stores a PRIVATE file when asked, never under
 *     `public/`, and the uploading application may read it back
 *     (`/service/linked-url`) — no other application may.
 *  2. The owner sees who can read the file (`GET /assets/:id/access`) and can
 *     revoke an application (`DELETE /assets/:id/access/:applicationId`); a
 *     revocation beats the upload's grant AND an owner-made reference, and
 *     survives a re-upload of the same bytes.
 *  3. The owner attaching the file to the application again restores it.
 *  4. Nobody but the owner reads or changes the list (404), and an unknown
 *     application is 404.
 *  5. Both are reviewed own-file operations (`ownAssetAuth`), like trash and
 *     restore: a supervised account may see and withdraw access to its own
 *     file (ADR 0041 — management that only narrows who reads it).
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';

const mockServiceAuthMiddleware = jest.fn();
let mockSessionUserId: string | null = null;
/** Whether the last session authentication was asked as a reviewed own-file operation. */
let mockSupervisedSelfOperation: boolean | null = null;
const mockObjects = new Map<string, { bytes: Buffer; contentType?: string }>();

const mockS3 = {
  uploadStream: jest.fn(async (key: string, body: Readable, options?: { contentType?: string }) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    mockObjects.set(key, { bytes: Buffer.concat(chunks), contentType: options?.contentType });
    return {};
  }),
  uploadBuffer: jest.fn(async (key: string, bytes: Buffer, options?: { contentType?: string }) => {
    mockObjects.set(key, { bytes, contentType: options?.contentType });
    return {};
  }),
  fileExists: jest.fn(async (key: string) => mockObjects.has(key)),
  headObject: jest.fn(async (key: string) => {
    const object = mockObjects.get(key);
    return object ? { size: object.bytes.length, contentType: object.contentType } : null;
  }),
  copyFile: jest.fn(async (from: string, to: string) => {
    const object = mockObjects.get(from);
    if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    mockObjects.set(to, { ...object });
  }),
  deleteFile: jest.fn(async (key: string) => {
    mockObjects.delete(key);
  }),
  listFiles: jest.fn(async () => []),
  getPresignedDownloadUrl: jest.fn(async (key: string) => `https://signed.example/${key}`),
};

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: unknown },
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    mockSupervisedSelfOperation = res.locals.supervisedSelfOperation === true;
    if (mockSessionUserId) req.user = { _id: mockSessionUserId, id: mockSessionUserId };
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
import { applications, fileAccessGrants, files, users } from '../../db/schema';
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';
import fileCache from '../../utils/fileCache';

jest.setTimeout(60_000);

let server: http.Server;

interface JsonResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the route answered.
  body: { data?: any; message?: string; code?: string; error?: any };
}

function request(
  method: string,
  path: string,
  payload?: Buffer | Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body =
    payload === undefined
      ? undefined
      : Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          ...(body && !Buffer.isBuffer(payload) ? { 'content-type': 'application/json' } : {}),
          ...(body ? { 'content-length': String(body.length) } : {}),
          ...headers,
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
    if (body) req.write(body);
    req.end();
  });
}

const USER_MEDIA_SCOPES = ['files:user-media:write', 'files:linked:read', 'files:references:write'];

function actAs(appId: string, scopes: string[] = USER_MEDIA_SCOPES): void {
  mockServiceAuthMiddleware.mockImplementation(
    (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
      req.serviceApp = {
        type: 'service',
        appId,
        appName: 'test-app',
        credentialId: 'cred-1',
        ownerAccountId: 'acct-1',
        environment: 'production',
        tier: 'internal',
        scopes,
      };
      next();
    },
  );
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

/** Store `bytes` into `ownerId`'s files as application `appId`, through the real route. */
async function uploadUserMedia(
  appId: string,
  ownerId: string,
  bytes: Buffer,
  visibility?: string,
): Promise<JsonResponse> {
  actAs(appId);
  return request('POST', '/assets/service/user-media', bytes, {
    'content-type': 'image/png',
    'x-owner-user-id': ownerId,
    ...(visibility ? { 'x-visibility': visibility } : {}),
  });
}

async function linkedUrlIds(appId: string, fileId: string): Promise<string[]> {
  actAs(appId);
  const res = await request('POST', '/assets/service/linked-url', { ids: [fileId] });
  expect(res.status).toBe(200);
  return (res.body.data as Array<{ id: string }>).map((entry) => entry.id);
}

function as(userId: string | null): void {
  mockSessionUserId = userId;
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  // The real server skips the JSON parser for the raw user-media upload.
  app.use((req, res, next) =>
    req.path === '/assets/service/user-media' ? next() : express.json()(req, res, next),
  );
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
  mockSessionUserId = null;
  mockSupervisedSelfOperation = null;
});

describe('private person-owned media from a service, and who may read it back', () => {
  it('stores a private file off public/ that only the uploading application can read back', async () => {
    const owner = await account();
    const uploader = await application();
    const stranger = await application();
    const bytes = randomBytes(64);

    const res = await uploadUserMedia(uploader, owner, bytes, 'private');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      file: { visibility: 'private', sha256: createHash('sha256').update(bytes).digest('hex') },
      deduplicated: false,
    });
    const fileId = res.body.data.file.id;
    const [stored] = await getDb().select().from(files).where(eq(files.id, fileId));
    expect(stored).toMatchObject({ ownerUserId: owner, visibility: 'private' });
    expect(stored.storageKey.startsWith('public/')).toBe(false);
    expect(
      [...mockObjects.keys()].some(
        (key) => key.startsWith('public/') && key.includes(stored.sha256),
      ),
    ).toBe(false);

    const [grant] = await getDb()
      .select()
      .from(fileAccessGrants)
      .where(eq(fileAccessGrants.fileId, fileId));
    expect(grant).toMatchObject({ applicationId: uploader, state: 'granted', source: 'upload' });

    expect(await linkedUrlIds(uploader, fileId)).toEqual([fileId]);
    expect(await linkedUrlIds(stranger, fileId)).toEqual([]);
  });

  it('defaults to public, and refuses an unknown visibility', async () => {
    const owner = await account();
    const uploader = await application();
    const res = await uploadUserMedia(uploader, owner, randomBytes(32));
    expect(res.body.data.file.visibility).toBe('public');
    const bad = await uploadUserMedia(uploader, owner, randomBytes(32), 'secret');
    expect(bad.status).toBe(400);
  });

  it('accepts audio, and keeps the audio options off free-form metadata', async () => {
    const owner = await account();
    const uploader = await application();
    actAs(uploader);
    const res = await request('POST', '/assets/service/user-media', randomBytes(128), {
      'content-type': 'audio/mpeg',
      'x-owner-user-id': owner,
      'x-visibility': 'private',
      'x-audio-options': JSON.stringify({ normalizeLoudness: true, previewStartSeconds: 12 }),
      'x-media-metadata': JSON.stringify({ title: 'Episode 1', audioOptions: { evil: true } }),
    });
    expect(res.status).toBe(200);
    const [stored] = await getDb().select().from(files).where(eq(files.id, res.body.data.file.id));
    expect(stored.mime).toBe('audio/mpeg');
    expect(stored.metadata).toMatchObject({
      title: 'Episode 1',
      audioOptions: { normalizeLoudness: true, previewStartSeconds: 12 },
    });
    expect(
      (stored.metadata as { audioOptions: Record<string, unknown> }).audioOptions,
    ).not.toHaveProperty('evil');

    const invalid = await request('POST', '/assets/service/user-media', randomBytes(16), {
      'content-type': 'audio/mpeg',
      'x-owner-user-id': owner,
      'x-audio-options': JSON.stringify({ normalizeLoudness: 'yes' }),
    });
    expect(invalid.status).toBe(400);
  });
});

describe('the owner sees and revokes applications with access', () => {
  it('lists the uploader, revokes it everywhere, and a re-upload does not bring it back', async () => {
    const owner = await account();
    const uploader = await application();
    const bytes = randomBytes(80);
    const fileId = (await uploadUserMedia(uploader, owner, bytes, 'private')).body.data.file.id;

    as(owner);
    const listed = await request('GET', `/assets/${fileId}/access`);
    expect(listed.status).toBe(200);
    expect(mockSupervisedSelfOperation).toBe(true);
    expect(listed.body.data).toMatchObject({
      fileId,
      applications: [{ applicationId: uploader, via: ['upload'] }],
    });
    expect(typeof listed.body.data.applications[0].since).toBe('string');

    mockSupervisedSelfOperation = null;
    const revoked = await request('DELETE', `/assets/${fileId}/access/${uploader}`);
    expect(revoked.status).toBe(200);
    expect(mockSupervisedSelfOperation).toBe(true);
    expect(revoked.body.data).toMatchObject({ fileId, applicationId: uploader, revoked: true });
    expect(await linkedUrlIds(uploader, fileId)).toEqual([]);

    as(owner);
    expect((await request('GET', `/assets/${fileId}/access`)).body.data.applications).toEqual([]);
    // Idempotent.
    expect((await request('DELETE', `/assets/${fileId}/access/${uploader}`)).status).toBe(200);

    // The same bytes stored again by the same application: the person's
    // decision stands.
    const again = await uploadUserMedia(uploader, owner, bytes, 'private');
    expect(again.body.data).toMatchObject({ file: { id: fileId }, deduplicated: true });
    expect(await linkedUrlIds(uploader, fileId)).toEqual([]);
  });

  it('a revocation beats an owner-made reference, and attaching the file again restores access', async () => {
    const owner = await account();
    const uploader = await application();
    const consumer = await application();
    const fileId = (await uploadUserMedia(uploader, owner, randomBytes(48), 'private')).body.data
      .file.id;

    // No grant for `consumer`: the owner attaching the file to it is the consent.
    expect(await linkedUrlIds(consumer, fileId)).toEqual([]);
    as(owner);
    const linked = await request('POST', `/assets/${fileId}/links`, {
      app: consumer,
      entityType: 'note',
      entityId: 'n-1',
    });
    expect(linked.status).toBe(200);
    expect(await linkedUrlIds(consumer, fileId)).toEqual([fileId]);
    as(owner);
    const listed = await request('GET', `/assets/${fileId}/access`);
    expect(
      (listed.body.data.applications as Array<{ applicationId: string; via: string[] }>).map(
        (entry) => [entry.applicationId, entry.via],
      ),
    ).toEqual(
      expect.arrayContaining([
        [uploader, ['upload']],
        [consumer, ['link']],
      ]),
    );

    expect((await request('DELETE', `/assets/${fileId}/access/${consumer}`)).status).toBe(200);
    expect(await linkedUrlIds(consumer, fileId)).toEqual([]);
    // The reference itself (the application's USE) is kept.
    const [file] = await getDb().select().from(files).where(eq(files.id, fileId));
    expect(file.status).toBe('active');

    as(owner);
    await request('POST', `/assets/${fileId}/links`, {
      app: consumer,
      entityType: 'note',
      entityId: 'n-2',
    });
    expect(await linkedUrlIds(consumer, fileId)).toEqual([fileId]);
    const [grant] = await getDb()
      .select()
      .from(fileAccessGrants)
      .where(
        and(eq(fileAccessGrants.fileId, fileId), eq(fileAccessGrants.applicationId, consumer)),
      );
    expect(grant).toMatchObject({ state: 'granted', source: 'owner', revokedAt: null });
  });

  it('answers 404 to anybody but the owner, and for an unknown application', async () => {
    const owner = await account();
    const other = await account();
    const uploader = await application();
    const fileId = (await uploadUserMedia(uploader, owner, randomBytes(40), 'private')).body.data
      .file.id;

    as(other);
    expect((await request('GET', `/assets/${fileId}/access`)).status).toBe(404);
    expect((await request('DELETE', `/assets/${fileId}/access/${uploader}`)).status).toBe(404);
    expect(await linkedUrlIds(uploader, fileId)).toEqual([fileId]);

    as(owner);
    expect(
      (await request('DELETE', `/assets/${fileId}/access/00000000-0000-7000-8000-000000000000`))
        .status,
    ).toBe(404);
  });
});
