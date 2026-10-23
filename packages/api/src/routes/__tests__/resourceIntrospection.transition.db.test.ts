jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn(), logSignIn: jest.fn() },
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
import express, { type Request } from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { resourceIntrospectionSchema } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { LEGACY_WORKLOAD_BINDINGS } from '../../config/legacyWorkloadTransition';
import { CLARITY_BACKEND_APPLICATION_ID } from '../../config/firstPartyApplications';
import {
  applications,
  users,
  applicationWorkloadIdentities,
  applicationCredentials,
  appGrants,
  sessions,
  accountMembers,
} from '../../db/schema';
import { mintServiceToken } from '../../services/serviceTokenMint.service';
import { workloadAttestationHandle } from '../../services/workloadAttestation.service';
import { ensureWorkloadAttributionIdentity } from '../../services/workloadAttributionIdentity.service';
import sessionService from '../../services/session.service';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import router from '../resourceIntrospection';
import { errorHandler } from '../../middleware/errorHandler';
const server = express().use(express.json()).use(router).use(errorHandler);
beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET ??= 'resource-test-secret';
  process.env.REFRESH_TOKEN_SECRET ??= 'resource-refresh-secret';
  process.env.DEVICE_ID_SALT ??= 'd'.repeat(48);
  await connectPostgres();
});
afterAll(async () => {
  for (const tuple of LEGACY_WORKLOAD_BINDINGS)
    await getDb().delete(applications).where(eq(applications.id, tuple.applicationId));
  await closePostgres();
});
async function workload(index: number) {
  const tuple = LEGACY_WORKLOAD_BINDINGS[index];
  await getDb().delete(applications).where(eq(applications.id, tuple.applicationId));
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning();
  await getDb()
    .insert(applications)
    .values({
      id: tuple.applicationId,
      name: 'Transition test',
      ownerAccountId: owner.id,
      status: 'active',
      isOfficial: true,
      scopes: ['user:read', 'clarity:search'],
    });
  await getDb()
    .insert(applicationWorkloadIdentities)
    .values({ ...tuple, environment: 'development', scopes: ['user:read', 'clarity:search'] });
  await ensureWorkloadAttributionIdentity({
    bindingId: tuple.id,
    applicationId: tuple.applicationId,
    subject: tuple.subject,
  });
  const common = {
    appId: tuple.applicationId,
    appName: 'test',
    ownerAccountId: owner.id,
    credentialId: workloadAttestationHandle(tuple.subject),
    environment: 'development' as const,
    tier: 'internal' as const,
  };
  return {
    tuple,
    owner,
    common,
    legacy: mintServiceToken({ ...common, scopes: ['clarity:search'] }),
    modern: mintServiceToken({ ...common, authority: 'first_party' }),
  };
}
async function introspect(bearer: string, token: string) {
  const result = await request(server)
    .post('/introspect')
    .auth(bearer, { type: 'bearer' })
    .send({ token });
  expect(result.status).toBe(200);
  return result.body;
}
const clarityIndex = LEGACY_WORKLOAD_BINDINGS.findIndex(
  (binding) => binding.applicationId === CLARITY_BACKEND_APPLICATION_ID,
);
// The deployed old Clarity parser requires scopes even when tier is internal.
const oldClarity = z.object({
  active: z.literal(true),
  accountId: z.string(),
  applicationId: z.string(),
  scopes: z.array(z.string()),
  tier: z.enum(['internal', 'external']),
});
it('projects the exact v1 cohort in the format of the authenticated receiver', async () => {
  const receiver = await workload(clarityIndex);
  const caller = await workload(0);
  const legacy = await introspect(receiver.legacy, caller.legacy);
  expect(oldClarity.parse(legacy)).toMatchObject({ tier: 'internal', scopes: ['clarity:search'] });
  expect(legacy).not.toHaveProperty('authority');
  const modern = resourceIntrospectionSchema.parse(
    await introspect(receiver.modern, caller.legacy),
  );
  expect(modern).toMatchObject({
    active: true,
    kind: 'service',
    authority: 'first_party',
    audience: 'oxy-api',
    accountId: caller.owner.id,
  });
  expect(modern).not.toHaveProperty('scopes');
  await getDb()
    .update(applicationWorkloadIdentities)
    .set({ environment: null })
    .where(eq(applicationWorkloadIdentities.id, caller.tuple.id));
  expect(await introspect(receiver.modern, caller.legacy)).toMatchObject({ authority: 'external' });
  await getDb()
    .delete(applicationWorkloadIdentities)
    .where(eq(applicationWorkloadIdentities.id, caller.tuple.id));
  expect((await introspect(receiver.modern, caller.legacy)).active).toBe(false);
});
it('does not promote non-cohort bindings, wrong audience, or service credentials on an official app', async () => {
  const receiver = await workload(clarityIndex);
  const caller = await workload(1);
  const wrong = mintServiceToken({ ...caller.common, scopes: ['clarity:search'] }, 'kaana.ai');
  expect((await introspect(receiver.modern, wrong)).active).toBe(false);
  await getDb()
    .delete(applicationWorkloadIdentities)
    .where(eq(applicationWorkloadIdentities.id, caller.tuple.id));
  const replacementId = randomUUID();
  await getDb()
    .insert(applicationWorkloadIdentities)
    .values({
      ...caller.tuple,
      id: replacementId,
      environment: 'development',
      scopes: ['clarity:search'],
    });
  await ensureWorkloadAttributionIdentity({
    bindingId: replacementId,
    applicationId: caller.tuple.applicationId,
    subject: caller.tuple.subject,
  });
  expect(await introspect(receiver.modern, caller.legacy)).toMatchObject({ authority: 'external' });
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: caller.tuple.applicationId,
      name: 'external pair',
      type: 'service',
      environment: 'development',
      publicKey: randomUUID(),
      secretHash: 'test-only',
      scopes: ['clarity:search'],
    })
    .returning();
  const external = mintServiceToken({
    ...caller.common,
    credentialId: credential.id,
    scopes: ['clarity:search'],
  });
  for (const bearer of [receiver.modern, receiver.legacy]) {
    const body = await introspect(bearer, external);
    expect(body).toMatchObject({
      authority: 'external',
      tier: 'external',
      scopes: ['clarity:search'],
    });
    expect(resourceIntrospectionSchema.parse(body)).toMatchObject({ kind: 'service' });
  }
});
it('returns a shared human session without a fabricated service identity and revokes it live', async () => {
  const receiver = await workload(clarityIndex);
  const [person] = await insertAccountFixtures([{}]);
  const session = await sessionService.createSession(person.id, { headers: {} } as Request, {
    deviceId: randomUUID(),
  });
  const body = resourceIntrospectionSchema.parse(
    await introspect(receiver.modern, session.accessToken),
  );
  expect(body).toMatchObject({
    kind: 'session',
    authority: 'first_party',
    accountId: person.id,
    requesterAccountId: person.id,
    effectiveAccountId: person.id,
    applicationId: null,
  });
  expect(body).not.toHaveProperty('credentialId');
  expect(body).not.toHaveProperty('scopes');
  await getDb()
    .update(sessions)
    .set({ isActive: false })
    .where(eq(sessions.sessionId, session.sessionId));
  expect((await introspect(receiver.modern, session.accessToken)).active).toBe(false);
});
it('keeps OAuth sessions external with live grant/client/application intersections', async () => {
  const receiver = await workload(clarityIndex);
  const [person] = await insertAccountFixtures([{}]);
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: 'Branded OAuth',
      ownerAccountId: person.id,
      status: 'active',
      isOfficial: true,
      scopes: ['clarity:search', 'user:read'],
    })
    .returning();
  const [client] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: app.id,
      name: 'OAuth',
      type: 'public',
      environment: 'development',
      publicKey: randomUUID(),
      scopes: ['clarity:search', 'user:read'],
    })
    .returning();
  const [grant] = await getDb()
    .insert(appGrants)
    .values({ userId: person.id, applicationId: app.id, scopes: ['clarity:search'] })
    .returning();
  const session = await sessionService.createSession(person.id, { headers: {} } as Request, {
    deviceId: randomUUID(),
    application: {
      applicationId: app.id,
      clientId: client.publicKey,
      scopes: ['clarity:search', 'user:read'],
    },
  });
  const body = resourceIntrospectionSchema.parse(
    await introspect(receiver.modern, session.accessToken),
  );
  expect(body).toMatchObject({
    kind: 'session',
    authority: 'external',
    applicationId: app.id,
    scopes: ['clarity:search'],
  });
  await getDb().delete(appGrants).where(eq(appGrants.id, grant.id));
  expect((await introspect(receiver.modern, session.accessToken)).active).toBe(false);
});

