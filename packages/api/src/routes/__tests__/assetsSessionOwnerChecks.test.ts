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
/** The application the session is bound to (`req.oxyToken.applicationId`), if any. */
let mockBoundApplicationId: string | null = null;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string }; oxyToken?: { applicationId: string | null } },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { _id: mockSubjectId };
    req.oxyToken = { applicationId: mockBoundApplicationId };
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
import { applications, fileReferences, files, users } from '../../db/schema';
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

async function referencesOf(fileId: string) {
  return getDb().select().from(fileReferences).where(eq(fileReferences.fileId, fileId));
}

/** An active application of `type`, owned by a fresh account. */
async function application(
  values: Partial<typeof applications.$inferInsert> = {},
): Promise<string> {
  const [created] = await getDb()
    .insert(applications)
    .values({
      name: `app-${randomBytes(4).toString('hex')}`,
      ownerAccountId: await account(),
      type: 'first_party',
      ...values,
    })
    .returning({ id: applications.id });
  return created.id;
}

/** The seeded GoWay application, which the legacy `app: 'goway'` names. */
const GOWAY_APPLICATION_ID = '73176d04c3654667138c23ec';

function actAs(subjectId: string, operatorId: string | null = null): void {
  mockSubjectId = subjectId;
  mockOperatorId = operatorId;
  mockBoundApplicationId = null;
}

