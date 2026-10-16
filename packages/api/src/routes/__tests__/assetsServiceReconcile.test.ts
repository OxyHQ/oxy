/**
 * Reference reconciliation (ADR 0041 D6) — `POST /assets/service/references/
 * reconcile`, `PUT …/:sessionId`, `POST …/:sessionId/commit`, `DELETE
 * …/:sessionId` — over real `node:http`, the REAL services and a REAL Postgres.
 * Stubbed: service auth (a case sets the verified `serviceApp`), the rate
 * limiter and S3.
 *
 * Pinned: missing references are added under the rules of
 * `POST /assets/service/references` (another application's private file and an
 * unknown id are `refused`); stale ones are removed only when created before
 * the session began, and removal never trashes; `dryRun` changes nothing and
 * leaves the session open; one open session per (application, entity type);
 * an expired session answers 410 and frees its slot; another application's
 * session is a 404.
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
import {
  applications,
  fileReferenceReconciliations,
  fileReferences,
  files,
  users,
} from '../../db/schema';
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';
import fileCache from '../../utils/fileCache';

jest.setTimeout(60_000);

interface JsonResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: the wire shapes vary per route
  body: { data?: any; message?: string; error?: any };
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

const entity = () => `entity-${randomBytes(4).toString('hex')}`;

async function begin(entityType: string) {
  return json('POST', '/assets/service/references/reconcile', { entityType });
}

async function put(sessionId: string, items: { fileId: string; entityId: string }[]) {
  return json('PUT', `/assets/service/references/reconcile/${sessionId}`, { items });
}

async function commit(sessionId: string, dryRun?: boolean) {
  return json(
    'POST',
    `/assets/service/references/reconcile/${sessionId}/commit`,
    dryRun === undefined ? {} : { dryRun },
  );
}

async function reference(
  fileId: string,
  applicationId: string,
  entityType: string,
  entityId: string,
) {
  await getDb()
    .insert(fileReferences)
    .values({ fileId, applicationId, entityType, entityId, createdByUserId: null });
}

async function referencesFor(applicationId: string, entityType: string) {
  const rows = await getDb()
    .select({ fileId: fileReferences.fileId, entityId: fileReferences.entityId })
    .from(fileReferences)
    .where(
      and(
        eq(fileReferences.applicationId, applicationId),
        eq(fileReferences.entityType, entityType),
      ),
    );
  return rows.map((r) => `${r.fileId}/${r.entityId}`).sort();
}

describe('reconciliation: the diff', () => {
  it('adds the missing, removes the stale, keeps the rest, refuses what it may not reference', async () => {
    const appId = await application();
    const otherApp = await application();
    actAs(appId);
    const type = `listing-${randomBytes(3).toString('hex')}`;

    const kept = await file({ ownerApplicationId: appId });
    const missingOwn = await file({ ownerApplicationId: appId });
    const missingPublic = await file({ ownerUserId: await account() }, { visibility: 'public' });
    const othersPrivate = await file({ ownerApplicationId: otherApp });
    const staleAccountFile = await file({ ownerUserId: await account() }, { visibility: 'public' });
    const staleOwn = await file({ ownerApplicationId: appId });
    await reference(kept, appId, type, 'k');
    await reference(staleAccountFile, appId, type, 's1');
    await reference(staleOwn, appId, type, 's2');
    // Another entity type of the same application is not this inventory's business.
    await reference(staleOwn, appId, `${type}-other`, 'x');
    // Created before `begin`: the race guard compares against the session's birth.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const started = await begin(type);
    expect(started.status).toBe(200);
    const { sessionId } = started.body.data;
    const page = await put(sessionId, [
      { fileId: kept, entityId: 'k' },
      { fileId: missingOwn, entityId: 'm1' },
      { fileId: missingPublic, entityId: 'm2' },
      { fileId: othersPrivate, entityId: 'r1' },
      { fileId: 'no-such-file', entityId: 'r2' },
      { fileId: kept, entityId: 'k' },
    ]);
    expect(page.body.data).toMatchObject({ accepted: 5, total: 5 });

    const res = await commit(sessionId);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      sessionId,
      entityType: type,
      dryRun: false,
      added: 2,
      removed: 2,
      unchanged: 1,
      refused: 2,
    });
    expect(await referencesFor(appId, type)).toEqual(
      [`${kept}/k`, `${missingOwn}/m1`, `${missingPublic}/m2`].sort(),
    );
    expect(await referencesFor(appId, `${type}-other`)).toEqual([`${staleOwn}/x`]);
    // Removal never trashes: the account's file stays active (not in use).
    expect((await stored(staleAccountFile)).status).toBe('active');
    expect((await stored(staleAccountFile)).unreferencedSince).toBeInstanceOf(Date);
    expect((await stored(othersPrivate)).status).toBe('active');
  });

  it('never removes a reference created after the session began', async () => {
    const appId = await application();
    actAs(appId);
    const type = `listing-${randomBytes(3).toString('hex')}`;
    const { sessionId } = (await begin(type)).body.data;
    const late = await file({ ownerApplicationId: appId });
    await reference(late, appId, type, 'created-during');

    const res = await commit(sessionId);

    expect(res.body.data).toMatchObject({ removed: 0, added: 0 });
    expect(await referencesFor(appId, type)).toEqual([`${late}/created-during`]);
  });

  it('a reconciled reference brings a trashed file of its own back', async () => {
    const appId = await application();
    actAs(appId);
    const type = `listing-${randomBytes(3).toString('hex')}`;
    const trashed = await file(
      { ownerApplicationId: appId },
      { status: 'trash', trashedAt: new Date() },
    );
    const { sessionId } = (await begin(type)).body.data;
    await put(sessionId, [{ fileId: trashed, entityId: entity() }]);

    expect((await commit(sessionId)).body.data).toMatchObject({ added: 1 });
    expect(await stored(trashed)).toMatchObject({ status: 'active', trashedAt: null });
  });
});

describe('reconciliation: dry run', () => {
  it('counts the same, changes nothing, and leaves the session open for the real commit', async () => {
    const appId = await application();
    actAs(appId);
    const type = `listing-${randomBytes(3).toString('hex')}`;
    const stale = await file({ ownerApplicationId: appId });
    const missing = await file({ ownerApplicationId: appId });
    await reference(stale, appId, type, 'old');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { sessionId } = (await begin(type)).body.data;
    await put(sessionId, [{ fileId: missing, entityId: 'new' }]);

    const dry = await commit(sessionId, true);

    expect(dry.body.data).toMatchObject({ dryRun: true, added: 1, removed: 1, unchanged: 0 });
    expect(await referencesFor(appId, type)).toEqual([`${stale}/old`]);

    const real = await commit(sessionId);
    expect(real.body.data).toMatchObject({ dryRun: false, added: 1, removed: 1 });
    expect(await referencesFor(appId, type)).toEqual([`${missing}/new`]);
  });
});

describe('reconciliation: sessions', () => {
  it('refuses a second open session for the same entity type, not for another', async () => {
    const appId = await application();
    actAs(appId);
    const type = `listing-${randomBytes(3).toString('hex')}`;
    const first = await begin(type);
    expect(first.status).toBe(200);

    const second = await begin(type);
    expect(second.status).toBe(409);
    expect(second.body.error?.code ?? second.body.message).toBeDefined();
    expect((await begin(`${type}-b`)).status).toBe(200);

    // Committed, the slot is free again.
    await commit(first.body.data.sessionId);
    expect((await begin(type)).status).toBe(200);
  });

  it('an expired session answers 410 and no longer holds its slot', async () => {
    const appId = await application();
    actAs(appId);
    const type = `listing-${randomBytes(3).toString('hex')}`;
    const { sessionId } = (await begin(type)).body.data;
    await getDb()
      .update(fileReferenceReconciliations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(fileReferenceReconciliations.id, sessionId));

    expect((await put(sessionId, [{ fileId: 'f', entityId: 'e' }])).status).toBe(410);
    expect((await commit(sessionId)).status).toBe(410);
    expect((await begin(type)).status).toBe(200);
    const [retired] = await getDb()
      .select({ status: fileReferenceReconciliations.status })
      .from(fileReferenceReconciliations)
      .where(eq(fileReferenceReconciliations.id, sessionId));
    expect(retired.status).toBe('abandoned');
  });

  it("another application's session does not exist to the caller", async () => {
    const owner = await application();
    actAs(owner);
    const { sessionId } = (await begin('listing')).body.data;

    actAs(await application());
    expect((await put(sessionId, [{ fileId: 'f', entityId: 'e' }])).status).toBe(404);
    expect((await commit(sessionId)).status).toBe(404);
    expect(
      (await json('DELETE', `/assets/service/references/reconcile/${sessionId}`, {})).status,
    ).toBe(404);
  });

  it('DELETE releases the session so a new one can begin; a committed one cannot be paged', async () => {
    const appId = await application();
    actAs(appId);
    const type = `listing-${randomBytes(3).toString('hex')}`;
    const { sessionId } = (await begin(type)).body.data;

    const released = await json('DELETE', `/assets/service/references/reconcile/${sessionId}`, {});
    expect(released.status).toBe(200);
    const next = (await begin(type)).body.data.sessionId;
    await commit(next);
    expect((await put(next, [{ fileId: 'f', entityId: 'e' }])).status).toBe(409);
  });

  it('needs files:references:write and rejects a page above 1000 or a body naming an application', async () => {
    const appId = await application();
    actAs(appId, ['files:app:write']);
    expect((await begin('listing')).status).toBe(403);

    actAs(appId);
    const { sessionId } = (await begin(`listing-${randomBytes(3).toString('hex')}`)).body.data;
    const tooMany = Array.from({ length: 1001 }, (_, index) => ({
      fileId: `f${index}`,
      entityId: 'e',
    }));
    expect((await put(sessionId, tooMany)).status).toBe(400);
    expect(
      (
        await json('PUT', `/assets/service/references/reconcile/${sessionId}`, {
          items: [{ fileId: 'f', entityId: 'e', applicationId: 'someone-else' }],
        })
      ).status,
    ).toBe(400);
  });
});
