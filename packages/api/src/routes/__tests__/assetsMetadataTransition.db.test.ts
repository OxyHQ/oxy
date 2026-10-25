/** Actual signed service JWT -> middleware -> metadata router -> live Postgres authority. */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const mockGetFilesByIds = jest.fn();
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { getFilesByIds: (...args: unknown[]) => mockGetFilesByIds(...args) },
}));
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { createTestDatabase, dropTestDatabase } from '../../db/testDatabase';
import { LEGACY_WORKLOAD_BINDINGS } from '../../__tests__/fixtures/retiredWorkloadCohort';
import {
  applicationCredentials,
  applications,
  applicationWorkloadIdentities,
  users,
} from '../../db/schema';
import { mintServiceToken } from '../../services/serviceTokenMint.service';
import { workloadAttestationHandle } from '../../services/workloadAttestation.service';
import { ensureWorkloadAttributionIdentity } from '../../services/workloadAttributionIdentity.service';
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';

const server = express().use(express.json()).use('/assets', assetsRouter).use(errorHandler);
const assetId = '64c0000000000000000000aa';
const assetOwner = '64c0000000000000000000bb';
jest.setTimeout(60_000);
const originalDatabaseUrl = process.env.DATABASE_URL;
let fixtureDatabaseUrl: string | undefined;
beforeAll(async () => {
  // The inventoried application id may have receipts in the worker database.
  // Exercise the exact cohort in our own database without altering other suites.
  await closePostgres();
  fixtureDatabaseUrl = await createTestDatabase();
  process.env.DATABASE_URL = fixtureDatabaseUrl;
  await connectPostgres();
});
afterAll(async () => {
  try {
    await closePostgres();
  } finally {
    try {
      if (fixtureDatabaseUrl) await dropTestDatabase(fixtureDatabaseUrl);
    } finally {
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
});
beforeEach(() => {
  mockGetFilesByIds.mockResolvedValue([
    {
      id: assetId,
      sha256: 'a'.repeat(64),
      mime: 'image/png',
      size: 10,
      status: 'ready',
      ownerUserId: assetOwner,
      metadata: {},
      variants: [],
    },
  ]);
});
async function workload() {
  const tuple = LEGACY_WORKLOAD_BINDINGS[0];
  await getDb().delete(applications).where(eq(applications.id, tuple.applicationId));
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning();
  await getDb()
    .insert(applications)
    .values({
      id: tuple.applicationId,
      name: 'Metadata transition',
      ownerAccountId: owner.id,
      status: 'active',
      isOfficial: true,
      scopes: ['files:read'],
    });
  await getDb()
    .insert(applicationWorkloadIdentities)
    .values({
      ...tuple,
      environment: 'development',
      scopes: ['files:read'],
    });
  await ensureWorkloadAttributionIdentity({
    bindingId: tuple.id,
    applicationId: tuple.applicationId,
    subject: tuple.subject,
  });
  const common = {
    appId: tuple.applicationId,
    appName: 'metadata-test',
    ownerAccountId: owner.id,
    credentialId: workloadAttestationHandle(tuple.subject),
    environment: 'development' as const,
    tier: 'internal' as const,
  };
  return { tuple, owner, common, token: mintServiceToken({ ...common, scopes: ['files:read'] }) };
}
function metadata(token: string) {
  return request(server)
    .post('/assets/service/by-ids')
    .auth(token, { type: 'bearer' })
    .send({ ids: [assetId] });
}
it('preserves owner metadata for v2 and rejects the retired v1 owner projection', async () => {
  const fixture = await workload();
  expect((await metadata(fixture.token)).status).toBe(401);
  for (const token of [mintServiceToken({ ...fixture.common, authority: 'first_party' })]) {
    const response = await metadata(token);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      expect.objectContaining({ id: assetId, ownerUserId: assetOwner }),
    ]);
    expect(response.body.data[0]).not.toHaveProperty('storageKey');
  }
});
it.each(['binding', 'application', 'owner'] as const)(
  'rejects the v2 caller after %s revocation',
  async (kind) => {
    const fixture = await workload();
    expect(
      (await metadata(mintServiceToken({ ...fixture.common, authority: 'first_party' }))).status,
    ).toBe(200);
    if (kind === 'binding')
      await getDb()
        .delete(applicationWorkloadIdentities)
        .where(eq(applicationWorkloadIdentities.id, fixture.tuple.id));
    else if (kind === 'application')
      await getDb()
        .update(applications)
        .set({ status: 'suspended' })
        .where(eq(applications.id, fixture.tuple.applicationId));
    else
      await getDb()
        .update(users)
        .set({ accountStatus: 'archived' })
        .where(eq(users.id, fixture.owner.id));
    expect(
      (await metadata(mintServiceToken({ ...fixture.common, authority: 'first_party' }))).status,
    ).toBe(401);
  },
);
it.each(['token', 'binding', 'application'] as const)(
  'rejects retired workload authority regardless of the %s scope ceiling',
  async (kind) => {
    const fixture = await workload();
    let token = fixture.token;
    if (kind === 'token') token = mintServiceToken({ ...fixture.common, scopes: [] });
    else if (kind === 'binding')
      await getDb()
        .update(applicationWorkloadIdentities)
        .set({ scopes: ['user:read'] })
        .where(eq(applicationWorkloadIdentities.id, fixture.tuple.id));
    else
      await getDb()
        .update(applications)
        .set({ scopes: ['user:read'] })
        .where(eq(applications.id, fixture.tuple.applicationId));
    expect((await metadata(token)).status).toBe(401);
  },
);
it('never reveals ownership to a customer key branded internal on the same official application', async () => {
  const fixture = await workload();
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: fixture.tuple.applicationId,
      name: 'Customer key',
      type: 'service',
      environment: 'development',
      publicKey: randomUUID(),
      secretHash: 'test-only',
      scopes: ['files:read'],
    })
    .returning();
  const response = await metadata(
    mintServiceToken({ ...fixture.common, credentialId: credential.id, scopes: ['files:read'] }),
  );
  expect(response.status).toBe(200);
  expect(response.body.data[0]).not.toHaveProperty('ownerUserId');
  expect(response.body.data[0]).not.toHaveProperty('ownerApplicationId');
});
it.each(['unbound environment', 'replacement binding'] as const)(
  'does not extend the bridge to a %s',
  async (kind) => {
    const fixture = await workload();
    if (kind === 'unbound environment')
      await getDb()
        .update(applicationWorkloadIdentities)
        .set({ environment: null })
        .where(eq(applicationWorkloadIdentities.id, fixture.tuple.id));
    else {
      await getDb()
        .delete(applicationWorkloadIdentities)
        .where(eq(applicationWorkloadIdentities.id, fixture.tuple.id));
      const id = randomUUID();
      await getDb()
        .insert(applicationWorkloadIdentities)
        .values({ ...fixture.tuple, id, environment: 'development', scopes: ['files:read'] });
      await ensureWorkloadAttributionIdentity({
        bindingId: id,
        applicationId: fixture.tuple.applicationId,
        subject: fixture.tuple.subject,
      });
    }
    const response = await metadata(fixture.token);
    expect(response.status).toBe(401);
  },
);
