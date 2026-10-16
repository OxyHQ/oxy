/**
 * `POST /assets/service/app/adopt` (ADR 0042 stage 4b) — an application takes
 * ownership of a file it can read, without uploading it again — end to end over
 * real `node:http`, the REAL AssetService and a REAL Postgres; S3 is an
 * in-memory bucket.
 *
 * Invariants:
 *  1. Readable means what a reference may name: an active public/unlisted file
 *     of anyone, an account's private file its owner attached to THIS
 *     application (ADR 0021), the application's own file. Anything else is 404.
 *  2. The copy is never more visible than the source.
 *  3. The bytes are shared (no byte moves unless a new key spelling is needed).
 *  4. Blocked bytes are 451. Idempotent per (application, bytes).
 *  5. A third-party application's adoption counts toward its developer's plan.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';

const mockServiceAuthMiddleware = jest.fn();
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
  listFiles: jest.fn(async () => []),
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
  users,
} from '../../db/schema';
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';
import fileCache from '../../utils/fileCache';
import { insertFile, insertFileReference } from '../../services/fileRepository';
import { productAccessFixture } from '../../services/__fixtures__/productAccessFixtures';
import { legacyStorageLimit } from '../../services/storageQuota.service';
import type { FileVisibility } from '../../types/file.types';

jest.setTimeout(60_000);

interface JsonResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the route answered.
  body: { data?: any; error?: string; message?: string };
}

let server: http.Server;

function adopt(payload: Record<string, unknown>): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path: '/assets/service/app/adopt',
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw || '{}') }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function actAs(appId: string, scopes = ['files:app:write', 'files:references:write']): void {
  mockServiceAuthMiddleware.mockImplementation(
    (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
      req.serviceApp = { type: 'service', appId, appName: 'test-app', tier: 'internal', scopes };
      next();
    },
  );
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

/** A stored file of an account (or an application), with its object in the bucket. */
async function stored(
  owner: { ownerUserId: string } | { ownerApplicationId: string },
  visibility: FileVisibility,
  status: 'active' | 'trash' | 'blocked' = 'active',
) {
  const bytes = randomBytes(64);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const base = `content/2026/10/${sha256.slice(0, 2)}/${sha256}.pdf`;
  const storageKey = visibility === 'public' ? `public/${base}` : base;
  mockObjects.set(storageKey, bytes);
  const file = await insertFile({
    sha256,
    size: bytes.length,
    mime: 'application/pdf',
    ext: '.pdf',
    ownerUserId: null,
    systemOwner: null,
    ...owner,
    status,
    visibility,
    storageKey,
    originalName: 'manual.pdf',
  });
  return file;
}

async function rows(sha256: string) {
  return getDb().select().from(files).where(eq(files.sha256, sha256));
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
  mockS3.copyFile.mockClear();
});

