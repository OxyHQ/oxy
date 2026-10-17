/**
 * `POST`/`DELETE /assets/service/references` — an application records and
 * removes its own use of files (ADR 0043 D4) — over real `node:http`, the REAL
 * AssetService and a REAL Postgres.
 *
 * Stubbed: the service-auth middleware (a case sets the verified
 * `serviceApp`), the rate limiter and S3 (nothing here touches bytes).
 *
 * The matrix:
 *  - its OWN file, private or trashed            → referenced (trash → active)
 *  - any owner's active public/unlisted file      → referenced
 *  - an account's private file its owner attached to THIS application → referenced
 *  - another application's PRIVATE file           → refused, like a missing file
 *  - an account's private file nobody granted, or granted to another app → refused
 *  - a trashed or deleted file it does not own    → refused
 * and in every case the file's visibility is left exactly as it was.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

const mockServiceAuthMiddleware = jest.fn();

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

jest.mock('../../services/s3ServiceSingleton', () => ({
  s3Service: {
    fileExists: jest.fn(async () => true),
    copyFile: jest.fn(async () => undefined),
    deleteFile: jest.fn(async () => undefined),
    listFiles: jest.fn(async () => []),
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

type Item = { fileId: string; entityType: string; entityId: string };
type Result = Item & { result: string };

interface JsonResponse {
  status: number;
  body: { data?: { results?: Result[] }; message?: string };
}

let server: http.Server;

function json(method: string, path: string, payload: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
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
    req.write(body);
    req.end();
  });
}

function actAs(appId: string, scopes: string[] = ['files:references:write']): void {
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

/** A `files` row with no bytes behind it: nothing in these routes reads them. */
async function file(
  owner: { ownerUserId: string } | { ownerApplicationId: string },
  values: Partial<typeof files.$inferInsert> = {},
): Promise<string> {
  const sha256 = randomBytes(32).toString('hex');
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256,
      size: 10,
      mime: 'image/png',
      ext: 'png',
      storageKey: `content/${sha256}.png`,
      visibility: 'private',
      status: 'active',
      ...owner,
      ...values,
    })
    .returning({ id: files.id });
  return row.id;
}

async function stored(fileId: string) {
  const [row] = await getDb().select().from(files).where(eq(files.id, fileId));
  return row;
}

async function referencesOf(fileId: string) {
  return getDb().select().from(fileReferences).where(eq(fileReferences.fileId, fileId));
}

const item = (fileId: string, entityId = `entity-${randomBytes(4).toString('hex')}`): Item => ({
  fileId,
  entityType: 'listing',
  entityId,
});

async function add(...items: Item[]): Promise<JsonResponse> {
  return json('POST', '/assets/service/references', { references: items });
}

async function remove(...items: Item[]): Promise<JsonResponse> {
  return json('DELETE', '/assets/service/references', { references: items });
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

describe('POST /assets/service/references — what an application may reference', () => {
  it('references its OWN private file as the token’s application, with no person, once', async () => {
    const appId = await application();
    actAs(appId);
    const fileId = await file({ ownerApplicationId: appId });
    const target = item(fileId);

    const first = await add(target);
    const second = await add(target);

    expect(first.status).toBe(200);
    expect(first.body.data?.results).toEqual([{ ...target, result: 'created' }]);
    expect(second.body.data?.results).toEqual([{ ...target, result: 'exists' }]);
    const rows = await referencesOf(fileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      applicationId: appId,
      createdByUserId: null,
      entityType: 'listing',
      entityId: target.entityId,
    });
    expect((await stored(fileId)).visibility).toBe('private');
  });

  it('brings its own trashed file back to active', async () => {
    const appId = await application();
    actAs(appId);
    const fileId = await file({ ownerApplicationId: appId }, { status: 'trash' });

    const res = await add(item(fileId));

    expect(res.body.data?.results?.[0].result).toBe('created');
    expect((await stored(fileId)).status).toBe('active');
  });

  it('references any owner’s public or unlisted file, leaving its visibility alone', async () => {
    const appId = await application();
    const otherApp = await application();
    actAs(appId);
    const personPublic = await file({ ownerUserId: await account() }, { visibility: 'public' });
    const appUnlisted = await file({ ownerApplicationId: otherApp }, { visibility: 'unlisted' });

    const res = await add(item(personPublic), item(appUnlisted));

    expect(res.body.data?.results?.map((r) => r.result)).toEqual(['created', 'created']);
    expect((await stored(personPublic)).visibility).toBe('public');
    expect((await stored(appUnlisted)).visibility).toBe('unlisted');
  });

  it('refuses another application’s PRIVATE file exactly like a missing one, writing nothing', async () => {
    const appId = await application();
    const otherApp = await application();
    actAs(appId);
    const foreign = await file({ ownerApplicationId: otherApp });
    const missing = 'no-such-file';

    const res = await add(item(foreign), item(missing));

    expect(res.status).toBe(200);
    expect(res.body.data?.results?.map((r) => r.result)).toEqual(['not_found', 'not_found']);
    expect(await referencesOf(foreign)).toHaveLength(0);
    expect((await stored(foreign)).visibility).toBe('private');
  });

  it('answers an id longer than any file id not_found, without failing the batch', async () => {
    const appId = await application();
    actAs(appId);
    const own = await file({ ownerApplicationId: appId });
    const notAFile = `cache/thumb/${'a'.repeat(32)}/${'b'.repeat(40)}.jpg`;

    const res = await add(item(own), item(notAFile));

    expect(res.status).toBe(200);
    expect(res.body.data?.results?.map((r) => r.result)).toEqual(['created', 'not_found']);
  });

  it('references an account’s private file only where its OWNER attached it to this application (ADR 0021)', async () => {
    const appId = await application();
    const otherApp = await application();
    actAs(appId);
    const owner = await account();
    const granted = await file({ ownerUserId: owner });
    const grantedElsewhere = await file({ ownerUserId: owner });
    const grantedByStranger = await file({ ownerUserId: owner });
    const ungranted = await file({ ownerUserId: owner });
    await getDb()
      .insert(fileReferences)
      .values([
        {
          fileId: granted,
          applicationId: appId,
          entityType: 'consent',
          entityId: 'x',
          createdByUserId: owner,
        },
        {
          fileId: grantedElsewhere,
          applicationId: otherApp,
          entityType: 'consent',
          entityId: 'x',
          createdByUserId: owner,
        },
        {
          fileId: grantedByStranger,
          applicationId: appId,
          entityType: 'consent',
          entityId: 'x',
          createdByUserId: await account(),
        },
      ]);

    const res = await add(
      item(granted),
      item(grantedElsewhere),
      item(grantedByStranger),
      item(ungranted),
    );

    expect(res.body.data?.results?.map((r) => r.result)).toEqual([
      'created',
      'not_found',
      'not_found',
      'not_found',
    ]);
    expect((await stored(granted)).visibility).toBe('private');
    expect(await referencesOf(ungranted)).toHaveLength(0);
  });

  it('refuses a trashed or deleted file it does not own', async () => {
    const appId = await application();
    actAs(appId);
    const trashed = await file(
      { ownerUserId: await account() },
      {
        visibility: 'public',
        status: 'trash',
      },
    );
    const tombstone = await file(
      { ownerUserId: await account() },
      {
        visibility: 'public',
        status: 'deleted',
      },
    );

    const res = await add(item(trashed), item(tombstone));

    expect(res.body.data?.results?.map((r) => r.result)).toEqual(['not_found', 'not_found']);
    expect((await stored(trashed)).status).toBe('trash');
  });
});

