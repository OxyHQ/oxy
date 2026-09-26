/**
 * `DELETE /users/me` deletes the account's stored uploads (OxyHQ/Mention#1178),
 * on both outcomes — the hard delete and the archive kept for financial records
 * — through the real router and a REAL Postgres.
 *
 * Stubbed as in `usersDeleteAccountEvent.test.ts`: the session/signature proof
 * and the destructive side systems that have their own tests. The financial-
 * holds answer is switchable, so one test takes the archive path. What is under
 * test is that the deletion's own transaction records the storage owed a delete
 * and removes the asset rows, and that a refused deletion records none.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

let currentUserId: string | undefined;
let currentServiceAppId: string | undefined;
let signatureValid = true;
let forceArchive = false;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    if (currentUserId) req.user = { id: currentUserId };
    next();
  },
  serviceAuthMiddleware: (req: { serviceApp?: { appId: string } }, _res: unknown, next: () => void) => {
    if (currentServiceAppId) req.serviceApp = { appId: currentServiceAppId };
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/signature.service', () => ({
  __esModule: true,
  default: {
    verifySignature: () => signatureValid,
    isTimestampFresh: () => true,
  },
}));
jest.mock('../../services/email.service', () => ({
  emailService: { deleteAllUserData: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { deactivateAllUserSessions: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/deviceSession.service', () => ({
  __esModule: true,
  default: { purgeAccountFromAllDevices: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/user.service', () => ({
  userService: { purgeUserSocialGraph: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/federation.service', () => ({
  federationService: { scheduleAvatarRefresh: jest.fn() },
  isOwnFederationDomain: jest.fn(),
}));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { ensureOwnedAssetPublic: jest.fn().mockResolvedValue(undefined) },
  s3Service: {},
}));
jest.mock('../../utils/graphCache', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), invalidate: jest.fn() },
}));
jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: jest.fn() },
}));
jest.mock('../../services/accountFinancialHolds.service', () => {
  const actual = jest.requireActual('../../services/accountFinancialHolds.service');
  return {
    ...actual,
    describeAccountFinancialHolds: async (accountId: string) => {
      const holds = await actual.describeAccountFinancialHolds(accountId);
      return forceArchive ? { ...holds, blocksHardDelete: true } : holds;
    },
  };
});
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { generateKeyPairSync } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files } from '../../db/schema/files';
import { fileVariants } from '../../db/schema/fileVariants';
import { storageObjectDeletions } from '../../db/schema/storageObjectDeletions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import usersRouter from '../users';

jest.setTimeout(60_000);

const signingKey = generateKeyPairSync('ed25519');
const savedEnv = { ...process.env };
let server: http.Server;

beforeAll(async () => {
  process.env.SERVICE_TOKEN_SIGNING_KEY_ID = 'users-delete-storage-test';
  process.env.SERVICE_TOKEN_PRIVATE_KEY = signingKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  delete process.env.SERVICE_TOKEN_PUBLIC_JWKS;
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  app.use(errorHandler);
  server = app.listen(0);
});

afterAll(async () => {
  process.env = savedEnv;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

async function callDelete(body: unknown): Promise<{ status: number; body: { data?: { retained?: boolean } } }> {
  const address = server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path: '/users/me',
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function seedPersonWithUploads() {
  const suffix = randomUUID().slice(0, 8);
  const [person] = await getDb()
    .insert(users)
    .values({
      username: `uploader-${suffix}`,
      email: `uploader-${suffix}@example.test`,
      publicKey: `02${randomBytes(32).toString('hex')}`,
    })
    .returning({ id: users.id, username: users.username });
  const sha256 = randomBytes(32).toString('hex');
  const storageKey = `public/content/2026/09/${sha256.slice(0, 2)}/${sha256}.jpg`;
  const [photo] = await getDb()
    .insert(files)
    .values({ sha256, size: 10, mime: 'image/jpeg', ext: 'jpg', ownerUserId: person!.id, storageKey, visibility: 'public' })
    .returning({ id: files.id });
  await getDb().insert(fileVariants).values({
    fileId: photo!.id,
    type: 'thumb',
    key: `public/variants/2026/09/${sha256.slice(0, 2)}/${sha256}/thumb.webp`,
  });
  return { person: person!, photoId: photo!.id, sha256 };
}

function deleteBody(username: string) {
  return { signature: 'ab'.repeat(64), timestamp: Date.now(), confirmText: username };
}

async function owed(accountId: string) {
  return (await getDb()
    .select({ kind: storageObjectDeletions.kind, target: storageObjectDeletions.target })
    .from(storageObjectDeletions)
    .where(eq(storageObjectDeletions.accountId, accountId)))
    .map((row) => `${row.kind}:${row.target}`)
    .sort();
}

describe("DELETE /users/me deletes the account's stored uploads", () => {
  beforeEach(() => {
    signatureValid = true;
    forceArchive = false;
  });

  it('hard delete: the rows cascade and their storage is recorded for deletion in the same commit', async () => {
    const { person, photoId, sha256 } = await seedPersonWithUploads();
    currentUserId = person.id;

    const response = await callDelete(deleteBody(person.username!));
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ retained: false });

    expect(await getDb().select({ id: files.id }).from(files).where(eq(files.id, photoId))).toHaveLength(0);
    expect(await owed(person.id)).toEqual([
      `object:content/2026/09/${sha256.slice(0, 2)}/${sha256}.jpg`,
      `prefix:variants/2026/09/${sha256.slice(0, 2)}/${sha256}/`,
    ]);
  });

  it('archive for retention: the asset rows are removed and their storage recorded, though the account row stays', async () => {
    const { person, photoId, sha256 } = await seedPersonWithUploads();
    currentUserId = person.id;
    forceArchive = true;

    const response = await callDelete(deleteBody(person.username!));
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ retained: true });

    const [account] = await getDb().select({ status: users.accountStatus }).from(users).where(eq(users.id, person.id));
    expect(account).toMatchObject({ status: 'archived' });
    expect(await getDb().select({ id: files.id }).from(files).where(eq(files.id, photoId))).toHaveLength(0);
    expect(await owed(person.id)).toEqual([
      `object:content/2026/09/${sha256.slice(0, 2)}/${sha256}.jpg`,
      `prefix:variants/2026/09/${sha256.slice(0, 2)}/${sha256}/`,
    ]);
  });

  it('records nothing and keeps the uploads when the deletion is refused', async () => {
    const { person, photoId } = await seedPersonWithUploads();
    currentUserId = person.id;
    signatureValid = false;

    const response = await callDelete(deleteBody(person.username!));
    expect(response.status).toBe(401);
    expect(await getDb().select({ id: files.id }).from(files).where(eq(files.id, photoId))).toHaveLength(1);
    expect(await owed(person.id)).toEqual([]);
  });
});