describe('POST /assets/service/app/adopt', () => {
  it("takes a person's public file as the application's own, sharing its stored bytes", async () => {
    const appId = await application();
    actAs(appId);
    const owner = await account();
    const source = await stored({ ownerUserId: owner }, 'public');

    const res = await adopt({ fileId: source.id, visibility: 'public' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      outcome: 'adopted',
      deduplicated: false,
      file: { ownerApplicationId: appId, visibility: 'public', sha256: source.sha256 },
    });
    const [adopted] = (await rows(source.sha256)).filter((row) => row.id !== source.id);
    expect(adopted).toMatchObject({
      ownerApplicationId: appId,
      ownerUserId: null,
      storageKey: source.storageKey,
      originalName: 'manual.pdf',
    });
    expect(adopted.metadata).toMatchObject({ adoptedFromFileId: source.id });
    expect(mockS3.copyFile).not.toHaveBeenCalled();
    // The source is untouched.
    expect((await rows(source.sha256)).find((row) => row.id === source.id)).toMatchObject({
      ownerUserId: owner,
      status: 'active',
    });
  });

  it('is idempotent per (application, bytes)', async () => {
    actAs(await application());
    const source = await stored({ ownerUserId: await account() }, 'unlisted');
    const first = await adopt({ fileId: source.id, visibility: 'unlisted' });
    const again = await adopt({ fileId: source.id, visibility: 'private' });

    expect(again.body.data).toMatchObject({
      outcome: 'existing',
      deduplicated: true,
      file: { id: first.body.data.file.id, visibility: 'unlisted' },
    });
    expect(await rows(source.sha256)).toHaveLength(2);
  });

  it('copies to a new key spelling only when the visibility needs one', async () => {
    actAs(await application());
    const source = await stored({ ownerUserId: await account() }, 'public');

    const res = await adopt({ fileId: source.id, visibility: 'private' });

    expect(res.status).toBe(200);
    const [adopted] = (await rows(source.sha256)).filter((row) => row.id !== source.id);
    expect(adopted.storageKey).toBe(source.storageKey.slice('public/'.length));
    expect(mockS3.copyFile).toHaveBeenCalledWith(source.storageKey, adopted.storageKey, {
      sizeHint: 64,
    });
  });

  it("refuses a person's private file unless its owner attached it to this application", async () => {
    const appId = await application();
    actAs(appId);
    const owner = await account();
    const source = await stored({ ownerUserId: owner }, 'private');

    expect((await adopt({ fileId: source.id, visibility: 'private' })).status).toBe(404);

    // A reference the APPLICATION made is not the owner's grant.
    await insertFileReference(source.id, {
      applicationId: appId,
      entityType: 'deliverable',
      entityId: 'x',
      createdByUserId: null,
    });
    fileCache.clear();
    expect((await adopt({ fileId: source.id, visibility: 'private' })).status).toBe(404);

    // The owner's own attachment is (ADR 0021).
    await insertFileReference(source.id, {
      applicationId: appId,
      entityType: 'deliverable',
      entityId: 'by-owner',
      createdByUserId: owner,
    });
    fileCache.clear();
    const widened = await adopt({ fileId: source.id, visibility: 'unlisted' });
    expect(widened.status).toBe(400);
    expect(widened.body.error).toBe('VISIBILITY_WIDER_THAN_SOURCE');
    const ok = await adopt({ fileId: source.id, visibility: 'private' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.file).toMatchObject({ ownerApplicationId: appId, visibility: 'private' });
  });

  it("never reads another application's private file, nor a trashed or deleted one", async () => {
    actAs(await application());
    const other = await application();
    const privateOfOther = await stored({ ownerApplicationId: other }, 'private');
    const publicOfOther = await stored({ ownerApplicationId: other }, 'public');
    const trashed = await stored({ ownerUserId: await account() }, 'public', 'trash');

    expect((await adopt({ fileId: privateOfOther.id, visibility: 'private' })).status).toBe(404);
    expect((await adopt({ fileId: trashed.id, visibility: 'public' })).status).toBe(404);
    expect((await adopt({ fileId: 'no-such-file', visibility: 'public' })).status).toBe(404);
    expect((await adopt({ fileId: publicOfOther.id, visibility: 'public' })).status).toBe(200);
  });

  it('answers its own file as it is', async () => {
    const appId = await application();
    actAs(appId);
    const own = await stored({ ownerApplicationId: appId }, 'private');

    const res = await adopt({ fileId: own.id, visibility: 'public' });

    expect(res.body.data).toMatchObject({
      outcome: 'existing',
      file: { id: own.id, visibility: 'private' },
    });
    expect(await rows(own.sha256)).toHaveLength(1);
  });

  it('refuses blocked bytes with 451', async () => {
    actAs(await application());
    const source = await stored({ ownerUserId: await account() }, 'public', 'blocked');
    const [claim] = await getDb()
      .insert(contentClaims)
      .values({
        reference: `OXY-${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`,
        kind: 'copyright',
        relationship: 'rights_holder',
        state: 'actioned',
      })
      .returning({ id: contentClaims.id });
    await getDb().insert(blockedContentHashes).values({ sha256: source.sha256, claimId: claim.id });

    const res = await adopt({ fileId: source.id, visibility: 'public' });
    expect(res.status).toBe(451);
    expect(await rows(source.sha256)).toHaveLength(1);
  });

  it('registers the reference it asked for, which needs files:references:write', async () => {
    const appId = await application();
    const source = await stored({ ownerUserId: await account() }, 'public');
    actAs(appId, ['files:app:write']);
    const body = {
      fileId: source.id,
      visibility: 'public',
      reference: { entityType: 'evidence', entityId: 'case-1' },
    };
    expect((await adopt(body)).status).toBe(403);

    actAs(appId);
    const res = await adopt(body);
    expect(res.body.data.reference).toEqual({ result: 'created' });
    expect(
      await getDb()
        .select({ entityId: fileReferences.entityId })
        .from(fileReferences)
        .where(eq(fileReferences.fileId, res.body.data.file.id)),
    ).toEqual([{ entityId: 'case-1' }]);
  });

  it("counts a third-party application's adoption toward its developer's plan (D3)", async () => {
    const f = await productAccessFixture();
    mockCatalogue = {
      ...EMPTY_PRODUCT_BILLING_CATALOGUE,
      products: f.products as ProductBillingCatalogue['products'],
      storageAdapter: {
        productId: f.products[0].id,
        quotaKey: 'storage_bytes',
        unit: 'byte',
        legacyCombination: 'maximum',
      },
    };
    const appId = await application({ type: 'third_party', ownerAccountId: f.payer });
    actAs(appId);
    const filler = randomBytes(8);
    await insertFile({
      sha256: createHash('sha256').update(filler).digest('hex'),
      size: legacyStorageLimit('basic') - 10,
      mime: 'application/zip',
      ext: '.zip',
      ownerUserId: f.payer,
      systemOwner: null,
      status: 'active',
      storageKey: `content/filler/${randomBytes(4).toString('hex')}.zip`,
    });
    const source = await stored({ ownerUserId: await account() }, 'public');

    const res = await adopt({ fileId: source.id, visibility: 'public' });

    expect(res.status).toBe(413);
    expect(await rows(source.sha256)).toHaveLength(1);
  });
});
