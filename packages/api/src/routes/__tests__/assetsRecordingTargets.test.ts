/**
 * Recording targets — LiveKit egress S3 output into Oxy Files (ADR 0043 stage
 * 4c). End to end: the REAL `@aws-sdk/client-s3` (and `@aws-sdk/lib-storage`'s
 * multipart `Upload`, the shape of the Go SDK's upload manager LiveKit uses)
 * signs and sends to the recording ingest over real `node:http`; the REAL
 * ingest, AssetService finalization and Postgres store the file. Stubbed: the
 * service-auth middleware, the rate limiter and the backing bucket (in memory,
 * with multipart).
 *
 * Invariants:
 *  1. The handed-out configuration is what LiveKit's `S3Upload` takes, and the
 *     AWS SDK can write the recording through it — `PutObject`, the multipart
 *     calls, with and without aws-chunked bodies.
 *  2. Only the target's own prefix, one recording, small side objects; only
 *     uploads; a wrong secret, a finished or aborted target are refused in S3's
 *     own error vocabulary.
 *  3. The recording becomes a file only after Oxy hashed it: the owner's, with
 *     the asked-for reference and, for a person, the creator's access grant.
 */

process.env.DEVICE_ID_SALT ??= 'recording-target-test-salt-0123456789abcdef';
process.env.LARGE_UPLOAD_COMPLETE_WAIT_MS = '5000';

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const mockServiceAuthMiddleware = jest.fn();
const mockObjects = new Map<string, { bytes: Buffer; contentType?: string }>();
const mockUploads = new Map<
  string,
  { key: string; contentType: string; parts: Map<number, { bytes: Buffer; etag: string }> }
>();

