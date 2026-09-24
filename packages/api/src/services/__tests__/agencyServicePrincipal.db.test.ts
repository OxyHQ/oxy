import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { users } from '../../db/schema/users';
import type { ServiceTokenPayload } from '../../middleware/serviceToken';
import {
  resolveLiveAgencyServicePrincipal,
  resolveLiveAgencyWorkload,
  resolveLiveAgencyWorkloadByHandle,
} from '../agencyServicePrincipal.service';
import { resolveServiceTokenPrincipal } from '../attribution.service';
import { workloadTokenEnvironment } from '../../utils/credentialEnvironment';
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

/**
 * The two ADDRESSINGS of one binding, and the hop every consumer of a verified
 * service token takes.
 *
 * `resolveLiveAgencyWorkload` takes the role because its caller declared one.
 * Everyone else — the model catalogue, the inference edge — has only the token,
 * and the token carries `workloadAttestationHandle(subject)`, which is SHA-256
 * and cannot be read back. `resolveLiveAgencyWorkloadByHandle` closes that gap,
 * and `resolveServiceTokenPrincipal` is the one place that decides which of the
 * two rows a `credentialId` claim names.
 *
 * The defect these exist for: both consumers resolved the claim as an
 * `application_credentials` row id unconditionally. An attested caller matched
 * nothing — the catalogue silently demoted it to the public audience and served
 * an empty list, the edge answered 401 — so every service that had given up its
 * key pair was refused by the platform the ADR was written for.
 */
