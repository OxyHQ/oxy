import express from 'express';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ServiceTokenPayload } from '../../middleware/serviceToken';

let mockServiceToken: ServiceTokenPayload | undefined;
jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return {
    ...actual,
    authMiddleware: (
      req: { headers: Record<string, string>; user?: unknown },
      res: unknown,
      next: () => void,
    ) => {
      const userId = req.headers['x-test-user'];
      if (!userId) return actual.authMiddleware(req, res, next);
      req.user = { _id: userId, id: userId, kind: 'personal' };
      next();
    },
    serviceAuthMiddleware: (
      req: { serviceApp?: ServiceTokenPayload },
      res: unknown,
      next: () => void,
    ) => {
      if (!mockServiceToken) return actual.serviceAuthMiddleware(req, res, next);
      req.serviceApp = mockServiceToken;
      next();
    },
  };
});
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
import organizationsRouter from '../organizations';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users, applications, applicationCredentials } from '../../db/schema';
import { createNeutralOrganization } from '../../services/organization-directory.service';
import { organizationClaimListSchema, organizationErrorSchema } from '@oxy.so/contracts';
let server: http.Server;
let personId: string, staffId: string;
beforeAll(async () => {
  await connectPostgres();
  const inserted = await getDb()
    .insert(users)
    .values([
      { username: `person${randomUUID()}`, kind: 'personal' },
      { username: `staff${randomUUID()}`, kind: 'personal', isStaff: true },
    ])
    .returning({ id: users.id });
  personId = inserted[0].id;
  staffId = inserted[1].id;
  const app = express();
  app.use(express.json());
  app.use('/organizations', organizationsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closePostgres();
});
afterEach(() => {
  mockServiceToken = undefined;
});
async function request(path: string, method = 'GET', body?: unknown, userId?: string) {
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/organizations${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(userId ? { 'x-test-user': userId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
it('public reads validate responses and use closed typed errors without leaking validation payloads', async () => {
  const org = await createNeutralOrganization({ name: '3M', organizationType: 'business' });
  expect((await request(`/${org.accountId}`)).body).toMatchObject({
    name: '3M',
    claimStatus: 'unclaimed',
  });
  const missing = await request('/missing');
  expect(missing.status).toBe(404);
  expect(organizationErrorSchema.parse(missing.body).error.code).toBe('not_found');
  const invalid = await request('/batch', 'POST', {
    ids: Array.from({ length: 101 }, () => org.accountId),
  });
  expect(invalid.status).toBe(422);
  expect(Object.keys(invalid.body.error)).toEqual(['code', 'message']);
  const unauthorized = await request('', 'POST', { name: 'Company', organizationType: 'business' });
  expect(unauthorized.status).toBe(401);
  expect(organizationErrorSchema.parse(unauthorized.body).error.code).toBe('unauthorized');
});
it('does not let directory creators edit or claim authority without independent review', async () => {
  const org = (
    await request('', 'POST', { name: 'Company', organizationType: 'business' }, personId)
  ).body;
  expect((await request(`/${org.accountId}`, 'PATCH', { name: 'Changed' }, personId)).status).toBe(
    403,
  );
  expect(
    (
      await request(
        `/${org.accountId}/curation`,
        'POST',
        { status: 'suppressed', evidenceReference: 'proof' },
        personId,
      )
    ).status,
  ).toBe(403);
  const claim = (
    await request(
      `/${org.accountId}/claims`,
      'POST',
      { evidenceReference: 'private-proof' },
      personId,
    )
  ).body;
  expect((await request('/claims/mine', 'GET', undefined, personId)).body.items).toEqual([
    expect.objectContaining({ id: claim.id, evidenceReference: 'private-proof' }),
  ]);
  expect((await request('/claims/mine', 'GET', undefined, staffId)).body.items).toEqual([]);
  expect((await request(`/claims/mine/${claim.id}`, 'GET', undefined, staffId)).status).toBe(404);
  expect((await request('/claims/review', 'GET', undefined, personId)).status).toBe(403);
  let reviewCursor: string | null = null;
  let foundClaim = false;
  do {
    const page = organizationClaimListSchema.parse(
      (
        await request(
          `/claims/review?status=pending&limit=50${reviewCursor ? `&cursor=${encodeURIComponent(reviewCursor)}` : ''}`,
          'GET',
          undefined,
          staffId,
        )
      ).body,
    );
    foundClaim = page.items.some((item) => item.id === claim.id);
    reviewCursor = page.nextCursor;
  } while (!foundClaim && reviewCursor);
  expect(foundClaim).toBe(true);
  expect(
    (
      await request(
        `/claims/${claim.id}/review`,
        'POST',
        { decision: 'approved', evidenceReference: 'staff-evidence' },
        staffId,
      )
    ).status,
  ).toBe(200);
});
it('re-reads namespace and credential authority for app batch imports and never accepts linking authority', async () => {
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: 'Importer',
      ownerAccountId: personId,
      type: 'first_party',
      scopes: ['organizations:import'],
      capabilities: ['organizations:import:homiio'],
    })
    .returning({ id: applications.id });
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: app.id,
      name: 'Importer credential',
      type: 'service',
      environment: 'production',
      publicKey: `oxy_dk_${randomUUID()}`,
      secretHash: 'testhash',
    })
    .returning({ id: applicationCredentials.id });
  mockServiceToken = {
    type: 'service',
    appId: app.id,
    appName: 'Importer',
    credentialId: credential.id,
    ownerAccountId: personId,
    environment: 'production',
    tier: 'internal',
    scopes: ['organizations:import'],
  };
  const item = {
    externalId: randomUUID(),
    organization: { name: 'Company', organizationType: 'business' },
    evidenceReference: 'source-proof',
  };
  const input = { namespace: 'homiio', items: [item] };
  expect(
    (await request('/external/batch', 'POST', { ...input, namespace: 'mercaria' })).status,
  ).toBe(403);
  expect(
    (
      await request('/external/batch', 'POST', {
        ...input,
        items: [{ ...item, accountId: 'unrelated-company' }],
      })
    ).status,
  ).toBe(400);
  const first = await request('/external/batch', 'POST', input);
  expect(first.status).toBe(200);
  expect(first.body.items[0].created).toBe(true);
  const retry = await request('/external/batch', 'POST', input);
  expect(retry.body.items[0]).toEqual({ ...first.body.items[0], created: false });
  await getDb()
    .update(applicationCredentials)
    .set({ status: 'revoked' })
    .where(eq(applicationCredentials.id, credential.id));
  expect((await request('/external/batch', 'POST', input)).status).toBe(403);
});