beforeAll(async () => {
  await connectPostgres();
  // `gowaySeedRollback.test.ts` may have left GoWay suspended in this worker's
  // database; the legacy alias resolves only an ACTIVE application.
  await getDb()
    .insert(applications)
    .values({
      id: GOWAY_APPLICATION_ID,
      name: 'GoWay',
      type: 'first_party',
      status: 'active',
      ownerAccountId: await account(),
    })
    .onConflictDoUpdate({
      target: applications.id,
      set: { name: 'GoWay', type: 'first_party', status: 'active' },
    });
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

describe('POST /assets/:id/links — only the owner links a file', () => {
  const target = { app: 'goway', entityType: 'place', entityId: 'place-1' };

  it('links the owner’s file, and the operator’s own file while acting for a business', async () => {
    const owner = await account();
    const id = await fileOf(owner);
    actAs(owner);
    expect((await send('POST', `/assets/${id}/links`, target)).status).toBe(200);

    // GoWay: the session speaks as the business; the photo is the person's.
    const person = await account();
    const photo = await fileOf(person);
    actAs(await account(), person);
    expect((await send('POST', `/assets/${photo}/links`, target)).status).toBe(200);
  });

  it('refuses anybody else, writing no link and leaving visibility as it was', async () => {
    const id = await fileOf(await account(), { visibility: 'private' });

    actAs(await account());
    const res = await send('POST', `/assets/${id}/links`, {
      app: 'profiles',
      entityType: 'avatar',
      entityId: 'attacker',
      visibility: 'public',
    });

    expect(res.status).toBe(403);
    expect((await row(id)).visibility).toBe('private');
    expect(await referencesOf(id)).toEqual([]);
  });
});

describe('POST /assets/:id/links — a reference never changes visibility (ADR 0041 D4)', () => {
  it('keeps a PUBLIC file public when referenced for a non-avatar entity', async () => {
    const owner = await account();
    const id = await fileOf(owner, { visibility: 'public' });

    actAs(owner);
    const res = await send('POST', `/assets/${id}/links`, {
      app: 'goway',
      entityType: 'review_media',
      entityId: 'review-1',
    });

    expect(res.status).toBe(200);
    expect((await row(id)).visibility).toBe('public');
  });

  it('keeps a PRIVATE file private when referenced as an avatar', async () => {
    const owner = await account();
    const id = await fileOf(owner, { visibility: 'private' });

    actAs(owner);
    const res = await send('POST', `/assets/${id}/links`, {
      app: 'goway',
      entityType: 'avatar',
      entityId: owner,
    });

    expect(res.status).toBe(200);
    expect((await row(id)).visibility).toBe('private');
    expect(await referencesOf(id)).toHaveLength(1);
  });

  it('applies an explicit visibility the OWNER sends', async () => {
    const owner = await account();
    const id = await fileOf(owner, { visibility: 'private' });

    actAs(owner);
    const res = await send('POST', `/assets/${id}/links`, {
      app: 'goway',
      entityType: 'place',
      entityId: 'place-explicit',
      visibility: 'public',
    });

    expect(res.status).toBe(200);
    expect((await row(id)).visibility).toBe('public');
  });
});

describe('POST /assets/:id/links — which application the reference is recorded under', () => {
  it('resolves the legacy `goway` string to the GoWay application', async () => {
    const owner = await account();
    const id = await fileOf(owner);

    actAs(owner);
    expect(
      (
        await send('POST', `/assets/${id}/links`, {
          app: 'goway',
          entityType: 'place',
          entityId: 'place-goway',
        })
      ).status,
    ).toBe(200);

    const [reference] = await referencesOf(id);
    expect(reference).toMatchObject({
      applicationId: GOWAY_APPLICATION_ID,
      entityType: 'place',
      entityId: 'place-goway',
      createdByUserId: owner,
    });
  });

  it('accepts an application id as `app`', async () => {
    const owner = await account();
    const appId = await application({ type: 'third_party' });
    const id = await fileOf(owner);

    actAs(owner);
    const res = await send('POST', `/assets/${id}/links`, {
      app: appId,
      entityType: 'doc',
      entityId: 'doc-1',
    });

    expect(res.status).toBe(200);
    expect((await referencesOf(id)).map((reference) => reference.applicationId)).toEqual([appId]);
  });

  it('refuses a string that names no application, writing nothing', async () => {
    const owner = await account();
    const id = await fileOf(owner);

    actAs(owner);
    const res = await send('POST', `/assets/${id}/links`, {
      app: 'not-an-application',
      entityType: 'post',
      entityId: 'p-1',
    });

    expect(res.status).toBe(400);
    expect(await referencesOf(id)).toEqual([]);
  });

  it('refuses a session bound to one application naming another', async () => {
    const owner = await account();
    const bound = await application({ type: 'third_party' });
    const id = await fileOf(owner);

    actAs(owner);
    mockBoundApplicationId = bound;
    const res = await send('POST', `/assets/${id}/links`, {
      app: 'goway',
      entityType: 'place',
      entityId: 'place-bound',
    });

    expect(res.status).toBe(403);
    expect(await referencesOf(id)).toEqual([]);
  });

  it('records a bound session under its own application, whatever free text it sends', async () => {
    const owner = await account();
    const bound = await application({ type: 'third_party' });
    const id = await fileOf(owner);

    actAs(owner);
    mockBoundApplicationId = bound;
    const res = await send('POST', `/assets/${id}/links`, {
      app: 'whatever-the-client-says',
      entityType: 'doc',
      entityId: 'doc-bound',
    });

    expect(res.status).toBe(200);
    expect((await referencesOf(id)).map((reference) => reference.applicationId)).toEqual([bound]);
  });
});

describe('DELETE /assets/:id/links — an unlink that removes nothing changes nothing', () => {
  it('leaves a never-linked file active when no reference matched', async () => {
    const owner = await account();
    const id = await fileOf(owner);

    actAs(owner);
    const res = await send('DELETE', `/assets/${id}/links`, {
      app: 'goway',
      entityType: 'none',
      entityId: 'nil',
    });

    expect(res.status).toBe(200);
    expect((await row(id)).status).toBe('active');
  });

  it('never trashes the owner’s file when its last reference goes: it is only not in use (ADR 0041 D5)', async () => {
    const owner = await account();
    const id = await fileOf(owner);
    const target = { app: 'goway', entityType: 'place', entityId: 'place-2' };
    actAs(owner);
    await send('POST', `/assets/${id}/links`, target);
    expect((await row(id)).unreferencedSince).toBeNull();

    const res = await send('DELETE', `/assets/${id}/links`, target);

    expect(res.status).toBe(200);
    expect((await row(id)).status).toBe('active');
    expect((await row(id)).unreferencedSince).toBeInstanceOf(Date);
    expect(await referencesOf(id)).toEqual([]);
  });
});

describe('DELETE /assets/:id/links — a non-owner removes only what it made (ADR 0041 D12)', () => {
  it('refuses to remove the owner’s reference: 404, the row kept, the file not trashed', async () => {
    const owner = await account();
    const id = await fileOf(owner);
    const target = { app: 'goway', entityType: 'place', entityId: 'place-owner' };
    actAs(owner);
    await send('POST', `/assets/${id}/links`, target);

    // GoWay's business withdrawing a contributor's photo with its own session.
    actAs(await account());
    const res = await send('DELETE', `/assets/${id}/links`, target);

    expect(res.status).toBe(404);
    expect(await referencesOf(id)).toHaveLength(1);
    expect((await row(id)).status).toBe('active');
  });

  it('removes a reference the caller created itself, without trashing the owner’s file', async () => {
    const owner = await account();
    const other = await account();
    const id = await fileOf(owner, { visibility: 'public' });
    await getDb().insert(fileReferences).values({
      fileId: id,
      applicationId: GOWAY_APPLICATION_ID,
      entityType: 'place',
      entityId: 'place-other',
      createdByUserId: other,
    });

    actAs(other);
    const res = await send('DELETE', `/assets/${id}/links`, {
      app: 'goway',
      entityType: 'place',
      entityId: 'place-other',
    });

    expect(res.status).toBe(200);
    expect(await referencesOf(id)).toEqual([]);
    // It was the last reference, but the file is not the caller's to trash.
    expect((await row(id)).status).toBe('active');
  });

  it('lets the owner remove a reference somebody else created', async () => {
    const owner = await account();
    const other = await account();
    const id = await fileOf(owner, { visibility: 'public' });
    await getDb().insert(fileReferences).values({
      fileId: id,
      applicationId: GOWAY_APPLICATION_ID,
      entityType: 'place',
      entityId: 'place-by-other',
      createdByUserId: other,
    });

    actAs(owner);
    const res = await send('DELETE', `/assets/${id}/links`, {
      app: 'goway',
      entityType: 'place',
      entityId: 'place-by-other',
    });

    expect(res.status).toBe(200);
    expect(await referencesOf(id)).toEqual([]);
    expect((await row(id)).status).toBe('active');
  });
});

describe('GET /assets/:id — a file’s links are its owner’s; a private file is the owner’s alone', () => {
  async function linkedBy(fileId: string, createdByUserId: string, entityId: string) {
    await getDb()
      .insert(fileReferences)
      .values({
        fileId,
        applicationId: await application(),
        entityType: 'post',
        entityId,
        createdByUserId,
      });
  }

  it('gives the owner, and the operator acting for another account, every link', async () => {
    const owner = await account();
    const other = await account();
    const id = await fileOf(owner, { visibility: 'private' });
    await linkedBy(id, owner, 'own-post');
    await linkedBy(id, other, 'their-post');

    actAs(owner);
    const own = await send('GET', `/assets/${id}`);
    expect(own.status).toBe(200);
    expect((own.body.data?.file as { links: unknown[] }).links).toHaveLength(2);

    actAs(await account(), owner);
    const operated = await send('GET', `/assets/${id}`);
    expect((operated.body.data?.file as { links: unknown[] }).links).toHaveLength(2);
  });

  it('describes a PUBLIC file to anyone — the fields Mercaria’s catalog check reads — with only their own links', async () => {
    const owner = await account();
    const reader = await account();
    const id = await fileOf(owner, { visibility: 'public' });
    await linkedBy(id, owner, 'owner-post');
    await linkedBy(id, reader, 'reader-post');

    actAs(reader);
    const res = await send('GET', `/assets/${id}`);

    expect(res.status).toBe(200);
    const file = res.body.data?.file as {
      id: string;
      ownerUserId: string;
      status: string;
      visibility: string;
      mime: string;
      size: number;
      links: Array<{ entityId: string; createdBy: string }>;
    };
    expect(file).toMatchObject({
      id,
      ownerUserId: owner,
      status: 'active',
      visibility: 'public',
      mime: 'image/png',
      size: 10,
    });
    expect(file.links.map((link) => link.entityId)).toEqual(['reader-post']);
  });

  it('is 404 for somebody else’s PRIVATE file', async () => {
    const id = await fileOf(await account(), { visibility: 'private' });

    actAs(await account());
    const res = await send('GET', `/assets/${id}`);

    expect(res.status).toBe(404);
    expect(res.body.data).toBeUndefined();
  });
});

describe('GET /assets — the owner sees which files are in use (ADR 0041 D5)', () => {
  type Listed = {
    id: string;
    inUse: boolean;
    unreferencedSince: string | null;
    status: string;
  };

  it('reports inUse and unreferencedSince, and filters on inUse', async () => {
    const owner = await account();
    const used = await fileOf(owner);
    const unused = await fileOf(owner, { unreferencedSince: new Date('2026-10-01T00:00:00Z') });
    actAs(owner);
    await send('POST', `/assets/${used}/links`, {
      app: 'goway',
      entityType: 'place',
      entityId: 'place-listed',
    });

    const all = await send('GET', '/assets?limit=100');
    const listed = (all.body.data as { files: Listed[] }).files;
    expect(listed.find((file) => file.id === used)).toMatchObject({
      inUse: true,
      unreferencedSince: null,
    });
    expect(listed.find((file) => file.id === unused)).toMatchObject({
      inUse: false,
      unreferencedSince: '2026-10-01T00:00:00.000Z',
      status: 'active',
    });

    const notInUse = await send('GET', '/assets?inUse=false&limit=100');
    expect((notInUse.body.data as { files: Listed[] }).files.map((file) => file.id)).toEqual([
      unused,
    ]);
    const inUse = await send('GET', '/assets?inUse=true&limit=100');
    expect((inUse.body.data as { files: Listed[] }).files.map((file) => file.id)).toEqual([used]);
  });

  it('a file in trash has no URL, even for its owner (it is never served)', async () => {
    const owner = await account();
    const id = await fileOf(owner, { status: 'trash', trashedAt: new Date() });
    actAs(owner);

    expect((await send('GET', `/assets/${id}/url`)).status).toBe(404);
    expect((await send('GET', `/assets/${id}`)).status).toBe(200);
  });
});