describe('a binding addressed by its handle, and the service-token hop', () => {
  const ROLE = () => `arn:aws:iam::237343248947:role/oxy-handle-${randomUUID().slice(0, 8)}`;

  /**
   * A trusted first-party application with a binding and, optionally, a live
   * service credential beside it.
   *
   * The credential is what makes the non-substitution cases sayable at all: an
   * application that holds BOTH is the only fixture in which "the wrong row was
   * re-read" is distinguishable from "no row was re-read".
   */
  async function bothFixture(overrides: { bindingScopes?: string[] } = {}) {
    const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
    const [application] = await getDb().insert(applications).values({
      name: `Attested and credentialed ${randomUUID()}`,
      ownerAccountId: owner.id,
      status: 'active',
      isInternal: true,
      scopes: ['inference:invoke', 'acting-as:offline', 'user:read'],
      capabilities: [],
    }).returning({ id: applications.id });
    const subject = ROLE();
    const [binding] = await getDb().insert(applicationWorkloadIdentities).values({
      applicationId: application.id,
      provider: 'aws-iam',
      subject,
      description: 'handle test binding',
      scopes: overrides.bindingScopes ?? ['inference:invoke'],
    }).returning({ id: applicationWorkloadIdentities.id });
    const [credential] = await getDb().insert(applicationCredentials).values({
      applicationId: application.id,
      name: 'Beside the binding',
      publicKey: `oxy_dk_${randomUUID()}`,
      secretHash: 'test-only-secret-hash',
      type: 'service',
      environment: 'production',
      scopes: ['inference:invoke', 'acting-as:offline'],
      status: 'active',
    }).returning({ id: applicationCredentials.id });

    const handle = workloadAttestationHandle(subject);
    const attestedToken: ServiceTokenPayload = {
      type: 'service',
      appId: application.id,
      appName: 'Attested and credentialed',
      credentialId: handle,
      ownerAccountId: owner.id,
      environment: 'production',
      scopes: ['inference:invoke'],
    };
    const credentialToken: ServiceTokenPayload = { ...attestedToken, credentialId: credential.id };
    return { owner, application, subject, handle, binding, credential, attestedToken, credentialToken };
  }

  it('answers exactly what the subject addressing answers', async () => {
    const fixture = await bothFixture();
    // Stated as an equality rather than as two assertions, so the two ways in
    // cannot come to different answers about one row without this going red.
    await expect(
      resolveLiveAgencyWorkloadByHandle(fixture.application.id, fixture.handle)
    ).resolves.toEqual(
      await resolveLiveAgencyWorkload(fixture.application.id, 'aws-iam', fixture.subject)
    );
  });

  it('refuses anything that is not a handle, and a handle nobody bound', async () => {
    const fixture = await bothFixture();
    // A real credential id of this very application. The handle space and the
    // credential space are disjoint, and this is the direction that matters:
    // the binding lookup must never answer for a credential.
    await expect(
      resolveLiveAgencyWorkloadByHandle(fixture.application.id, fixture.credential.id)
    ).resolves.toBeNull();
    await expect(
      resolveLiveAgencyWorkloadByHandle(fixture.application.id, workloadAttestationHandle(ROLE()))
    ).resolves.toBeNull();
    // Another application's REAL, live handle, presented under this one's name.
    const theirs = await bothFixture();
    await expect(
      resolveLiveAgencyWorkloadByHandle(fixture.application.id, theirs.handle)
    ).resolves.toBeNull();
  });

  it('resolves an attested token from the BINDING, and a credential one from the CREDENTIAL', async () => {
    const fixture = await bothFixture();

    const attested = await resolveServiceTokenPrincipal(fixture.attestedToken);
    expect(attested).toMatchObject({
      status: 'resolved',
      principal: {
        proof: 'workload',
        credentialId: fixture.handle,
        applicationId: fixture.application.id,
        ownerAccountId: fixture.owner.id,
        environment: workloadTokenEnvironment(),
        // What the BINDING names, intersected with the application — not the
        // credential's `acting-as:offline`, which is sitting right there.
        scopes: ['inference:invoke'],
      },
    });

    const credentialMinted = await resolveServiceTokenPrincipal(fixture.credentialToken);
    expect(credentialMinted).toMatchObject({
      status: 'resolved',
      principal: {
        proof: 'credential',
        credentialId: fixture.credential.id,
        applicationId: fixture.application.id,
        environment: 'production',
        scopes: ['inference:invoke', 'acting-as:offline'],
      },
    });
  });

  it('does not let either row cover for the other, in either direction', async () => {
    // A dead binding with a LIVE credential beside it.
    const attestedSide = await bothFixture();
    await getDb().delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.id, attestedSide.binding.id));
    await expect(resolveServiceTokenPrincipal(attestedSide.attestedToken))
      .resolves.toEqual({ status: 'unknown-workload' });
    // The control: the credential token on the same application still works, so
    // the refusal above is the binding and not the fixture.
    await expect(resolveServiceTokenPrincipal(attestedSide.credentialToken))
      .resolves.toMatchObject({ status: 'resolved' });

    // A revoked credential with a LIVE binding beside it.
    const credentialSide = await bothFixture();
    await getDb().update(applicationCredentials).set({ status: 'revoked' })
      .where(eq(applicationCredentials.id, credentialSide.credential.id));
    await expect(resolveServiceTokenPrincipal(credentialSide.credentialToken))
      .resolves.toEqual({ status: 'unusable-credential' });
    await expect(resolveServiceTokenPrincipal(credentialSide.attestedToken))
      .resolves.toMatchObject({ status: 'resolved' });
  });

  it('refuses an attested token whose application was suspended or demoted', async () => {
    const suspended = await bothFixture();
    await getDb().update(applications).set({ status: 'suspended' })
      .where(eq(applications.id, suspended.application.id));
    await expect(resolveServiceTokenPrincipal(suspended.attestedToken))
      .resolves.toEqual({ status: 'unknown-workload' });
    // The credential path reports the same fact under its own name. Both are
    // refusals; neither is told apart on the wire by any consumer.
    await expect(resolveServiceTokenPrincipal(suspended.credentialToken))
      .resolves.toEqual({ status: 'inactive-application' });

    const demoted = await bothFixture();
    await getDb().update(applications).set({ isInternal: false, type: 'third_party' })
      .where(eq(applications.id, demoted.application.id));
    // An attested caller loses the lane when its application is no longer
    // trusted first-party — the gate the MINT applies, so a live ceiling that
    // admitted it would admit more than a fresh mint would.
    await expect(resolveServiceTokenPrincipal(demoted.attestedToken))
      .resolves.toEqual({ status: 'unknown-workload' });
  });

  it('refuses an attested token naming an application that has no binding at all', async () => {
    const fixture = await bothFixture();
    const stranger = await bothFixture();
    await expect(
      resolveServiceTokenPrincipal({ ...fixture.attestedToken, appId: stranger.application.id })
    ).resolves.toEqual({ status: 'unknown-workload' });
  });

  it('reports an unknown credential id as its own refusal, unchanged', async () => {
    const fixture = await bothFixture();
    await expect(
      resolveServiceTokenPrincipal({ ...fixture.credentialToken, credentialId: randomUUID() })
    ).resolves.toEqual({ status: 'unknown-credential' });
  });
});
