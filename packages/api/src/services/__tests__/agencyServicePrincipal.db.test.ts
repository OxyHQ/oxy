import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { users } from '../../db/schema/users';
import type { ServiceTokenPayload } from '../../middleware/serviceToken';
import { resolveLiveAgencyServicePrincipal, resolveLiveAgencyWorkload } from '../agencyServicePrincipal.service';
import { workloadAttestationHandle } from '../workloadAttestation.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function principalFixture() {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [application] = await getDb().insert(applications).values({
    name: `Agency coordinator ${randomUUID()}`,
    ownerAccountId: owner.id,
    status: 'active',
    isInternal: true,
    scopes: ['capabilities:read', 'capability-tickets:issue'],
    capabilities: ['agency:coordinate'],
  }).returning({ id: applications.id });
  const [credential] = await getDb().insert(applicationCredentials).values({
    applicationId: application.id,
    name: 'Agency test credential',
    publicKey: `oxy_dk_${randomUUID()}`,
    secretHash: 'test-only-secret-hash',
    type: 'service',
    environment: 'production',
    scopes: ['capabilities:read', 'capability-tickets:issue'],
    status: 'active',
  }).returning({ id: applicationCredentials.id });
  const token: ServiceTokenPayload = {
    type: 'service',
    appId: application.id,
    appName: 'Agency coordinator',
    credentialId: credential.id,
    ownerAccountId: owner.id,
    environment: 'production',
    scopes: ['capabilities:read', 'capability-tickets:issue'],
  };
  return { application, credential, token };
}

describe('live agency service principal', () => {
  it('intersects token, credential and current application scopes', async () => {
    const fixture = await principalFixture();
    await getDb().update(applications).set({ scopes: ['capabilities:read'] })
      .where(eq(applications.id, fixture.application.id));

    const principal = await resolveLiveAgencyServicePrincipal(fixture.token);

    expect(principal?.scopes).toEqual(['capabilities:read']);
    expect(principal?.capabilities).toContain('agency:coordinate');
  });

  it('rejects a credential revoked after its service JWT was minted', async () => {
    const fixture = await principalFixture();
    await getDb().update(applicationCredentials).set({ status: 'revoked' })
      .where(eq(applicationCredentials.id, fixture.credential.id));

    await expect(resolveLiveAgencyServicePrincipal(fixture.token)).resolves.toBeNull();
  });

  it('rejects an application whose platform trust is removed after mint', async () => {
    const fixture = await principalFixture();
    await getDb().update(applications).set({ isInternal: false, type: 'third_party' })
      .where(eq(applications.id, fixture.application.id));

    await expect(resolveLiveAgencyServicePrincipal(fixture.token)).resolves.toBeNull();
  });
});

/**
 * The ATTESTED caller's live ceiling (ADR 0026), which has to be as strong as
 * the credential one above. `resolveLiveAgencyWorkload` is what a
 * present-requester mint and introspection re-read for a caller with no key
 * pair, so every case below is a staff revocation that must land immediately
 * rather than at the hour when the token would have expired anyway.
 */
describe('live agency workload principal', () => {
  const ROLE = () => `arn:aws:iam::237343248947:role/oxy-test-${randomUUID().slice(0, 8)}`;

  async function workloadFixture(overrides: { bindingScopes?: string[]; expiresAt?: Date } = {}) {
    const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
    const [application] = await getDb().insert(applications).values({
      name: `Attested product ${randomUUID()}`,
      ownerAccountId: owner.id,
      status: 'active',
      isInternal: true,
      scopes: ['inference:invoke', 'acting-as:offline', 'user:read'],
      capabilities: [],
    }).returning({ id: applications.id });
    const subject = ROLE();
    await getDb().insert(applicationWorkloadIdentities).values({
      applicationId: application.id,
      provider: 'aws-iam',
      subject,
      description: 'test binding',
      scopes: overrides.bindingScopes ?? ['inference:invoke', 'acting-as:offline'],
      ...(overrides.expiresAt ? { expiresAt: overrides.expiresAt } : {}),
    });
    return { owner, application, subject };
  }

  it('resolves the binding, and reports the handle a token minted from it carries', async () => {
    const fixture = await workloadFixture();
    const principal = await resolveLiveAgencyWorkload(fixture.application.id, 'aws-iam', fixture.subject);
    expect(principal?.applicationId).toBe(fixture.application.id);
    expect(principal?.handle).toBe(workloadAttestationHandle(fixture.subject));
    expect(principal?.scopes).toEqual(['inference:invoke', 'acting-as:offline']);
  });

  /** The application is the ceiling for a binding, as it is for a credential. */
  it('intersects the binding with the application, so a scope staff removed is gone at once', async () => {
    const fixture = await workloadFixture();
    await getDb().update(applications).set({ scopes: ['inference:invoke'] })
      .where(eq(applications.id, fixture.application.id));
    const principal = await resolveLiveAgencyWorkload(fixture.application.id, 'aws-iam', fixture.subject);
    expect(principal?.scopes).toEqual(['inference:invoke']);
  });

  /** Empty is "names none" — the application's NON-privileged grants, as the mint does. */
  it('gives a scopeless binding the application\'s non-privileged grants only', async () => {
    const fixture = await workloadFixture({ bindingScopes: [] });
    const principal = await resolveLiveAgencyWorkload(fixture.application.id, 'aws-iam', fixture.subject);
    expect(principal?.scopes).toEqual(['inference:invoke', 'user:read']);
    expect(principal?.scopes).not.toContain('acting-as:offline');
  });

  it('rejects a binding that was deleted — how a compromised workload is cut off', async () => {
    const fixture = await workloadFixture();
    await getDb().delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.applicationId, fixture.application.id));
    await expect(resolveLiveAgencyWorkload(fixture.application.id, 'aws-iam', fixture.subject)).resolves.toBeNull();
  });

  it('rejects a binding whose expiry has passed', async () => {
    const fixture = await workloadFixture({ expiresAt: new Date(Date.now() + 60_000) });
    await expect(resolveLiveAgencyWorkload(fixture.application.id, 'aws-iam', fixture.subject)).resolves.not.toBeNull();
    await expect(resolveLiveAgencyWorkload(
      fixture.application.id, 'aws-iam', fixture.subject, new Date(Date.now() + 120_000),
    )).resolves.toBeNull();
  });

  it('rejects a binding read against an application it does not belong to', async () => {
    const mine = await workloadFixture();
    const theirs = await workloadFixture();
    await expect(resolveLiveAgencyWorkload(theirs.application.id, 'aws-iam', mine.subject)).resolves.toBeNull();
  });

  it('rejects an inactive application, a demoted one, and a suspended owner', async () => {
    const inactive = await workloadFixture();
    await getDb().update(applications).set({ status: 'suspended' })
      .where(eq(applications.id, inactive.application.id));
    await expect(resolveLiveAgencyWorkload(inactive.application.id, 'aws-iam', inactive.subject)).resolves.toBeNull();

    const demoted = await workloadFixture();
    await getDb().update(applications).set({ isInternal: false, type: 'third_party' })
      .where(eq(applications.id, demoted.application.id));
    await expect(resolveLiveAgencyWorkload(demoted.application.id, 'aws-iam', demoted.subject)).resolves.toBeNull();

    const archived = await workloadFixture();
    await getDb().update(users).set({ accountStatus: 'archived' })
      .where(eq(users.id, archived.owner.id));
    await expect(resolveLiveAgencyWorkload(archived.application.id, 'aws-iam', archived.subject)).resolves.toBeNull();
  });
});
