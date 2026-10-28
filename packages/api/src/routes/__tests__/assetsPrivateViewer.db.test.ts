/** Real HTTP routes, PostgreSQL file rows and privacy policy; only transport identity and S3 are fixtures. */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications, files, users, userFollows, fileAccessGrants } from '../../db/schema';
import { findFileById, findFilesByIds } from '../../services/fileRepository';
import { mediaPrivacyService } from '../../services/mediaPrivacyService';
import type { FileRecord } from '../../types/file.types';
let mockViewer: string;
let mockApp: string;
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { user: { _id: mockViewer } });
    next();
  },
  serviceAuthMiddleware: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    Object.assign(req, {
      serviceApp: { appId: mockApp, authority: 'first_party' },
      serviceRequester: { subjectAccountId: mockViewer },
    });
    next();
  },
}));
jest.mock('../../middleware/optionalAuth', () => ({
  optionalAuthMiddleware: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    Object.assign(req, { user: { _id: mockViewer } });
    next();
  },
  getUserId: () => mockViewer,
  getMediaViewerUserId: () => mockViewer,
}));
jest.mock('../../middleware/mediaHeaders', () => ({
  mediaHeadersMiddleware: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: {
    getFile: (...args: Parameters<typeof findFileById>) => findFileById(...args),
    getFilesByIds: (...args: Parameters<typeof findFilesByIds>) => findFilesByIds(...args),
    canUserAccessFile: async (file: FileRecord, viewer: string) =>
      (await mediaPrivacyService.checkMediaAccess(file, viewer)).allowed,
    getFileUrl: async () => null,
    getPublicCdnUrl: () => null,
  },
}));
jest.mock('../../services/s3ServiceSingleton', () => ({
  s3Service: { getPresignedDownloadUrl: async () => 'https://fixture.invalid/authorized' },
}));
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';
const app = express();
app.use(express.json());
app.use('/assets', assetsRouter);
app.use(errorHandler);
let owner: string;
let privateId: string;
let ownedId: string;
beforeAll(async () => {
  await connectPostgres();
  const accounts = await getDb()
    .insert(users)
    .values([{ color: 'teal' }, { color: 'blue' }])
    .returning();
  if (!accounts[0] || !accounts[1]) throw new Error('Missing accounts');
  owner = accounts[0].id;
  mockViewer = accounts[1].id;
  await getDb().insert(userFollows).values({ followerId: mockViewer, followedId: owner });
  const [application] = await getDb()
    .insert(applications)
    .values({ name: 'Private Files fixture', ownerAccountId: owner, type: 'first_party' })
    .returning();
  if (!application) throw new Error('Missing application');
  mockApp = application.id;
  const rows = await getDb()
    .insert(files)
    .values(
      [owner, mockViewer].map((ownerUserId) => ({
        ownerUserId,
        sha256: randomUUID().replaceAll('-', '').repeat(2),
        size: 1,
        mime: 'image/png',
        ext: '.png',
        storageKey: `test/${randomUUID()}`,
        visibility: 'private' as const,
      })),
    )
    .returning();
  if (!rows[0] || !rows[1]) throw new Error('Missing files');
  privateId = rows[0].id;
  ownedId = rows[1].id;
});
afterAll(closePostgres);
it('does not mint a direct URL for another account’s private file, even when following its public owner', async () => {
  expect((await request(app).get(`/assets/${privateId}/url`)).status).toBe(403);
  expect((await request(app).get(`/assets/${ownedId}/url`)).status).toBe(200);
});
it('omits another account’s private file from linked requester fallback while returning the requester’s own file', async () => {
  const response = await request(app)
    .post('/assets/service/linked-url')
    .send({ ids: [privateId, ownedId] });
  expect(response.status).toBe(200);
  expect(response.body.data.map((entry: { id: string }) => entry.id)).toEqual([ownedId]);
});
it('refuses private file access in batch resolution without hiding the legitimate owner result', async () => {
  const response = await request(app)
    .post('/assets/batch-access')
    .send({ files: [{ fileId: privateId }, { fileId: ownedId }] });
  expect(response.status).toBe(200);
  expect(response.body.data.results[privateId].allowed).toBe(false);
  expect(response.body.data.results[ownedId].allowed).toBe(true);
});

it('refuses direct stream and download routes even when an entity context claims public visibility', async () => {
  const context = JSON.stringify({
    app: 'mention',
    entityType: 'post',
    entityId: 'claimed',
    postVisibility: 'public',
    authorId: owner,
  });
  expect((await request(app).get(`/assets/${privateId}/stream`).query({ context })).status).toBe(
    403,
  );
  expect((await request(app).get(`/assets/${privateId}/download`)).status).toBe(403);
});
it('preserves the exact application grant with an unrelated requester, but not another application or a revoked grant', async () => {
  const authorizedApp = mockApp;
  await getDb().insert(fileAccessGrants).values({
    fileId: privateId,
    applicationId: authorizedApp,
    state: 'granted',
    source: 'owner',
    changedByUserId: owner,
  });
  const granted = await request(app)
    .post('/assets/service/linked-url')
    .send({ ids: [privateId] });
  expect(granted.body.data.map((entry: { id: string }) => entry.id)).toEqual([privateId]);
  const [other] = await getDb()
    .insert(applications)
    .values({ name: 'Other Files fixture', ownerAccountId: owner, type: 'first_party' })
    .returning();
  if (!other) throw new Error('Missing app');
  mockApp = other.id;
  try {
    const denied = await request(app)
      .post('/assets/service/linked-url')
      .send({ ids: [privateId, ownedId] });
    expect(denied.body.data.map((entry: { id: string }) => entry.id)).toEqual([ownedId]);
  } finally {
    mockApp = authorizedApp;
  }
  await getDb()
    .update(fileAccessGrants)
    .set({ state: 'revoked', revokedAt: new Date() })
    .where(eq(fileAccessGrants.fileId, privateId));
  const revoked = await request(app)
    .post('/assets/service/linked-url')
    .send({ ids: [privateId, ownedId] });
  expect(revoked.body.data.map((entry: { id: string }) => entry.id)).toEqual([ownedId]);
});
it('keeps application-owned private bytes out of person URLs and other applications', async () => {
  const [file] = await getDb()
    .insert(files)
    .values({
      ownerApplicationId: mockApp,
      sha256: randomUUID().replaceAll('-', '').repeat(2),
      size: 1,
      mime: 'image/png',
      ext: '.png',
      storageKey: `test/${randomUUID()}`,
      visibility: 'private',
    })
    .returning();
  if (!file) throw new Error('Missing app-owned file');
  expect((await request(app).get(`/assets/${file.id}/url`)).status).toBe(403);
  const authorizedApp = mockApp;
  const allowed = await request(app)
    .post('/assets/service/linked-url')
    .send({ ids: [file.id] });
  expect(allowed.body.data.map((entry: { id: string }) => entry.id)).toEqual([file.id]);
  const [other] = await getDb()
    .insert(applications)
    .values({ name: 'Unrelated app', ownerAccountId: owner, type: 'first_party' })
    .returning();
  if (!other) throw new Error('Missing other app');
  mockApp = other.id;
  try {
    const denied = await request(app)
      .post('/assets/service/linked-url')
      .send({ ids: [file.id, ownedId] });
    expect(denied.body.data.map((entry: { id: string }) => entry.id)).toEqual([ownedId]);
  } finally {
    mockApp = authorizedApp;
  }
});
