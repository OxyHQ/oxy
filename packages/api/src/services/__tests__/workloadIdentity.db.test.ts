/**
 * The credential-free mint, against a real Postgres.
 *
 * The verifier next door proves the attestation is genuine. This file is about
 * what happens AFTER that, which is where the authority decisions live:
 *
 *  1. **A challenge is spent exactly once.** Two exchanges of one attestation
 *     must not both succeed, or a captured attestation is a permanent
 *     impersonation and the nonce bought nothing.
 *  2. **An attested workload nobody bound is refused.** Proving what you are is
 *     not the same as being one of our applications; without this, any role in
 *     the account becomes an Oxy service.
 *  3. **The trust gate is re-applied here.** A binding row should only ever name
 *     an official application, but the mint checks rather than assuming — that
 *     is the difference between a rule and a hope.
 *  4. **An attestation cannot widen authority.** Privileged scopes never travel
 *     on this path, whatever the application holds, because nothing a human
 *     granted deliberately should be reachable by a workload merely existing.
 */

/**
 * `jest.setup.cjs` mocks `jsonwebtoken` for the whole package, so a signed token
 * would be the string `mock-jwt-token`. This file is about what is IN the token
 * a workload receives, so it takes the real signer back — locally, and only
 * here.
 */
jest.unmock('jsonwebtoken');

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { closeRedis } from '../../config/redis';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { users } from '../../db/schema/users';
import { verifyServiceToken } from '../../middleware/serviceToken';
import {
  exchangeWorkloadAttestation,
  issueWorkloadChallenge,
  WorkloadIdentityError,
} from '../workloadIdentity.service';
import { registerAttestationVerifier, type AttestationVerifier } from '../workloadAttestation.service';

const SUBJECT = `arn:aws:sts::237343248947:assumed-role/oxy-test-${randomUUID()}/task`;

/** Stands in for AWS: the real verifier is exercised in `workloadAttestation.test.ts`. */
const stubVerifier: AttestationVerifier = {
  provider: 'aws-iam',
  verify: async (payload: unknown, nonce: string) => {
    const subject = (payload as { subject?: string }).subject ?? SUBJECT;
    if ((payload as { answersNonce?: string }).answersNonce !== nonce) {
      throw new Error('the stub was handed a nonce it was not told to answer');
    }
    return { provider: 'aws-iam', subject, attestationId: `wl_${subject.slice(-8)}` };
  },
};

const createdApplicationIds: string[] = [];

beforeAll(async () => {
  await connectPostgres();
  registerAttestationVerifier(stubVerifier);
});

afterAll(async () => {
  for (const id of createdApplicationIds) {
    await getDb().delete(applications).where(eq(applications.id, id));
  }
  await closePostgres();
  // The challenge store is a real Redis connection; leaving it open keeps the
  // worker alive after the last assertion.
  await closeRedis();
});

async function applicationFixture(overrides: Partial<typeof applications.$inferInsert> = {}) {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [application] = await getDb()
    .insert(applications)
    .values({
      name: `Workload test ${randomUUID()}`,
      ownerAccountId: owner.id,
      status: 'active',
      isOfficial: true,
      scopes: ['user:read'],
      ...overrides,
    })
    .returning({ id: applications.id, name: applications.name, ownerAccountId: applications.ownerAccountId });
  createdApplicationIds.push(application.id);
  return application;
}

async function bind(applicationId: string, subject: string, expiresAt?: Date) {
  await getDb().insert(applicationWorkloadIdentities).values({
    applicationId,
    provider: 'aws-iam',
    subject,
    ...(expiresAt ? { expiresAt } : {}),
  });
}

async function exchange(subject: string) {
  const { nonce } = await issueWorkloadChallenge();
  return exchangeWorkloadAttestation({
    provider: 'aws-iam',
    nonce,
    attestation: { subject, answersNonce: nonce },
  });
}

describe('workload-identity mint', () => {
  it('mints a service token for a bound, official application', async () => {
    const application = await applicationFixture();
    const subject = `${SUBJECT}-happy`;
    await bind(application.id, subject);

    const grant = await exchange(subject);

    expect(grant.appName).toBe(application.name);
    expect(grant.expiresIn).toBe(3600);
    const verified = verifyServiceToken(grant.token);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload).toMatchObject({
      type: 'service',
      appId: application.id,
      ownerAccountId: application.ownerAccountId,
      scopes: ['user:read'],
    });
    // A workload mint is attributable to the attestation, and is never mistaken
    // for a credential that somebody could try to revoke.
    expect(verified.payload.credentialId.startsWith('wl_')).toBe(true);
  });

  it('spends a challenge once, so the same attestation cannot be replayed', async () => {
    const application = await applicationFixture();
    const subject = `${SUBJECT}-replay`;
    await bind(application.id, subject);

    const { nonce } = await issueWorkloadChallenge();
    const attestation = { subject, answersNonce: nonce };

    await expect(
      exchangeWorkloadAttestation({ provider: 'aws-iam', nonce, attestation }),
    ).resolves.toMatchObject({ appName: application.name });

    await expect(
      exchangeWorkloadAttestation({ provider: 'aws-iam', nonce, attestation }),
    ).rejects.toMatchObject({ reason: 'unknown_challenge' });
  });

  it('refuses a nonce nobody issued', async () => {
    await expect(
      exchangeWorkloadAttestation({
        provider: 'aws-iam',
        nonce: 'a-nonce-this-service-never-minted',
        attestation: { subject: SUBJECT, answersNonce: 'a-nonce-this-service-never-minted' },
      }),
    ).rejects.toBeInstanceOf(WorkloadIdentityError);
  });

  it('refuses a workload that proves what it is but is bound to nothing', async () => {
    await expect(exchange(`${SUBJECT}-unbound`)).rejects.toMatchObject({
      reason: 'unbound_workload',
      status: 403,
    });
  });

  it('refuses a binding whose application is not official', async () => {
    const application = await applicationFixture({ isOfficial: false, type: 'third_party' });
    const subject = `${SUBJECT}-thirdparty`;
    await bind(application.id, subject);

    await expect(exchange(subject)).rejects.toMatchObject({ reason: 'untrusted_application' });
  });

  it('refuses a binding whose application is no longer active', async () => {
    const application = await applicationFixture({ status: 'suspended' });
    const subject = `${SUBJECT}-suspended`;
    await bind(application.id, subject);

    await expect(exchange(subject)).rejects.toMatchObject({ reason: 'application_inactive' });
  });

  it('refuses a binding that has expired, without deleting it', async () => {
    const application = await applicationFixture();
    const subject = `${SUBJECT}-expired`;
    await bind(application.id, subject, new Date(Date.now() - 60_000));

    await expect(exchange(subject)).rejects.toMatchObject({ reason: 'unbound_workload' });
    const [row] = await getDb()
      .select({ id: applicationWorkloadIdentities.id })
      .from(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.subject, subject));
    expect(row).toBeDefined();
  });

  it('never carries a privileged scope, however the application was granted', async () => {
    const application = await applicationFixture({ scopes: ['user:read', 'federation:write'] });
    const subject = `${SUBJECT}-privileged`;
    await bind(application.id, subject);

    const grant = await exchange(subject);

    const verified = verifyServiceToken(grant.token);
    expect(verified.ok && verified.payload.scopes).toEqual(['user:read']);
  });
});
