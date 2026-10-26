/** Workload identity, environment and live authority against Postgres. */
jest.unmock('jsonwebtoken');

/**
 * The challenge store, in memory.
 *
 * The mint needs Redis to make a nonce single-use across API tasks, and the
 * `api-test` job has no Redis — so a test that needed one would be asserting
 * where the suite runs rather than what the code does. `GETDEL` is the whole
 * contract, and two lines of Map reproduce it exactly, including the property
 * these cases exist for: the second read of a nonce finds nothing.
 */
const challengeStore = new Map<string, string>();

jest.mock('../../config/redis', () => ({
  getRedisClient: () => ({
    set: async (key: string, value: string) => {
      challengeStore.set(key, value);
      return 'OK';
    },
    getdel: async (key: string) => {
      const value = challengeStore.get(key) ?? null;
      challengeStore.delete(key);
      return value;
    },
  }),
  closeRedis: async () => {},
}));

import {
  KAANA_CONTROL_AUDIENCE,
  KAANA_PUBLIC_AUDIENCE,
  type ServiceTokenAudience,
} from '../../config/serviceTokenAudiences';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { createTestDatabase, dropTestDatabase } from '../../db/testDatabase';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { users } from '../../db/schema/users';
import { verifyServiceToken } from '../../middleware/serviceToken';
import {
  exchangeWorkloadAttestation,
  issueWorkloadChallenge,
  WorkloadIdentityError,
} from '../workloadIdentity.service';
import {
  registerAttestationVerifier,
  workloadAttestationHandle,
  type AttestationVerifier,
} from '../workloadAttestation.service';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { logger } from '../../utils/logger';

const SUBJECT = `arn:aws:sts::237343248947:assumed-role/oxy-test-${randomUUID()}/task`;

/**
 * Stands in for AWS: the real verifier is exercised in `workloadAttestation.test.ts`.
 *
 * `attestationId` is DERIVED, by the one definition every real verifier uses. A
 * made-up `wl_…` here would let the mint and the materialised attribution row
 * disagree about which identity this is — and since the row is what the usage
 * ledger's foreign key names, a stub that lies about the handle is a stub that
 * cannot catch the thing worth catching.
 */
const stubVerifier: AttestationVerifier = {
  provider: 'aws-iam',
  verify: async (payload: unknown, nonce: string) => {
    const subject = (payload as { subject?: string }).subject ?? SUBJECT;
    if ((payload as { answersNonce?: string }).answersNonce !== nonce) {
      throw new Error('the stub was handed a nonce it was not told to answer');
    }
    return { provider: 'aws-iam', subject, attestationId: workloadAttestationHandle(subject) };
  },
};

const originalDatabaseUrl = process.env.DATABASE_URL;
let fixtureDatabaseUrl: string | undefined;
jest.setTimeout(60_000);