describe('POST /assets/service/references — who is asking', () => {
  it('refuses a body that names an application: the application is the token’s', async () => {
    const appId = await application();
    const otherApp = await application();
    actAs(appId);
    const fileId = await file({ ownerApplicationId: otherApp }, { visibility: 'public' });

    const res = await json('POST', '/assets/service/references', {
      references: [{ ...item(fileId), applicationId: otherApp }],
    });

    expect(res.status).toBe(400);
    expect(await referencesOf(fileId)).toHaveLength(0);
  });

  it('needs files:references:write — files:app:write is not it', async () => {
    const appId = await application();
    actAs(appId, ['files:app:write', 'files:app:delete']);
    const fileId = await file({ ownerApplicationId: appId });

    expect((await add(item(fileId))).status).toBe(403);
    expect((await remove(item(fileId))).status).toBe(403);
  });

  it('refuses a suspended application whatever its token carries, and admits a third-party one', async () => {
    const suspended = await application({ status: 'suspended' });
    actAs(suspended);
    const fileId = await file({ ownerApplicationId: suspended });
    expect((await add(item(fileId))).status).toBe(403);

    const thirdParty = await application({ type: 'third_party' });
    actAs(thirdParty);
    const own = await file({ ownerApplicationId: thirdParty });
    expect((await add(item(own))).body.data?.results?.[0].result).toBe('created');
  });

  it('bounds the batch at 100', async () => {
    const appId = await application();
    actAs(appId);
    const fileId = await file({ ownerApplicationId: appId });
    const items = Array.from({ length: 101 }, (_, index) => item(fileId, `e${index}`));

    expect((await add(...items)).status).toBe(400);
    expect((await add(...items.slice(0, 100))).status).toBe(200);
  });
});

describe('DELETE /assets/service/references — only its own, and never a trash', () => {
  it('removes this application’s reference and leaves another application’s under the same key', async () => {
    const appId = await application();
    const otherApp = await application();
    const fileId = await file({ ownerUserId: await account() }, { visibility: 'public' });
    const target = item(fileId);
    actAs(otherApp);
    await add(target);
    actAs(appId);
    await add(target);

    const res = await remove(target);
    const again = await remove(target);

    expect(res.body.data?.results).toEqual([{ ...target, result: 'removed' }]);
    expect(again.body.data?.results).toEqual([{ ...target, result: 'not_found' }]);
    const rows = await referencesOf(fileId);
    expect(rows.map((row) => row.applicationId)).toEqual([otherApp]);
  });

  it('removes a reference a person made from inside the application — how GoWay withdraws a contributor’s photo', async () => {
    const appId = await application();
    actAs(appId);
    const contributor = await account();
    const fileId = await file({ ownerUserId: contributor }, { visibility: 'public' });
    await getDb().insert(fileReferences).values({
      fileId,
      applicationId: appId,
      entityType: 'place',
      entityId: 'place-1',
      createdByUserId: contributor,
    });

    const res = await remove({ fileId, entityType: 'place', entityId: 'place-1' });

    expect(res.body.data?.results?.[0].result).toBe('removed');
    // The last reference went, and the person's file is still theirs, active.
    expect(await referencesOf(fileId)).toHaveLength(0);
    expect((await stored(fileId)).status).toBe('active');
  });

  it('answers not_found for an unknown file without failing the batch', async () => {
    const appId = await application();
    actAs(appId);
    const fileId = await file({ ownerApplicationId: appId });
    const target = item(fileId);
    await add(target);

    const res = await remove(item('no-such-file'), target);

    expect(res.status).toBe(200);
    expect(res.body.data?.results?.map((r) => r.result)).toEqual(['not_found', 'removed']);
    expect(
      await getDb()
        .select()
        .from(fileReferences)
        .where(and(eq(fileReferences.fileId, fileId), eq(fileReferences.applicationId, appId))),
    ).toHaveLength(0);
  });
});
