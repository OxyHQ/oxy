/**
 * Session routes that act on a file as its OWNER refuse everybody else — over
 * real `node:http`, the REAL AssetService and a REAL Postgres.
 *
 * Stubbed: the session middleware (a case sets the subject), the operator
 * lookup (a case sets the human operating the session), the rate limiter and S3.
 *
 * "Owner" is the file's account being the session's subject OR the human
 * operating it — an operated session speaks as a managed account with its
 * operator's authority (`middleware/operator.ts`), which is how GoWay attaches a
 * person's own upload while they act for their business.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';

let mockSubjectId = 'nobody';
let mockOperatorId: string | null = null;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { _id: string } }, _res: unknown, next: () => void) => {
    req.user = { _id: mockSubjectId };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/operator', () => ({
  resolveOperatorId: async () => mockOperatorId ?? mockSubjectId,
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../services/s3ServiceSingleton', () => ({
  s3Service: {
    fileExists: jest.fn(async () => true),
    deleteFile: jest.fn(async () => undefined),
    listFiles: jest.fn(async () => []),
    copyFile: jest.fn(async () => undefined),
  },
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
import { files, users } from '../../db/schema';
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';
import fileCache from '../../utils/fileCache';

jest.setTimeout(60_000);

interface JsonResponse {
  status: number;
  body: { data?: Record<string, unknown>; message?: string };
}

let server: http.Server;

function send(method: string, path: string, payload?: unknown): Promise<JsonResponse> {
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

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function fileOf(
  ownerUserId: string,
  values: Partial<typeof files.$inferInsert> = {},
): Promise<string> {
  const sha256 = randomBytes(32).toString('hex');
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256,
      size: 10,
      mime: 'image/png',
      ext: '.png',
      storageKey: `content/2026/10/${sha256.slice(0, 2)}/${sha256}.png`,
      ownerUserId,
      visibility: 'private',
      ...values,
    })
    .returning({ id: files.id });
  return row.id;
}

async function row(id: string) {
  const [stored] = await getDb().select().from(files).where(eq(files.id, id));
  return stored;
}

function actAs(subjectId: string, operatorId: string | null = null): void {
  mockSubjectId = subjectId;
  mockOperatorId = operatorId;
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

describe('GET /assets/:id/exists — the storage key is the owner’s business only', () => {
  it('answers the owner, and the human operating the owning account', async () => {
    const owner = await account();
    const id = await fileOf(owner);

    actAs(owner);
    const own = await send('GET', `/assets/${id}/exists`);
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ fileId: id, exists: true });

    actAs(await account(), owner);
    expect((await send('GET', `/assets/${id}/exists`)).status).toBe(200);
  });

  it('is 404 to anybody else, with no storage key in the answer', async () => {
    const id = await fileOf(await account());

    actAs(await account());
    const res = await send('GET', `/assets/${id}/exists`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('content/');
  });
});

describe('POST /assets/:id/restore — only the owner brings a file back from trash', () => {
  it('restores the owner’s trashed file', async () => {
    const owner = await account();
    const id = await fileOf(owner, { status: 'trash' });

    actAs(owner);
    const res = await send('POST', `/assets/${id}/restore`);

    expect(res.status).toBe(200);
    expect((await row(id)).status).toBe('active');
  });

  it('is 404 to anybody else, and the file stays in trash', async () => {
    const id = await fileOf(await account(), { status: 'trash' });

    actAs(await account());
    const res = await send('POST', `/assets/${id}/restore`);

    expect(res.status).toBe(404);
    expect((await row(id)).status).toBe('trash');
  });
});