beforeAll(async () => {
  // The finite transition uses real inventoried application IDs. They may
  // already have receipts or fixtures in the worker database, so this suite
  // owns a separate database instead of deleting another suite's authority.
  await closePostgres();
  fixtureDatabaseUrl = await createTestDatabase();
  process.env.DATABASE_URL = fixtureDatabaseUrl;
  await connectPostgres();
  registerAttestationVerifier(stubVerifier);
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
    .returning({
      id: applications.id,
      name: applications.name,
      ownerAccountId: applications.ownerAccountId,
    });
  return application;
}

async function bind(
  applicationId: string,
  subject: string,
  options: {
    expiresAt?: Date;
    environment?: 'development' | 'staging' | 'production' | null;
  } = {},
) {
  await getDb()
    .insert(applicationWorkloadIdentities)
    .values({
      applicationId,
      environment: options.environment === undefined ? 'development' : options.environment,
      provider: 'aws-iam',
      subject,
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    });
}

/** The materialised attribution row for a handle, or `undefined`. */
async function readCredentialRow(id: string) {
  const [row] = await getDb()
    .select()
    .from(applicationCredentials)
    .where(eq(applicationCredentials.id, id))
    .limit(1);
  return row;
}

async function exchange(subject: string) {
  const { nonce } = await issueWorkloadChallenge();
  return exchangeWorkloadAttestation({
    provider: 'aws-iam',
    protocolVersion: 2,
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
    expect(grant.expiresIn).toBe(300);
    const verified = verifyServiceToken(grant.token);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect((verified.payload.exp ?? 0) - (verified.payload.iat ?? 0)).toBe(300);
    expect(verified.payload).toMatchObject({
      type: 'service',
      appId: application.id,
      ownerAccountId: application.ownerAccountId,
      authority: 'first_party',
      environment: 'development',
    });
    expect(verified.payload).not.toHaveProperty('scopes');
    // A workload mint is attributable to the attestation, and is never mistaken
    // for a credential that somebody could try to revoke.
    expect(verified.payload.credentialId.startsWith('wl_')).toBe(true);
    expect(verified.payload.credentialId).toBe(workloadAttestationHandle(subject));
  });

  it('materialises the row the usage ledger will name, before the token exists', async () => {
    // The mint is the single point at which a `wl_…` `credentialId` enters
    // circulation, so this is where "a token naming a handle has a row the ledger
    // can reference" is made a precondition rather than a hope about the past —
    // and it is why the thirteen bindings already live in production need no
    // backfill.
    const application = await applicationFixture();
    const subject = `${SUBJECT}-materialise`;
    await bind(application.id, subject);
    const handle = workloadAttestationHandle(subject);
    expect(await readCredentialRow(handle)).toBeUndefined();

    const grant = await exchange(subject);
    const verified = verifyServiceToken(grant.token);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const row = await readCredentialRow(verified.payload.credentialId);
    expect(row).toBeDefined();
    expect(row?.type).toBe('workload');
    expect(row?.applicationId).toBe(application.id);
    // The claim names the row that was written, not a second computation of the
    // same hash.
    expect(verified.payload.credentialId).toBe(handle);
  });

  it('refuses to mint when the workload is already attributed to another application', async () => {
    const first = await applicationFixture();
    const second = await applicationFixture();
    const subject = `${SUBJECT}-conflict`;
    await bind(first.id, subject);
    await exchange(subject);

    // The role is unbound and given to another application — which the bind path
    // refuses, but a raw-SQL move does not.
    await getDb()
      .delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.subject, subject));
    await bind(second.id, subject);

    const error = await exchange(subject).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkloadIdentityError);
    expect((error as WorkloadIdentityError).reason).toBe('workload_attribution_conflict');
    // Refusing beats minting a token whose first reservation would fail, and beats
    // relabelling the spend the role already made.
    expect((await readCredentialRow(workloadAttestationHandle(subject)))?.applicationId).toBe(
      first.id,
    );
  });

  it('spends a challenge once, so the same attestation cannot be replayed', async () => {
    const application = await applicationFixture();
    const subject = `${SUBJECT}-replay`;
    await bind(application.id, subject);

    const { nonce } = await issueWorkloadChallenge();
    const attestation = { subject, answersNonce: nonce };

    await expect(
      exchangeWorkloadAttestation({ provider: 'aws-iam', protocolVersion: 2, nonce, attestation }),
    ).resolves.toMatchObject({ appName: application.name });

    await expect(
      exchangeWorkloadAttestation({ provider: 'aws-iam', protocolVersion: 2, nonce, attestation }),
    ).rejects.toMatchObject({ reason: 'unknown_challenge' });
  });

  it('logs an unknown-challenge refusal with its reason, never the nonce', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const nonce = 'never-issued-nonce-for-the-log-test';
    try {
      await expect(
        exchangeWorkloadAttestation({
          provider: 'aws-iam',
          nonce,
          attestation: { subject: SUBJECT, answersNonce: nonce },
        }),
      ).rejects.toMatchObject({ reason: 'unknown_challenge' });
      expect(warn).toHaveBeenCalledWith(
        '[WorkloadIdentity] attestation refused',
        expect.objectContaining({
          provider: 'aws-iam',
          reason: 'unknown_challenge',
        }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(nonce);
    } finally {
      warn.mockRestore();
    }
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
    await bind(application.id, subject, { expiresAt: new Date(Date.now() - 60_000) });

    await expect(exchange(subject)).rejects.toMatchObject({ reason: 'unbound_workload' });
    const [row] = await getDb()
      .select({ id: applicationWorkloadIdentities.id })
      .from(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.subject, subject));
    expect(row).toBeDefined();
  });

  it('mints own authority without external application scopes', async () => {
    const application = await applicationFixture({ scopes: [] });
    const subject = `${SUBJECT}-identity-only`;
    await bind(application.id, subject);
    const grant = await exchange(subject);
    const verified = verifyServiceToken(grant.token);
    expect(verified).toMatchObject({ ok: true, payload: { authority: 'first_party' } });
    if (verified.ok) expect(verified.payload).not.toHaveProperty('scopes');
  });

  it.each([null, 'production', 'staging'] as const)(
    'rejects absent or mismatched environment %s',
    async (environment) => {
      const app = await applicationFixture();
      const subject = `${SUBJECT}-${randomUUID()}`;
      await bind(app.id, subject, { environment });
      await expect(exchange(subject)).rejects.toMatchObject({
        reason: 'workload_environment_unbound',
      });
    },
  );

  it('rejects requested scopes instead of manufacturing scope authority', async () => {
    const app = await applicationFixture();
    const subject = `${SUBJECT}-requested-scopes`;
    await bind(app.id, subject);
    const { nonce } = await issueWorkloadChallenge();
    await expect(
      exchangeWorkloadAttestation({
        provider: 'aws-iam',
        protocolVersion: 2,
        nonce,
        attestation: { subject, answersNonce: nonce },
        scopes: ['user:read'],
      }),
    ).rejects.toMatchObject({ reason: 'workload_scopes_unsupported' });
  });

  it('refuses a suspended owner', async () => {
    const app = await applicationFixture();
    const subject = `${SUBJECT}-owner`;
    await bind(app.id, subject);
    await getDb()
      .update(users)
      .set({ accountStatus: 'archived' })
      .where(eq(users.id, app.ownerAccountId));
    await expect(exchange(subject)).rejects.toMatchObject({ reason: 'application_inactive' });
  });
});

