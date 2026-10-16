/**
 * Large, any-type uploads by a service token (ADR 0042 stage 4b) — end to end
 * over real `node:http`, the REAL AssetService, the REAL upload-session service
 * and a REAL Postgres.
 *
 * Stubbed: the two auth middlewares, the rate limiter, and S3 — an in-memory
 * bucket that implements multipart uploads (the test PUTs a part by the URL's
 * own coordinates, as a client would PUT to the presigned URL).
 *
 * Invariants:
 *  1. Only bytes that HASH to the declared SHA-256 become a file; anything else
 *     is 422 and leaves no row and no object.
 *  2. Executables and active documents are refused before any upload; non-media
 *     types are stored with `Content-Disposition: attachment`.
 *  3. Unverified bytes are never under `public/` (the CDN's origin).
 *  4. Blocked bytes are refused at open AND at completion (blocked meanwhile).
 *  5. An upload is its uploader's, for its owner: anybody else gets 404.
 *  6. Resume: the same bytes reopened answer the open session with what S3 holds.
 *  7. A third-party application's upload is reserved against its developer's
 *     plan before a byte is sent, and released when it does not become a file.
 */

process.env.LARGE_UPLOAD_COMPLETE_WAIT_MS = '3000';

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, eq, isNull } from 'drizzle-orm';

const mockServiceAuthMiddleware = jest.fn();

interface MockMultipart {
  key: string;
  contentType: string;
  contentDisposition?: string;
  parts: Map<number, Buffer>;
}

const mockObjects = new Map<
  string,
  { bytes: Buffer; contentType?: string; disposition?: string }
>();
const mockUploads = new Map<string, MockMultipart>();
let mockReadGate: Promise<void> | null = null;

