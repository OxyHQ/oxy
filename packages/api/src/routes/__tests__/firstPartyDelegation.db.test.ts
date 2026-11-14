/**
 * ADR 0066 at the HTTP boundary: an Oxy service names the account and acts
 * with what its registry entry declares, with no session, task, ticket or
 * requester context — on Oxy's own routes and on another Oxy product's.
 */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../server', () => ({ emitSessionUpdate: jest.fn() }));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const RECEIVER_APPLICATION_ID = 'first-party-delegation-test-receiver';
jest.mock('../../scripts/seedOxyApplicationsSpecs', () => {
  const actual = jest.requireActual('../../scripts/seedOxyApplicationsSpecs');
  const { ALIA_APPLICATION_ID } = jest.requireActual('../../config/firstPartyApplications');
  return {
    ...actual,
    // The real declaration, plus one product API this test receives as.
    SEED_APPS: actual.SEED_APPS.map((spec: { id?: string; actsForPeople?: unknown[] }) =>
      spec.id === ALIA_APPLICATION_ID
        ? {
            ...spec,
            actsForPeople: [
              ...(spec.actsForPeople ?? []),
              {
                on: 'first-party-delegation-test-receiver',
                effect: 'read',
                purpose: 'Test receiver.',
              },
              { on: 'oxy:safety', effect: 'read', purpose: 'Test safety.' },
            ],
          }
        : spec,
    ),
  };
});
const mockUpload = jest.fn(async (..._args: unknown[]) => ({
  file: { id: 'delegated-file', sha256: 'hash', size: 4, mime: 'image/png', visibility: 'private' },
  deduplicated: false,
}));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { uploadUserMediaStreamDetailed: (...args: unknown[]) => mockUpload(...args) },
  s3Service: {},
}));
jest.mock('../../services/fileAccessGrant.service', () => ({
  ...jest.requireActual('../../services/fileAccessGrant.service'),
  grantUploadAccess: jest.fn(),
}));
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import { ALIA_APPLICATION_ID } from '../../config/firstPartyApplications';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { applications } from '../../db/schema/applications';
import { firstPartyDelegationActivity } from '../../db/schema/firstPartyDelegationActivity';
import { bindWorkloadIdentity } from '../../services/workloadIdentityBinding.service';
import assetsRouter from '../assets';
import privacyRouter from '../privacy';
import internalRouter from '../internal';
import supervisionRouter from '../supervision';
import { errorHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/assets', assetsRouter);
app.use('/privacy', privacyRouter);
app.use('/internal', internalRouter);
app.use('/safety', supervisionRouter);
app.use(errorHandler);

beforeAll(async () => {
  await connectPostgres();
});
afterAll(async () => {
  await closePostgres();
});

async function workload(applicationId: string | undefined, ownerAccountId: string) {
  await getDb()
    .insert(applications)
    .values({
      ...(applicationId ? { id: applicationId } : {}),
      name: applicationId ?? `Undeclared ${randomUUID()}`,
      ownerAccountId,
      isOfficial: true,
      status: 'active',
      scopes: [],
      capabilities: [],
    })
    .onConflictDoNothing();
  const [row] = applicationId
    ? await getDb().select().from(applications).where(eq(applications.id, applicationId))
    : await getDb()
        .select()
        .from(applications)
        .where(eq(applications.ownerAccountId, ownerAccountId))
        .limit(1);
  const { binding } = await bindWorkloadIdentity({
    applicationId: row.id,
    subject: `arn:aws:iam::237343248947:role/delegation-${randomUUID()}`,
    environment: 'development',
    actor: { isPlatformStaff: true, describedAs: 'test' },
  });
  const principal = {
    applicationId: row.id,
    credentialId: binding.attestationId,
    ownerAccountId: row.ownerAccountId,
  };
  const token = (audience = 'oxy-api') =>
    signServiceTokenEd25519({
      type: 'service',
      authority: 'first_party',
      appId: principal.applicationId,
      appName: row.name,
      credentialId: principal.credentialId,
      ownerAccountId: principal.ownerAccountId,
      environment: 'development',
      tier: 'internal',
      iss: 'oxy-auth',
      aud: audience,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }) as string;
  return { principal, token };
}

async function fixture() {
  const [owner, person, other] = await insertAccountFixtures([{}, {}, {}]);
  const gemies = await workload(ALIA_APPLICATION_ID, owner.id);
  const undeclared = await workload(undefined, other.id);
  const receiver = await workload(RECEIVER_APPLICATION_ID, owner.id);
  return { owner, person, other, gemies, undeclared, receiver };
}

it("stores a person's media for a declared service with no session or task, and counts it", async () => {
  const f = await fixture();
  const upload = (token: string, actingFor: string, owner = actingFor) =>
    request(app)
      .post('/assets/service/user-media')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Oxy-User-Id', actingFor)
      .set('x-owner-user-id', owner)
      .set('x-visibility', 'private')
      .set('Content-Type', 'image/png')
      .send(Buffer.from('test'));
  const before = mockUpload.mock.calls.length;
  expect((await upload(f.gemies.token(), f.person.id)).status).toBe(200);
  expect(mockUpload.mock.calls.length).toBe(before + 1);
  // The owner must be the account acted for.
  expect((await upload(f.gemies.token(), f.person.id, f.other.id)).status).toBe(403);
  // An Oxy service whose registry entry declares nothing acts for nobody.
  expect((await upload(f.undeclared.token(), f.person.id)).status).toBe(403);
  // No account named: the service acts as itself, which writes nobody's media.
  expect(
    (
      await request(app)
        .post('/assets/service/user-media')
        .set('Authorization', `Bearer ${f.gemies.token()}`)
        .set('x-owner-user-id', f.person.id)
        .set('Content-Type', 'image/png')
        .send(Buffer.from('test'))
    ).status,
  ).toBe(403);
  const [row] = await getDb()
    .select()
    .from(firstPartyDelegationActivity)
    .where(
      and(
        eq(firstPartyDelegationActivity.accountId, f.person.id),
        eq(firstPartyDelegationActivity.receiver, 'oxy:files'),
      ),
    );
  expect(row).toMatchObject({ applicationId: ALIA_APPLICATION_ID, effect: 'write', count: 1 });
});

it('keeps every undeclared Oxy area closed to a declared service', async () => {
  const f = await fixture();
  const response = await request(app)
    .get('/privacy/blocked')
    .set('Authorization', `Bearer ${f.gemies.token()}`)
    .set('X-Oxy-User-Id', f.person.id);
  expect(response.status).toBe(403);
});

it('lets another Oxy product verify a declared caller acting for a person, and nothing more', async () => {
  const f = await fixture();
  const verify = (presented: string, query: Record<string, string>) =>
    request(app)
      .get('/internal/service-acting-as/verify')
      .set('Authorization', `Bearer ${f.receiver.token()}`)
      .set('X-Oxy-Presented-Service-Token', presented)
      .query({
        appId: f.gemies.principal.applicationId,
        credentialId: f.gemies.principal.credentialId,
        ownerAccountId: f.gemies.principal.ownerAccountId,
        environment: 'development',
        userId: f.person.id,
        ...query,
      });
  const presented = f.gemies.token(`oxy-service:${RECEIVER_APPLICATION_ID}`);
  const read = await verify(presented, { effect: 'read' });
  expect(read.body.data).toEqual({
    authorized: true,
    authority: 'first_party',
    epoch: '0',
    requesterId: f.person.id,
  });
  // The declaration is read-only: a write is refused.
  expect((await verify(presented, { effect: 'write' })).body.data.authorized).toBe(false);
  // Absent effect is the stricter one.
  expect((await verify(presented, {})).body.data.authorized).toBe(false);
  // A token for another audience proves nothing.
  expect((await verify(f.gemies.token(), { effect: 'read' })).body.data.authorized).toBe(false);
  // A person who does not operate the account cannot be named as its requester.
  expect(
    (await verify(presented, { effect: 'read', requesterId: f.other.id })).body.data.authorized,
  ).toBe(false);
});

it('lets a declared service ask Safety for the person it acts for, and no one else', async () => {
  const f = await fixture();
  const ask = (token: string, requester: unknown) =>
    request(app)
      .post('/safety/service/profile-access')
      .set('Authorization', `Bearer ${token}`)
      .send({ input: { subjectAccountId: f.other.id }, requester });
  const allowed = await ask(f.gemies.token(), { actingForAccountId: f.person.id });
  expect(allowed.status).toBe(200);
  expect(allowed.body).toMatchObject({ allowed: true });
  // An Oxy service that declares no Safety use is refused.
  expect((await ask(f.undeclared.token(), { actingForAccountId: f.person.id })).status).toBe(403);
});