async function exchangeFor(subject: string, audience: ServiceTokenAudience) {
  const { nonce } = await issueWorkloadChallenge();
  return exchangeWorkloadAttestation({
    provider: 'aws-iam',
    protocolVersion: 2,
    nonce,
    audience,
    attestation: { subject, answersNonce: nonce },
  });
}

describe('registered receiver audiences', () => {
  it('mints only for a registered live receiver, independently of scopes', async () => {
    const caller = await applicationFixture({ scopes: [] });
    const receiver = await applicationFixture({ scopes: [] });
    const subject = `${SUBJECT}-receiver`;
    await bind(caller.id, subject);
    const audience = `oxy-service:${receiver.id}` as const;
    const grant = await exchangeFor(subject, audience);
    expect(verifyServiceToken(grant.token, audience)).toMatchObject({
      ok: true,
      payload: { authority: 'first_party', audience },
    });
    expect(verifyServiceToken(grant.token)).toMatchObject({ ok: false });
    await getDb()
      .update(applications)
      .set({ isOfficial: false, type: 'third_party' })
      .where(eq(applications.id, receiver.id));
    await expect(exchangeFor(subject, audience)).rejects.toMatchObject({
      reason: 'unregistered_service_audience',
    });
  });

  it('refuses an unknown receiver', async () => {
    const app = await applicationFixture();
    const subject = `${SUBJECT}-unknown-receiver`;
    await bind(app.id, subject);
    await expect(exchangeFor(subject, `oxy-service:${randomUUID()}`)).rejects.toMatchObject({
      reason: 'unregistered_service_audience',
    });
  });

  it('keeps Kaana control audience restricted to its registered identity', async () => {
    const app = await applicationFixture({ scopes: [] });
    const subject = `${SUBJECT}-kaana`;
    await bind(app.id, subject);
    const grant = await exchangeFor(subject, KAANA_PUBLIC_AUDIENCE);
    expect(verifyServiceToken(grant.token, KAANA_PUBLIC_AUDIENCE)).toMatchObject({ ok: true });
    await expect(exchangeFor(subject, KAANA_CONTROL_AUDIENCE)).rejects.toMatchObject({
      reason: 'invalid_service_audience',
    });
  });
});

describe('finite protocol transition', () => {
  it('rejects legacy minting for every newly registered workload', async () => {
    const app = await applicationFixture();
    const subject = `${SUBJECT}-legacy-denied`;
    await bind(app.id, subject);
    const { nonce } = await issueWorkloadChallenge();
    await expect(
      exchangeWorkloadAttestation({
        provider: 'aws-iam',
        nonce,
        attestation: { subject, answersNonce: nonce },
      }),
    ).rejects.toMatchObject({ reason: 'workload_protocol_upgrade_required' });
  });

  it('retires v1 for the historical cohort without inventing an environment or scopes', async () => {
    const { LEGACY_WORKLOAD_BINDINGS } = await import('../../__fixtures__/retiredWorkloadCohort');
    const expected = LEGACY_WORKLOAD_BINDINGS[0];
    const app = await applicationFixture({ id: expected.applicationId, scopes: [] });
    await getDb()
      .insert(applicationWorkloadIdentities)
      .values({ ...expected, environment: null });
    const { nonce } = await issueWorkloadChallenge();
    await expect(
      exchangeWorkloadAttestation({
        provider: 'aws-iam',
        nonce,
        attestation: { subject: expected.subject, answersNonce: nonce },
      }),
    ).rejects.toMatchObject({ reason: 'workload_protocol_upgrade_required' });
    await expect(exchange(expected.subject)).rejects.toMatchObject({
      reason: 'workload_environment_unbound',
    });
    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ environment: 'development' })
      .where(eq(applicationWorkloadIdentities.id, expected.id));
    const grant = await exchange(expected.subject);
    const verified = verifyServiceToken(grant.token);
    expect(verified).toMatchObject({
      ok: true,
      payload: { authority: 'first_party', appId: app.id },
    });
    if (verified.ok) expect(verified.payload).not.toHaveProperty('scopes');
  });
});