const mockS3 = {
  uploadStream: jest.fn(async (key: string, body: Readable, options?: { contentType?: string }) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    mockObjects.set(key, { bytes: Buffer.concat(chunks), contentType: options?.contentType });
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
  listFiles: jest.fn(async (prefix: string) =>
    [...mockObjects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
  ),
  getPresignedDownloadUrl: jest.fn(async (key: string) => `https://signed.example/${key}`),
  getObjectStreamRange: jest.fn(async (key: string) => {
    const object = mockObjects.get(key);
    if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    if (mockReadGate) await mockReadGate;
    return {
      body: Readable.from([object.bytes]),
      contentType: object.contentType,
      statusCode: 200,
    };
  }),
  createMultipartUpload: jest.fn(
    async (key: string, options: { contentType: string; contentDisposition?: string }) => {
      const id = `upload-${randomBytes(6).toString('hex')}`;
      mockUploads.set(id, {
        key,
        contentType: options.contentType,
        contentDisposition: options.contentDisposition,
        parts: new Map(),
      });
      return id;
    },
  ),
  getPresignedUploadPartUrl: jest.fn(
    async (key: string, uploadId: string, partNumber: number, options: { contentLength: number }) =>
      `https://bucket.example/${key}?uploadId=${uploadId}&partNumber=${partNumber}&size=${options.contentLength}`,
  ),
  listParts: jest.fn(async (_key: string, uploadId: string) => {
    const upload = mockUploads.get(uploadId);
    if (!upload) return null;
    return [...upload.parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([partNumber, bytes]) => ({
        partNumber,
        size: bytes.length,
        etag: `"etag-${partNumber}"`,
      }));
  }),
  completeMultipartUpload: jest.fn(async (key: string, uploadId: string) => {
    const upload = mockUploads.get(uploadId);
    if (!upload) throw Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload' });
    const bytes = Buffer.concat(
      [...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part),
    );
    mockObjects.set(key, {
      bytes,
      contentType: upload.contentType,
      disposition: upload.contentDisposition,
    });
    mockUploads.delete(uploadId);
  }),
  abortMultipartUpload: jest.fn(async (_key: string, uploadId: string) => {
    mockUploads.delete(uploadId);
  }),
};

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
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

import {
  EMPTY_PRODUCT_BILLING_CATALOGUE,
  type ProductBillingCatalogue,
} from '../../services/productBillingCatalogue.service';
let mockCatalogue: ProductBillingCatalogue = EMPTY_PRODUCT_BILLING_CATALOGUE;
jest.mock('../../services/productBillingCatalogue.service', () => ({
  ...jest.requireActual('../../services/productBillingCatalogue.service'),
  loadProductBillingCatalogue: () => Promise.resolve(mockCatalogue),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  applications,
  blockedContentHashes,
  contentClaims,
  fileReferences,
  files,
  fileUploadSessions,
  storageByteReservations,
  users,
} from '../../db/schema';
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';
import fileCache from '../../utils/fileCache';
import { productAccessFixture } from '../../services/__fixtures__/productAccessFixtures';
import { legacyStorageLimit, reservedStorageBytes } from '../../services/storageQuota.service';
import { insertFile } from '../../services/fileRepository';
import { fileUploadSessionService } from '../../services/fileUploadSessionSingleton';

jest.setTimeout(60_000);

const APP_SCOPES = ['files:app:write', 'files:references:write'];

interface JsonResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the route answered.
  body: { data?: any; message?: string; code?: string; error?: any; details?: any };
}

let server: http.Server;

function request(
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          ...(body
            ? { 'content-type': 'application/json', 'content-length': String(body.length) }
            : {}),
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

function actAs(appId: string, scopes: string[] = APP_SCOPES): void {
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

/** PUT a part the way a client PUTs to its presigned URL. */
function putPart(url: string, bytes: Buffer): void {
  const parsed = new URL(url);
  const upload = mockUploads.get(String(parsed.searchParams.get('uploadId')));
  if (!upload) throw new Error('no such upload');
  if (Number(parsed.searchParams.get('size')) !== bytes.length) throw new Error('signed size');
  upload.parts.set(Number(parsed.searchParams.get('partNumber')), bytes);
}

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

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

async function block(sha256: string): Promise<void> {
  const [claim] = await getDb()
    .insert(contentClaims)
    .values({
      reference: `OXY-${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`,
      kind: 'copyright',
      relationship: 'rights_holder',
      state: 'actioned',
    })
    .returning({ id: contentClaims.id });
  await getDb().insert(blockedContentHashes).values({ sha256, claimId: claim.id });
}

async function fileRow(id: string) {
  const [stored] = await getDb().select().from(files).where(eq(files.id, id));
  return stored;
}

async function sessionRow(id: string) {
  const [stored] = await getDb()
    .select()
    .from(fileUploadSessions)
    .where(eq(fileUploadSessions.id, id));
  return stored;
}

/** Open, PUT every part (of `sent`, default the declared bytes), complete. */
async function uploadWhole(
  base: string,
  bytes: Buffer,
  body: Record<string, unknown>,
  options: { sent?: Buffer; headers?: Record<string, string> } = {},
): Promise<{ open: JsonResponse; complete: JsonResponse }> {
  const open = await request(
    'POST',
    base,
    { sha256: sha(bytes), size: bytes.length, ...body },
    options.headers,
  );
  if (open.status !== 201) return { open, complete: open };
  const sent = options.sent ?? bytes;
  const { partSize, uploadId } = open.body.data;
  for (const part of open.body.data.parts) {
    putPart(part.url, sent.subarray((part.partNumber - 1) * partSize, part.partNumber * partSize));
  }
  const complete = await request(
    'POST',
    `${base}/${uploadId}/complete`,
    undefined,
    options.headers,
  );
  return { open, complete };
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
  mockCatalogue = EMPTY_PRODUCT_BILLING_CATALOGUE;
  mockReadGate = null;
});

describe('POST /assets/service/app/uploads — any type, verified', () => {
  it('stores a zip the application owns, as an attachment, after hashing it', async () => {
    const appId = await application();
    actAs(appId);
    const bytes = randomBytes(3000);

    const { open, complete } = await uploadWhole('/assets/service/app/uploads', bytes, {
      mime: 'application/zip',
      visibility: 'private',
      filename: 'catalogue.zip',
    });

    expect(open.status).toBe(201);
    expect(open.body.data).toMatchObject({ status: 'uploading', partCount: 1, size: 3000 });
    expect(complete.status).toBe(200);
    expect(complete.body.data).toMatchObject({
      status: 'completed',
      deduplicated: false,
      file: { ownerApplicationId: appId, mime: 'application/zip', ext: '.zip', size: 3000 },
    });
    const stored = await fileRow(complete.body.data.file.id);
    expect(stored).toMatchObject({
      ownerApplicationId: appId,
      sha256: sha(bytes),
      status: 'active',
    });
    expect(stored.storageKey.startsWith('public/')).toBe(false);
    expect(mockObjects.get(stored.storageKey)).toMatchObject({ disposition: 'attachment' });
  });

  it('assembles several parts in order and stores media inline', async () => {
    const appId = await application();
    actAs(appId);
    const bytes = randomBytes(8 * 1024 * 1024 + 4096);

    const { open, complete } = await uploadWhole('/assets/service/app/uploads', bytes, {
      mime: 'video/mp4',
      visibility: 'private',
    });

    expect(open.body.data.partCount).toBe(2);
    expect(open.body.data.parts.map((part: { size: number }) => part.size)).toEqual([
      8 * 1024 * 1024,
      4096,
    ]);
    expect(complete.status).toBe(200);
    const stored = await fileRow(complete.body.data.file.id);
    expect(mockObjects.get(stored.storageKey)?.bytes.equals(bytes)).toBe(true);
    expect(mockObjects.get(stored.storageKey)?.disposition).toBe('inline');
  });

  it('keeps unverified bytes off public/ and moves a public file there only once verified', async () => {
    actAs(await application());
    const bytes = randomBytes(2048);
    const createdKeys: string[] = [];
    mockS3.createMultipartUpload.mockImplementationOnce(async (key, options) => {
      createdKeys.push(key);
      const id = `upload-${randomBytes(6).toString('hex')}`;
      mockUploads.set(id, { key, contentType: options.contentType, parts: new Map() });
      return id;
    });

    const { complete } = await uploadWhole('/assets/service/app/uploads', bytes, {
      mime: 'image/png',
      visibility: 'public',
    });

    expect(createdKeys[0].startsWith('public/')).toBe(false);
    const stored = await fileRow(complete.body.data.file.id);
    expect(stored.storageKey).toBe(`public/${createdKeys[0]}`);
    expect(mockObjects.has(createdKeys[0])).toBe(false);
    expect(mockObjects.get(stored.storageKey)?.bytes.equals(bytes)).toBe(true);
  });

  it("shares another owner's stored object of the same bytes, deleting its own copy", async () => {
    const bytes = randomBytes(700);
    actAs(await application());
    const first = await uploadWhole('/assets/service/app/uploads', bytes, {
      mime: 'application/zip',
      visibility: 'private',
    });
    const firstKey = (await fileRow(first.complete.body.data.file.id)).storageKey;

    actAs(await application());
    const second = await uploadWhole('/assets/service/app/uploads', bytes, {
      mime: 'application/zip',
      visibility: 'private',
    });

    expect(second.complete.status).toBe(200);
    const stored = await fileRow(second.complete.body.data.file.id);
    expect(stored.id).not.toBe(first.complete.body.data.file.id);
    expect(stored.storageKey).toBe(firstKey);
    const session = await sessionRow(second.open.body.data.uploadId);
    expect(session.stagingKey).not.toBe(firstKey);
    expect(mockObjects.has(session.stagingKey)).toBe(false);
  });

  it('refuses bytes that do not hash to the declared sha256: no row, no object', async () => {
    actAs(await application());
    const declared = randomBytes(1024);
    const sent = randomBytes(1024);
    const filesBefore = (await getDb().select({ id: files.id }).from(files)).length;

    const { open, complete } = await uploadWhole(
      '/assets/service/app/uploads',
      declared,
      { mime: 'application/pdf', visibility: 'private' },
      { sent },
    );

    expect(complete.status).toBe(422);
    expect(complete.body.error).toBe('CHECKSUM_MISMATCH');
    const session = await sessionRow(open.body.data.uploadId);
    expect(session).toMatchObject({
      status: 'failed',
      errorCode: 'CHECKSUM_MISMATCH',
      fileId: null,
    });
    expect(mockObjects.has(session.stagingKey)).toBe(false);
    expect((await getDb().select({ id: files.id }).from(files)).length).toBe(filesBefore);
  });

  it('refuses executables, active documents and oversize files before any upload', async () => {
    actAs(await application());
    const before = mockS3.createMultipartUpload.mock.calls.length;
    const open = (body: Record<string, unknown>) =>
      request('POST', '/assets/service/app/uploads', {
        sha256: sha(randomBytes(8)),
        size: 100,
        visibility: 'private',
        ...body,
      });

    expect((await open({ mime: 'text/html' })).status).toBe(415);
    expect((await open({ mime: 'image/svg+xml' })).status).toBe(415);
    expect((await open({ mime: 'application/x-msdownload' })).status).toBe(415);
    expect((await open({ mime: 'application/octet-stream', filename: 'setup.EXE' })).status).toBe(
      415,
    );
    expect((await open({ mime: 'not a type' })).status).toBe(400);
    expect((await open({ mime: 'application/zip', size: 8 * 1024 ** 3 + 1 })).status).toBe(413);
    expect(mockS3.createMultipartUpload.mock.calls.length).toBe(before);
  });

  it('refuses blocked bytes at open, and bytes blocked while they were uploading at completion', async () => {
    actAs(await application());
    const blocked = randomBytes(512);
    await block(sha(blocked));
    const refused = await request('POST', '/assets/service/app/uploads', {
      sha256: sha(blocked),
      size: blocked.length,
      mime: 'application/zip',
      visibility: 'private',
    });
    expect(refused.status).toBe(451);
    expect(refused.body.error).toBe('CONTENT_BLOCKED');

    const later = randomBytes(512);
    const open = await request('POST', '/assets/service/app/uploads', {
      sha256: sha(later),
      size: later.length,
      mime: 'application/zip',
      visibility: 'public',
    });
    putPart(open.body.data.parts[0].url, later);
    await block(sha(later));
    const complete = await request(
      'POST',
      `/assets/service/app/uploads/${open.body.data.uploadId}/complete`,
    );
    expect(complete.status).toBe(451);
    const session = await sessionRow(open.body.data.uploadId);
    expect(session.status).toBe('failed');
    expect(mockObjects.has(session.stagingKey)).toBe(false);
    expect(mockObjects.has(`public/${session.stagingKey}`)).toBe(false);
    // Never copied to the CDN's prefix at all, not even for a moment.
    expect(mockS3.copyFile.mock.calls.map(([, to]) => to)).not.toContain(
      `public/${session.stagingKey}`,
    );
    expect(
      await getDb()
        .select({ id: files.id })
        .from(files)
        .where(eq(files.sha256, sha(later))),
    ).toEqual([]);
  });

  it('answers the bytes the application already owns without an upload', async () => {
    const appId = await application();
    actAs(appId);
    const bytes = randomBytes(256);
    const first = await uploadWhole('/assets/service/app/uploads', bytes, {
      mime: 'application/zip',
      visibility: 'private',
    });
    const before = mockS3.createMultipartUpload.mock.calls.length;

    const again = await request('POST', '/assets/service/app/uploads', {
      sha256: sha(bytes),
      size: bytes.length,
      mime: 'application/zip',
      visibility: 'public',
    });

    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({
      uploadId: null,
      status: 'completed',
      deduplicated: true,
      file: { id: first.complete.body.data.file.id, visibility: 'private' },
    });
    expect(mockS3.createMultipartUpload.mock.calls.length).toBe(before);
  });

  it('resumes: reopening the same bytes answers the open session with the parts S3 holds', async () => {
    actAs(await application());
    const bytes = randomBytes(16 * 1024 * 1024 + 10);
    const body = {
      sha256: sha(bytes),
      size: bytes.length,
      mime: 'video/mp4',
      visibility: 'private',
    };
    const first = await request('POST', '/assets/service/app/uploads', body);
    const { partSize, uploadId } = first.body.data;
    putPart(first.body.data.parts[0].url, bytes.subarray(0, partSize));

    const second = await request('POST', '/assets/service/app/uploads', body);
    expect(second.status).toBe(201);
    expect(second.body.data.uploadId).toBe(uploadId);
    expect(second.body.data.uploadedParts).toEqual([{ partNumber: 1, size: partSize }]);
    expect(second.body.data.parts.map((part: { partNumber: number }) => part.partNumber)).toEqual([
      2, 3,
    ]);

    const early = await request('POST', `/assets/service/app/uploads/${uploadId}/complete`);
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('UPLOAD_INCOMPLETE');
    expect((await sessionRow(uploadId)).status).toBe('uploading');

    const more = await request('POST', `/assets/service/app/uploads/${uploadId}/parts`, {
      partNumbers: [2, 3],
    });
    for (const part of more.body.data.parts) {
      putPart(
        part.url,
        bytes.subarray((part.partNumber - 1) * partSize, part.partNumber * partSize),
      );
    }
    const done = await request('POST', `/assets/service/app/uploads/${uploadId}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.data.file.size).toBe(bytes.length);
  });

  it('is its uploader’s: another application gets 404 on every route of it', async () => {
    const appId = await application();
    actAs(appId);
    const bytes = randomBytes(64);
    const open = await request('POST', '/assets/service/app/uploads', {
      sha256: sha(bytes),
      size: bytes.length,
      mime: 'application/zip',
      visibility: 'private',
    });
    const uploadId = open.body.data.uploadId;

    actAs(await application());
    expect((await request('GET', `/assets/service/app/uploads/${uploadId}`)).status).toBe(404);
    expect(
      (await request('POST', `/assets/service/app/uploads/${uploadId}/parts`, { partNumbers: [1] }))
        .status,
    ).toBe(404);
    expect((await request('POST', `/assets/service/app/uploads/${uploadId}/complete`)).status).toBe(
      404,
    );
    expect((await request('DELETE', `/assets/service/app/uploads/${uploadId}`)).status).toBe(404);
    expect((await sessionRow(uploadId)).status).toBe('uploading');
  });

  it('registers the reference it asked for, and needs files:references:write to ask', async () => {
    const appId = await application();
    actAs(appId, ['files:app:write']);
    const bytes = randomBytes(64);
    const body = {
      sha256: sha(bytes),
      size: bytes.length,
      mime: 'application/zip',
      visibility: 'private',
      reference: { entityType: 'deliverable', entityId: 'listing-1' },
    };
    expect((await request('POST', '/assets/service/app/uploads', body)).status).toBe(403);

    actAs(appId);
    const { complete } = await uploadWhole('/assets/service/app/uploads', bytes, body);
    expect(complete.body.data.reference).toEqual({ result: 'created' });
    expect(
      await getDb()
        .select({ entityId: fileReferences.entityId })
        .from(fileReferences)
        .where(eq(fileReferences.fileId, complete.body.data.file.id)),
    ).toEqual([{ entityId: 'listing-1' }]);
  });

  it('aborts on DELETE: S3 discards the parts and completion is refused', async () => {
    actAs(await application());
    const bytes = randomBytes(64);
    const open = await request('POST', '/assets/service/app/uploads', {
      sha256: sha(bytes),
      size: bytes.length,
      mime: 'application/zip',
      visibility: 'private',
    });
    const uploadId = open.body.data.uploadId;

    const aborted = await request('DELETE', `/assets/service/app/uploads/${uploadId}`);
    expect(aborted.body.data).toMatchObject({ status: 'aborted', error: { code: 'ABORTED' } });
    expect(mockS3.abortMultipartUpload).toHaveBeenCalled();
    const complete = await request('POST', `/assets/service/app/uploads/${uploadId}/complete`);
    expect(complete.status).toBe(410);
  });

  it('answers 202 while verifying, and the worker sweep finishes what the request left', async () => {
    const appId = await application();
    actAs(appId);
    const bytes = randomBytes(128);
    let release: () => void = () => undefined;
    mockReadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    process.env.LARGE_UPLOAD_COMPLETE_WAIT_MS = '3000';

    const pending = uploadWhole('/assets/service/app/uploads', bytes, {
      mime: 'application/zip',
      visibility: 'private',
    });
    const { open, complete } = await pending;
    expect(complete.status).toBe(202);
    expect(complete.body.data.status).toBe('verifying');

    // The request's verifier is stuck reading; its lease runs out (simulated) and
    // the sweep takes the session over once the read is possible again.
    await getDb()
      .update(fileUploadSessions)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(fileUploadSessions.id, open.body.data.uploadId));
    mockReadGate = null;
    await fileUploadSessionService.sweep();
    release();

    const status = await request('GET', `/assets/service/app/uploads/${open.body.data.uploadId}`);
    expect(status.body.data).toMatchObject({
      status: 'completed',
      file: { ownerApplicationId: appId },
    });
  });

  it('aborts uploads nobody completed by their deadline', async () => {
    actAs(await application());
    const bytes = randomBytes(64);
    const open = await request('POST', '/assets/service/app/uploads', {
      sha256: sha(bytes),
      size: bytes.length,
      mime: 'application/zip',
      visibility: 'private',
    });
    await getDb()
      .update(fileUploadSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(fileUploadSessions.id, open.body.data.uploadId));

    await fileUploadSessionService.sweep();

    expect(await sessionRow(open.body.data.uploadId)).toMatchObject({
      status: 'aborted',
      errorCode: 'EXPIRED',
    });
  });
});

function rawGet(path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', host: '127.0.0.1', port: address.port, path },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('GET /assets/:id/stream — what a browser may render', () => {
  it('serves a non-media file as a sandboxed attachment, and media inline', async () => {
    actAs(await application());
    const zip = await uploadWhole('/assets/service/app/uploads', randomBytes(100), {
      mime: 'application/zip',
      visibility: 'unlisted',
    });
    const video = await uploadWhole('/assets/service/app/uploads', randomBytes(100), {
      mime: 'video/mp4',
      visibility: 'unlisted',
    });

    const download = await rawGet(`/assets/${zip.complete.body.data.file.id}/stream`);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toBe('attachment');
    expect(download.headers['content-security-policy']).toContain('sandbox');

    const inline = await rawGet(`/assets/${video.complete.body.data.file.id}/stream`);
    expect(inline.status).toBe(200);
    expect(inline.headers['content-disposition']).toBeUndefined();
    expect(inline.headers['content-security-policy']).toBeUndefined();
  });
});

describe('POST /assets/service/user-media/uploads — an account owns it', () => {
  it("stores the file as the header's account, and only that account's uploader continues it", async () => {
    const appId = await application();
    actAs(appId, ['files:user-media:write']);
    const owner = await account();
    const other = await account();
    const bytes = randomBytes(200);

    const open = await request(
      'POST',
      '/assets/service/user-media/uploads',
      { sha256: sha(bytes), size: bytes.length, mime: 'application/epub+zip' },
      { 'x-owner-user-id': owner },
    );
    expect(open.status).toBe(201);
    putPart(open.body.data.parts[0].url, bytes);
    const uploadId = open.body.data.uploadId;

    const wrongOwner = await request(
      'POST',
      `/assets/service/user-media/uploads/${uploadId}/complete`,
      undefined,
      { 'x-owner-user-id': other },
    );
    expect(wrongOwner.status).toBe(404);

    const complete = await request(
      'POST',
      `/assets/service/user-media/uploads/${uploadId}/complete`,
      undefined,
      { 'x-owner-user-id': owner },
    );
    expect(complete.status).toBe(200);
    expect(complete.body.data.file).toMatchObject({
      visibility: 'public',
      mime: 'application/epub+zip',
    });
    expect(await fileRow(complete.body.data.file.id)).toMatchObject({
      ownerUserId: owner,
      ownerApplicationId: null,
    });
  });

  it('needs the user-media authority', async () => {
    actAs(await application(), ['files:app:write', 'files:write']);
    const res = await request(
      'POST',
      '/assets/service/user-media/uploads',
      { sha256: sha(randomBytes(4)), size: 4, mime: 'application/zip' },
      { 'x-owner-user-id': await account() },
    );
    expect(res.status).toBe(403);
  });
});

describe("a third-party application's upload and its developer's plan (ADR 0042 D3)", () => {
  function configureQuota(products: { id: string }[]): void {
    mockCatalogue = {
      ...EMPTY_PRODUCT_BILLING_CATALOGUE,
      products: products as ProductBillingCatalogue['products'],
      storageAdapter: {
        productId: products[0].id,
        quotaKey: 'storage_bytes',
        unit: 'byte',
        legacyCombination: 'maximum',
      },
    };
  }

  async function filler(ownerUserId: string, size: number): Promise<void> {
    const content = randomBytes(16);
    await insertFile({
      sha256: sha(content),
      size,
      mime: 'application/zip',
      ext: '.zip',
      ownerUserId,
      systemOwner: null,
      status: 'active',
      storageKey: `content/test/${sha(content)}.zip`,
    });
  }

  it('refuses at open what the plan cannot hold, before any upload', async () => {
    const f = await productAccessFixture();
    configureQuota(f.products);
    const appId = await application({ type: 'third_party', ownerAccountId: f.payer });
    actAs(appId);
    await filler(f.payer, legacyStorageLimit('basic') - 10);
    const before = mockS3.createMultipartUpload.mock.calls.length;

    const res = await request('POST', '/assets/service/app/uploads', {
      sha256: sha(randomBytes(32)),
      size: 100,
      mime: 'application/zip',
      visibility: 'private',
    });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('STORAGE_QUOTA_EXCEEDED');
    expect(mockS3.createMultipartUpload.mock.calls.length).toBe(before);
  });

  it('reserves the whole file at open, counts it once as a file, and releases an abort', async () => {
    const f = await productAccessFixture();
    configureQuota(f.products);
    const appId = await application({ type: 'third_party', ownerAccountId: f.payer });
    actAs(appId);
    const start = await reservedStorageBytes(getDb(), f.payer);

    const kept = randomBytes(300);
    const { open, complete } = await uploadWhole('/assets/service/app/uploads', kept, {
      mime: 'application/zip',
      visibility: 'public',
    });
    expect(complete.status).toBe(200);
    expect((await sessionRow(open.body.data.uploadId)).reservationId).not.toBeNull();
    expect(await reservedStorageBytes(getDb(), f.payer)).toBe(start + BigInt(300));

    const dropped = randomBytes(500);
    const opened = await request('POST', '/assets/service/app/uploads', {
      sha256: sha(dropped),
      size: dropped.length,
      mime: 'application/zip',
      visibility: 'private',
    });
    expect(await reservedStorageBytes(getDb(), f.payer)).toBe(start + BigInt(800));
    await request('DELETE', `/assets/service/app/uploads/${opened.body.data.uploadId}`);
    expect(await reservedStorageBytes(getDb(), f.payer)).toBe(start + BigInt(300));
    expect(
      await getDb()
        .select({ id: storageByteReservations.id })
        .from(storageByteReservations)
        .where(
          and(
            eq(storageByteReservations.accountId, f.payer),
            eq(storageByteReservations.sha256, sha(dropped)),
            isNull(storageByteReservations.cleanedAt),
          ),
        ),
    ).toEqual([]);
  });
});