it('keeps a raw machine key scoped even when issued on an own application', async () => {
  const receiver = await workload(clarityIndex);
  const key = generateMachineCredentialToken();
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: receiver.tuple.applicationId,
      name: 'External key',
      type: 'machine',
      environment: 'development',
      publicKey: randomUUID(),
      tokenPrefix: key.tokenPrefix,
      tokenHash: key.tokenHash,
      scopes: ['clarity:search'],
    })
    .returning();
  for (const bearer of [receiver.modern, receiver.legacy]) {
    const body = resourceIntrospectionSchema.parse(await introspect(bearer, key.token));
    expect(body).toMatchObject({ kind: 'key', authority: 'external', scopes: ['clarity:search'] });
    expect(body).not.toHaveProperty('audience');
    expect(body).not.toHaveProperty('expiresAt');
  }
  const expiresAt = new Date(Date.now() + 900000);
  await getDb()
    .update(applicationCredentials)
    .set({ expiresAt })
    .where(eq(applicationCredentials.id, credential.id));
  expect(
    resourceIntrospectionSchema.parse(await introspect(receiver.modern, key.token)),
  ).toMatchObject({ expiresAt: expiresAt.toISOString() });
  await getDb()
    .update(applicationCredentials)
    .set({ status: 'revoked' })
    .where(eq(applicationCredentials.id, credential.id));
  expect((await introspect(receiver.modern, key.token)).active).toBe(false);
});
it('preserves managed account and operator attribution and current permissions', async () => {
  const receiver = await workload(clarityIndex);
  const [person, organization] = await insertAccountFixtures([{}, { kind: 'organization' }]);
  const [membership] = await getDb()
    .insert(accountMembers)
    .values({
      accountId: organization.id,
      memberUserId: person.id,
      role: 'admin',
      status: 'active',
    })
    .returning();
  const session = await sessionService.createSession(organization.id, { headers: {} } as Request, {
    deviceId: randomUUID(),
    operatedByUserId: person.id,
  });
  const body = resourceIntrospectionSchema.parse(
    await introspect(receiver.modern, session.accessToken),
  );
  expect(body).toMatchObject({
    kind: 'session',
    authority: 'first_party',
    accountId: organization.id,
    effectiveAccountId: organization.id,
    requesterAccountId: person.id,
  });
  if (!body.active) throw new Error('Expected active session');
  expect(body.permissions).toContain('account:act_as');
  await getDb().delete(accountMembers).where(eq(accountMembers.id, membership.id));
  expect((await introspect(receiver.modern, session.accessToken)).active).toBe(false);
});
it('requires live own Clarity identity on domain authority reads', async () => {
  const receiver = await workload(clarityIndex);
  const input = {
    accountId: receiver.owner.id,
    verifiedDomainId: randomUUID(),
    originHost: 'example.com',
  };
  expect(
    (
      await request(server)
        .post('/domains/verify')
        .auth(receiver.modern, { type: 'bearer' })
        .send(input)
    ).status,
  ).toBe(200);
  await getDb()
    .delete(applicationWorkloadIdentities)
    .where(eq(applicationWorkloadIdentities.id, receiver.tuple.id));
  expect(
    (
      await request(server)
        .post('/domains/verify')
        .auth(receiver.legacy, { type: 'bearer' })
        .send(input)
    ).status,
  ).toBe(403);
});
it('revokes an external managed session when its operator membership ends', async () => {
  const receiver = await workload(clarityIndex);
  const [person, organization] = await insertAccountFixtures([{}, { kind: 'organization' }]);
  const [membership] = await getDb()
    .insert(accountMembers)
    .values({
      accountId: organization.id,
      memberUserId: person.id,
      role: 'admin',
      status: 'active',
    })
    .returning();
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: 'Managed OAuth',
      ownerAccountId: person.id,
      status: 'active',
      scopes: ['clarity:search'],
    })
    .returning();
  const [client] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: app.id,
      name: 'OAuth',
      type: 'public',
      environment: 'development',
      publicKey: randomUUID(),
      scopes: ['clarity:search'],
    })
    .returning();
  await getDb()
    .insert(appGrants)
    .values({ userId: organization.id, applicationId: app.id, scopes: ['clarity:search'] });
  const session = await sessionService.createSession(organization.id, { headers: {} } as Request, {
    deviceId: randomUUID(),
    operatedByUserId: person.id,
    application: { applicationId: app.id, clientId: client.publicKey, scopes: ['clarity:search'] },
  });
  expect(
    resourceIntrospectionSchema.parse(await introspect(receiver.modern, session.accessToken)),
  ).toMatchObject({
    authority: 'external',
    requesterAccountId: person.id,
    effectiveAccountId: organization.id,
    scopes: ['clarity:search'],
  });
  await getDb().delete(accountMembers).where(eq(accountMembers.id, membership.id));
  expect((await introspect(receiver.modern, session.accessToken)).active).toBe(false);
});
