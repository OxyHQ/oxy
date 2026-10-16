/**
 * The owner's reference wins over an application's service-made twin (ADR 0042
 * stage 4b) — over real `node:http`, the REAL AssetService and a REAL Postgres.
 *
 * Nilo's scenario. Nilo registers its use of a person's file with its service
 * token (`POST /assets/service/references`): the reference has NO creator. The
 * person then attaches the same file to the same Nilo entity from inside Nilo
 * (`POST /assets/:id/links`, a session bound to Nilo). Before, the unique key
 * swallowed the second write and the reference stayed creator-less, so ADR
 * 0021's owner-linked read (`/service/linked-url`) never admitted Nilo — while
 * the opposite order (owner first) did. Now the owner is recorded as creator,
 * and both orders end in the same state.
 *
 * Invariants:
 *  1. service-then-owner records the owner as creator; Nilo can read the file;
 *  2. owner-then-service already worked and still does;
 *  3. only a NULL creator is filled — a person's creator is never replaced;
 *  4. a non-owner named as creator changes nothing (the repository's own rule,
 *     whatever the caller checked);
 *  5. Mercaria's digital goods (OxyHQ/oxy#1755): a creator links a private
 *     file from the shared session with the legacy `app: 'mercaria'` string,
 *     and Mercaria — holding exactly its canonical seeded scopes — mints its
 *     download URL; a file the creator never linked stays unreadable.
 *
 * Stubbed: both auth middlewares, the rate limiter, S3.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

const mockServiceAuthMiddleware = jest.fn();
let mockSessionUserId = 'nobody';
let mockBoundApplicationId: string | null = null;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string }; oxyToken?: { applicationId: string | null } },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { _id: mockSessionUserId };
    req.oxyToken = { applicationId: mockBoundApplicationId };
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
  s3Service: {
    fileExists: jest.fn(async () => true),
    copyFile: jest.fn(async () => undefined),
    deleteFile: jest.fn(async () => undefined),
    listFiles: jest.fn(async () => []),
    getPresignedDownloadUrl: jest.fn(async (key: string) => `https://signed.example/${key}`),
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
import { insertFileReference } from '../../services/fileRepository';
import fileCache from '../../utils/fileCache';
import { SEED_APPS } from '../../scripts/seedOxyApplicationsSpecs';

jest.setTimeout(60_000);

interface JsonResponse {
  status: number;
  body: { data?: unknown; message?: string };
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

function actAsService(
  appId: string,
  scopes: readonly string[] = ['files:references:write', 'files:linked:read'],
  appName = 'Nilo',
): void {
  mockServiceAuthMiddleware.mockImplementation(
    (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
      req.serviceApp = {
        type: 'service',
        appId,
        appName,
        credentialId: `cred-${appName.toLowerCase()}`,
        ownerAccountId: 'acct-1',
        environment: 'production',
        tier: 'internal',
        scopes: [...scopes],
      };
      next();
    },
  );
}

function signInAs(userId: string, boundApplicationId: string | null): void {
  mockSessionUserId = userId;
  mockBoundApplicationId = boundApplicationId;
}

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function application(): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `nilo-${randomBytes(4).toString('hex')}`,
      ownerAccountId: await account(),
      type: 'first_party',
    })
    .returning({ id: applications.id });
  return row.id;
}

async function personalFile(ownerUserId: string, visibility: 'private' | 'unlisted') {
  const sha256 = randomBytes(32).toString('hex');
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256,
      size: 10,
      mime: 'image/png',
      ext: 'png',
      storageKey: `content/${sha256}.png`,
      visibility,
      status: 'active',
      ownerUserId,
    })
    .returning({ id: files.id });
  return row.id;
}

async function makePrivate(fileId: string): Promise<void> {
  await getDb().update(files).set({ visibility: 'private' }).where(eq(files.id, fileId));
  fileCache.invalidate(fileId);
}

async function creatorsOf(fileId: string, applicationId: string) {
  const rows = await getDb()
    .select({ createdByUserId: fileReferences.createdByUserId })
    .from(fileReferences)
    .where(and(eq(fileReferences.fileId, fileId), eq(fileReferences.applicationId, applicationId)));
  return rows.map((row) => row.createdByUserId);
}

async function niloReads(fileId: string): Promise<boolean> {
  const res = await json('POST', '/assets/service/linked-url', { ids: [fileId] });
  expect(res.status).toBe(200);
  return (res.body.data as Array<{ id: string }>).some((item) => item.id === fileId);
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

describe("the owner's reference wins over the service-made twin (Nilo)", () => {
  it('service first, then the owner from inside Nilo: the owner becomes the creator and Nilo may read', async () => {
    const nilo = await application();
    const owner = await account();
    // Unlisted, so Nilo may reference it with its token (ADR 0042 D4).
    const fileId = await personalFile(owner, 'unlisted');
    const reference = {
      fileId,
      entityType: 'note',
      entityId: `note-${randomBytes(4).toString('hex')}`,
    };

    actAsService(nilo);
    const added = await json('POST', '/assets/service/references', { references: [reference] });
    expect(added.status).toBe(200);
    expect(await creatorsOf(fileId, nilo)).toEqual([null]);

    // The owner makes it private: a service-made reference grants nothing.
    await makePrivate(fileId);
    expect(await niloReads(fileId)).toBe(false);

    signInAs(owner, nilo);
    const linked = await json('POST', `/assets/${fileId}/links`, {
      app: nilo,
      entityType: reference.entityType,
      entityId: reference.entityId,
    });
    expect(linked.status).toBe(200);
    expect(await creatorsOf(fileId, nilo)).toEqual([owner]);
    // The answer reflects it (not a stale cached copy).
    const links = (linked.body.data as { file: { links: Array<{ createdBy?: string }> } }).file
      .links;
    expect(links).toEqual([expect.objectContaining({ createdBy: owner })]);

    expect(await niloReads(fileId)).toBe(true);
  });

  it('the owner first, then the service: already worked, and still does', async () => {
    const nilo = await application();
    const owner = await account();
    const fileId = await personalFile(owner, 'private');
    const reference = { fileId, entityType: 'note', entityId: 'note-1' };

    signInAs(owner, nilo);
    expect(
      (
        await json('POST', `/assets/${fileId}/links`, {
          app: nilo,
          entityType: 'note',
          entityId: 'note-1',
        })
      ).status,
    ).toBe(200);

    actAsService(nilo);
    const added = await json('POST', '/assets/service/references', { references: [reference] });
    expect((added.body.data as { results: Array<{ result: string }> }).results[0].result).toBe(
      'exists',
    );
    expect(await creatorsOf(fileId, nilo)).toEqual([owner]);
    expect(await niloReads(fileId)).toBe(true);
  });

  it('never replaces a person who is already the creator', async () => {
    const nilo = await application();
    const owner = await account();
    const someoneElse = await account();
    const fileId = await personalFile(owner, 'private');
    // A legacy row whose creator is another person (pre per-owner rows).
    await getDb().insert(fileReferences).values({
      fileId,
      applicationId: nilo,
      entityType: 'note',
      entityId: 'note-legacy',
      createdByUserId: someoneElse,
    });

    const result = await insertFileReference(fileId, {
      applicationId: nilo,
      entityType: 'note',
      entityId: 'note-legacy',
      createdByUserId: owner,
    });
    expect(result).toEqual({ created: false, restored: false, ownerRecorded: false });
    expect(await creatorsOf(fileId, nilo)).toEqual([someoneElse]);
  });

  it('a non-owner named as creator fills nothing, whatever the caller checked', async () => {
    const nilo = await application();
    const owner = await account();
    const stranger = await account();
    const fileId = await personalFile(owner, 'unlisted');
    await insertFileReference(fileId, {
      applicationId: nilo,
      entityType: 'note',
      entityId: 'note-2',
      createdByUserId: null,
    });

    const result = await insertFileReference(fileId, {
      applicationId: nilo,
      entityType: 'note',
      entityId: 'note-2',
      createdByUserId: stranger,
    });
    expect(result.ownerRecorded).toBe(false);
    expect(await creatorsOf(fileId, nilo)).toEqual([null]);
  });
});

describe('Mercaria reads the digital goods their creators linked to it (OxyHQ/oxy#1755)', () => {
  it('a creator links from the shared session as `mercaria`; Mercaria, with its seeded scopes, may read', async () => {
    const mercariaScopes = SEED_APPS.find((spec) => spec.name === 'Mercaria')?.scopes ?? [];
    expect(mercariaScopes).toContain('files:linked:read');

    // The legacy `app: 'mercaria'` string resolves by the seed's name, which
    // must name exactly ONE active non-third-party application. This worker's
    // database is shared with the files after this one: suspend it at the end
    // so no later run ever sees two.
    const [mercaria] = await getDb()
      .insert(applications)
      .values({ name: 'Mercaria', ownerAccountId: await account(), type: 'first_party' })
      .returning({ id: applications.id });
    try {
      const creator = await account();
      const linkedGood = await personalFile(creator, 'private');
      const unlinkedGood = await personalFile(creator, 'private');

      // Mercaria's dashboard runs on the shared device session, which names no
      // application: the body's legacy string is all there is.
      signInAs(creator, null);
      const linked = await json('POST', `/assets/${linkedGood}/links`, {
        app: 'mercaria',
        entityType: 'asset_file',
        entityId: `asset-${randomBytes(4).toString('hex')}`,
      });
      expect(linked.status).toBe(200);
      expect(await creatorsOf(linkedGood, mercaria.id)).toEqual([creator]);

      actAsService(mercaria.id, mercariaScopes, 'Mercaria');
      const res = await json('POST', '/assets/service/linked-url', {
        ids: [linkedGood, unlinkedGood],
      });
      expect(res.status).toBe(200);
      expect((res.body.data as Array<{ id: string }>).map((item) => item.id)).toEqual([
        linkedGood,
      ]);
    } finally {
      await getDb()
        .update(applications)
        .set({ status: 'suspended' })
        .where(eq(applications.id, mercaria.id));
    }
  });
});