async function mockDrain(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const mockS3 = {
  uploadStream: jest.fn(async (key: string, body: Readable, options?: { contentType?: string }) => {
    mockObjects.set(key, { bytes: await mockDrain(body), contentType: options?.contentType });
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
  getObjectStreamRange: jest.fn(async (key: string) => {
    const object = mockObjects.get(key);
    if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    return {
      body: Readable.from([object.bytes]),
      contentType: object.contentType,
      statusCode: 200,
    };
  }),
  createMultipartUpload: jest.fn(async (key: string, options: { contentType: string }) => {
    const id = `upload-${randomBytes(6).toString('hex')}`;
    mockUploads.set(id, { key, contentType: options.contentType, parts: new Map() });
    return id;
  }),
  uploadPart: jest.fn(
    async (key: string, uploadId: string, partNumber: number, body: Readable, length: number) => {
      const upload = mockUploads.get(uploadId);
      if (!upload || upload.key !== key) {
        throw Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload' });
      }
      const bytes = await mockDrain(body);
      if (bytes.length !== length) throw new Error('length mismatch');
      const etag = `"${createHash('md5').update(bytes).digest('hex')}"`;
      upload.parts.set(partNumber, { bytes, etag });
      return { etag };
    },
  ),
  listParts: jest.fn(async (_key: string, uploadId: string) => {
    const upload = mockUploads.get(uploadId);
    if (!upload) return null;
    return [...upload.parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([partNumber, part]) => ({ partNumber, size: part.bytes.length, etag: part.etag }));
  }),
  completeMultipartUpload: jest.fn(
    async (key: string, uploadId: string, parts: { partNumber: number }[]) => {
      const upload = mockUploads.get(uploadId);
      if (!upload) throw Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload' });
      const bytes = Buffer.concat(
        parts.map((part) => (upload.parts.get(part.partNumber) as { bytes: Buffer }).bytes),
      );
      mockObjects.set(key, { bytes, contentType: upload.contentType });
      mockUploads.delete(uploadId);
    },
  ),
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

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  applications,
  fileAccessGrants,
  fileIngests,
  fileReferences,
  files,
  users,
} from '../../db/schema';
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';
import fileCache from '../../utils/fileCache';

jest.setTimeout(60_000);

let server: http.Server;
let base: string;

interface JsonResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the route answered.
  body: { data?: any; error?: string; message?: string };
}

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

const APP_SCOPES = ['files:app:write', 'files:references:write', 'files:user-media:write'];

function actAs(appId: string): void {
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
        scopes: APP_SCOPES,
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

interface Target {
  targetId: string;
  filepath: string;
  s3: { accessKey: string; secret: string; region: string; endpoint: string; bucket: string };
  livekit: { filepath: string; s3: Record<string, unknown> };
}

/** An S3 client configured exactly from the target, as LiveKit's egress configures its own. */
function clientFor(target: Target, overrides: Partial<S3ClientConfig> = {}): S3Client {
  return new S3Client({
    endpoint: target.s3.endpoint,
    region: target.s3.region,
    forcePathStyle: true,
    credentials: { accessKeyId: target.s3.accessKey, secretAccessKey: target.s3.secret },
    // What livekit/storage sets for a custom endpoint.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 1,
    ...overrides,
  });
}

async function createTarget(
  appId: string,
  body: Record<string, unknown>,
  path = '/assets/service/app/recording-targets',
  headers: Record<string, string> = {},
): Promise<Target> {
  actAs(appId);
  const res = await request('POST', path, body, headers);
  expect(res.status).toBe(201);
  return res.body.data as Target;
}

async function complete(
  appId: string,
  targetId: string,
  path = '/assets/service/app/recording-targets',
  headers: Record<string, string> = {},
) {
  actAs(appId);
  return request('POST', `${path}/${targetId}/complete`, undefined, headers);
}

async function s3Error(promise: Promise<unknown>): Promise<{ name: string; status?: number }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { name: string; $metadata?: { httpStatusCode?: number } };
    return { name: e.name, status: e.$metadata?.httpStatusCode };
  }
  throw new Error('expected the S3 call to fail');
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  // As `server.ts`: no global parser may read the ingest's bodies.
  app.use((req, res, next) =>
    req.path.startsWith('/assets/recording-ingest/') ? next() : express.json()(req, res, next),
  );
  app.use('/assets', assetsRouter);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

beforeEach(() => {
  fileCache.clear();
});

describe('POST /assets/service/app/recording-targets', () => {
  it('hands out LiveKit’s S3Upload and filepath, scoped to one pending object', async () => {
    const appId = await application();
    const target = await createTarget(appId, { visibility: 'private' });
    expect(target).toMatchObject({
      status: 'awaiting_upload',
      filepath: `${target.targetId}/recording`,
      s3: {
        accessKey: target.targetId,
        region: 'us-east-1',
        endpoint: `${base}/assets/recording-ingest`,
        bucket: 'oxy-recordings',
        forcePathStyle: true,
      },
      livekit: {
        filepath: `${target.targetId}/recording`,
        s3: {
          access_key: target.targetId,
          secret: target.s3.secret,
          region: 'us-east-1',
          endpoint: `${base}/assets/recording-ingest`,
          bucket: 'oxy-recordings',
          force_path_style: true,
        },
      },
    });
    const [row] = await getDb()
      .select()
      .from(fileIngests)
      .where(eq(fileIngests.id, target.targetId));
    expect(row.secretCiphertext).not.toContain(target.s3.secret);
    const early = await complete(appId, target.targetId);
    expect(early).toMatchObject({ status: 409, body: { error: 'RECORDING_NOT_RECEIVED' } });
  });

  it('PutObject (a short recording) becomes the application’s file with its reference', async () => {
    const appId = await application();
    const target = await createTarget(appId, {
      visibility: 'private',
      reference: { entityType: 'room', entityId: 'room-1' },
    });
    const bytes = randomBytes(4000);
    await clientFor(target).send(
      new PutObjectCommand({
        Bucket: target.s3.bucket,
        Key: `${target.filepath}.ogg`,
        Body: bytes,
        ContentType: 'audio/ogg',
      }),
    );
    // LiveKit's manifest, beside it: accepted and discarded.
    await clientFor(target).send(
      new PutObjectCommand({
        Bucket: target.s3.bucket,
        Key: `${target.targetId}/EG_abc.json`,
        Body: '{"egress_id":"EG_abc"}',
        ContentType: 'application/json',
      }),
    );

    // Two completes racing the background verification: ONE finalization.
    const [done, raced] = await Promise.all([
      complete(appId, target.targetId),
      complete(appId, target.targetId),
    ]);
    expect(raced.body.data.file.id).toBe(done.body.data.file.id);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({
      status: 'completed',
      size: 4000,
      deduplicated: false,
      reference: { result: 'created' },
      file: { ownerApplicationId: appId, mime: 'audio/ogg', visibility: 'private', size: 4000 },
    });
    const [file] = await getDb().select().from(files).where(eq(files.id, done.body.data.file.id));
    expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(file.storageKey.startsWith('public/')).toBe(false);
    expect(mockObjects.get(file.storageKey)?.bytes.equals(bytes)).toBe(true);
    const [reference] = await getDb()
      .select()
      .from(fileReferences)
      .where(eq(fileReferences.fileId, file.id));
    expect(reference).toMatchObject({
      applicationId: appId,
      entityType: 'room',
      entityId: 'room-1',
    });

    // Received: the recording cannot be written again (a side object still can).
    const late = await s3Error(
      clientFor(target).send(
        new PutObjectCommand({
          Bucket: target.s3.bucket,
          Key: `${target.filepath}.ogg`,
          Body: bytes,
        }),
      ),
    );
    expect(late).toMatchObject({ status: 400 });
  });

  it('a multipart upload (lib-storage, 5 MiB parts) is assembled, hashed, and stored', async () => {
    const appId = await application();
    const target = await createTarget(appId, { visibility: 'public' });
    const bytes = randomBytes(11 * 1024 * 1024 + 123);
    await new Upload({
      client: clientFor(target),
      params: {
        Bucket: target.s3.bucket,
        Key: `${target.filepath}.mp4`,
        Body: bytes,
        ContentType: 'video/mp4',
      },
      partSize: 5 * 1024 * 1024,
      queueSize: 3,
    }).done();

    const done = await complete(appId, target.targetId);
    expect(done.status).toBe(200);
    const [file] = await getDb().select().from(files).where(eq(files.id, done.body.data.file.id));
    expect(file).toMatchObject({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      mime: 'video/mp4',
      ext: '.mp4',
      visibility: 'public',
    });
    // Public only once verified: the file's key is the public spelling now.
    expect(file.storageKey.startsWith('public/')).toBe(true);
    expect(mockObjects.get(file.storageKey)?.bytes.equals(bytes)).toBe(true);
  });

  it('accepts an aws-chunked streaming body (the SDK’s default flexible checksums)', async () => {
    const appId = await application();
    const target = await createTarget(appId, { visibility: 'private' });
    const bytes = randomBytes(70_000);
    await clientFor(target, {
      requestChecksumCalculation: 'WHEN_SUPPORTED',
      responseChecksumValidation: 'WHEN_SUPPORTED',
    }).send(
      new PutObjectCommand({
        Bucket: target.s3.bucket,
        Key: `${target.filepath}.m4a`,
        Body: Readable.from([bytes.subarray(0, 30_000), bytes.subarray(30_000)]),
        ContentLength: bytes.length,
        ContentType: 'audio/mp4',
      }),
    );
    const done = await complete(appId, target.targetId);
    expect(done.status).toBe(200);
    const [file] = await getDb().select().from(files).where(eq(files.id, done.body.data.file.id));
    expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('refuses a wrong secret, other keys, a second recording, reads, and too many bytes', async () => {
    const appId = await application();
    const target = await createTarget(appId, { visibility: 'private', maxBytes: 1000 });
    const forged = clientFor({ ...target, s3: { ...target.s3, secret: 'x'.repeat(40) } });
    expect(
      await s3Error(
        forged.send(
          new PutObjectCommand({
            Bucket: target.s3.bucket,
            Key: `${target.filepath}.ogg`,
            Body: 'a',
          }),
        ),
      ),
    ).toMatchObject({ name: 'SignatureDoesNotMatch', status: 403 });

    const client = clientFor(target);
    expect(
      await s3Error(
        client.send(
          new PutObjectCommand({ Bucket: target.s3.bucket, Key: 'elsewhere/x.ogg', Body: 'a' }),
        ),
      ),
    ).toMatchObject({ name: 'AccessDenied', status: 403 });
    expect(
      await s3Error(
        client.send(
          new PutObjectCommand({
            Bucket: 'another-bucket',
            Key: `${target.filepath}.ogg`,
            Body: 'a',
          }),
        ),
      ),
    ).toMatchObject({ name: 'NoSuchBucket', status: 404 });
    expect(
      await s3Error(
        client.send(
          new GetObjectCommand({ Bucket: target.s3.bucket, Key: `${target.filepath}.ogg` }),
        ),
      ),
    ).toMatchObject({ status: 501 });
    expect(
      await s3Error(
        client.send(
          new PutObjectCommand({
            Bucket: target.s3.bucket,
            Key: `${target.filepath}.txt.exe`,
            Body: 'MZ',
            ContentType: 'application/x-msdownload',
          }),
        ),
      ),
    ).toMatchObject({ status: 400 });
    expect(
      await s3Error(
        client.send(
          new PutObjectCommand({
            Bucket: target.s3.bucket,
            Key: `${target.filepath}.ogg`,
            Body: randomBytes(1001),
            ContentType: 'audio/ogg',
          }),
        ),
      ),
    ).toMatchObject({ name: 'EntityTooLarge', status: 400 });

    await client.send(
      new PutObjectCommand({
        Bucket: target.s3.bucket,
        Key: `${target.filepath}.ogg`,
        Body: randomBytes(500),
        ContentType: 'audio/ogg',
      }),
    );
    expect((await complete(appId, target.targetId)).status).toBe(200);
  });

  it('an aborted target refuses its credentials and keeps nothing', async () => {
    const appId = await application();
    const target = await createTarget(appId, { visibility: 'private' });
    actAs(appId);
    const aborted = await request(
      'DELETE',
      `/assets/service/app/recording-targets/${target.targetId}`,
    );
    expect(aborted.body.data).toMatchObject({ status: 'aborted', error: { code: 'ABORTED' } });
    expect(
      await s3Error(
        clientFor(target).send(
          new PutObjectCommand({
            Bucket: target.s3.bucket,
            Key: `${target.filepath}.ogg`,
            Body: 'a',
          }),
        ),
      ),
    ).toMatchObject({ name: 'InvalidAccessKeyId' });
    expect((await complete(appId, target.targetId)).status).toBe(410);
    const other = await application();
    actAs(other);
    expect(
      (await request('GET', `/assets/service/app/recording-targets/${target.targetId}`)).status,
    ).toBe(404);
  });
});

describe('POST /assets/service/user-media/recording-targets', () => {
  it('records into a person’s private file that the creating application may read back', async () => {
    const appId = await application();
    const person = await account();
    const path = '/assets/service/user-media/recording-targets';
    const headers = { 'x-owner-user-id': person };
    const target = await createTarget(appId, {}, path, headers);
    const bytes = randomBytes(2048);
    await clientFor(target).send(
      new PutObjectCommand({
        Bucket: target.s3.bucket,
        Key: `${target.filepath}.ogg`,
        Body: bytes,
        ContentType: 'audio/ogg',
      }),
    );
    const done = await complete(appId, target.targetId, path, headers);
    expect(done.status).toBe(200);
    expect(done.body.data.file).toMatchObject({ visibility: 'private', mime: 'audio/ogg' });
    const [file] = await getDb().select().from(files).where(eq(files.id, done.body.data.file.id));
    expect(file.ownerUserId).toBe(person);
    const [grant] = await getDb()
      .select()
      .from(fileAccessGrants)
      .where(and(eq(fileAccessGrants.fileId, file.id), eq(fileAccessGrants.applicationId, appId)));
    expect(grant).toMatchObject({ state: 'granted', source: 'upload' });

    // Another owner header does not reach this target.
    actAs(appId);
    expect(
      (
        await request('GET', `${path}/${target.targetId}`, undefined, {
          'x-owner-user-id': await account(),
        })
      ).status,
    ).toBe(404);
  });
});
