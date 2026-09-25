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
 *  4. **An attestation cannot widen authority, and the BINDING is what names
 *     it.** The attestation selects a binding and says nothing else; the
 *     binding — a row staff wrote, naming one role and one application — names
 *     the scopes, exactly as a credential does on the other path. So the cases
 *     below are the credential path's cases: a binding that names none gets the
 *     application's non-privileged grants (what this path did before the column
 *     existed, and what every binding written before today still gets), a
 *     binding that names some gets the intersection with the application's, and
 *     a privileged scope survives only when BOTH hold it. The application's
 *     grants remain the ceiling; nothing a workload does can raise it.
 */

/**
 * `jest.setup.cjs` mocks `jsonwebtoken` for the whole package, so a signed token
 * would be the string `mock-jwt-token`. This file is about what is IN the token
 * a workload receives, so it takes the real signer back — locally, and only
 * here.
 */
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

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
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

async function bind(
  applicationId: string,
  subject: string,
  options: { expiresAt?: Date; scopes?: string[] } = {},
) {
  await getDb().insert(applicationWorkloadIdentities).values({
    applicationId,
    provider: 'aws-iam',
    subject,
    ...(options.scopes ? { scopes: options.scopes } : {}),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
  });
}

/** The scopes a token actually carries, or a failure naming why there is none. */
function scopesOf(token: string): string[] {
  const verified = verifyServiceToken(token);
  if (!verified.ok) throw new Error('the mint produced a token that does not verify');
  return verified.payload.scopes;
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
      first.id
    );
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

  it('logs an unknown-challenge refusal with its reason, never the nonce', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const nonce = 'never-issued-nonce-for-the-log-test';
    try {
      await expect(
        exchangeWorkloadAttestation({ provider: 'aws-iam', nonce, attestation: { subject: SUBJECT, answersNonce: nonce } }),
      ).rejects.toMatchObject({ reason: 'unknown_challenge' });
      expect(warn).toHaveBeenCalledWith('[WorkloadIdentity] attestation refused', expect.objectContaining({
        provider: 'aws-iam',
        reason: 'unknown_challenge',
      }));
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

  /**
   * The scope rules, which are the credential path's rules.
   *
   * Every case here is measured against a real production failure: Mention's
   * federation worker lost `federation:write` the moment its key pair came off
   * the task definition and failed every six minutes until the pair was put
   * back, because the mint filtered privileged scopes out of the application's
   * grants rather than reading them off the binding.
   */
  describe('scopes', () => {
    it('gives the application\'s non-privileged grants when the binding names none', async () => {
      // The pre-existing behaviour, pinned. Every binding written before the
      // scopes column reads as this case, so this is the assertion that says a
      // deployment carrying old rows is unchanged by the column arriving.
      const application = await applicationFixture({ scopes: ['user:read', 'federation:write'] });
      const subject = `${SUBJECT}-names-none`;
      await bind(application.id, subject);

      expect(scopesOf((await exchange(subject)).token)).toEqual(['user:read']);
    });

    it('carries exactly what a binding names, which may be LESS than the application holds', async () => {
      // A binding names authority, it does not merely fail to remove it: an
      // implementation that ignored the column and kept returning the app's
      // grants would put `files:read` in this token too.
      const application = await applicationFixture({ scopes: ['user:read', 'files:read'] });
      const subject = `${SUBJECT}-narrower`;
      await bind(application.id, subject, { scopes: ['user:read'] });

      expect(scopesOf((await exchange(subject)).token)).toEqual(['user:read']);
    });

    it('carries a privileged scope BOTH the binding and the application hold', async () => {
      // The case the whole change exists for, in Mention's own shape. Under the
      // old rule this token carried `user:read` alone and the federation worker
      // got `Missing required scope: federation:write` every six minutes.
      const application = await applicationFixture({
        scopes: ['user:read', 'federation:write', 'signals:write', 'catalogs:write'],
      });
      const subject = `${SUBJECT}-privileged-both`;
      await bind(application.id, subject, {
        scopes: ['federation:write', 'signals:write', 'catalogs:write'],
      });

      expect(scopesOf((await exchange(subject)).token).sort()).toEqual([
        'catalogs:write',
        'federation:write',
        'signals:write',
      ]);
    });

    it('drops a scope the APPLICATION does not hold, however the binding was written', async () => {
      // The ceiling, enforced at every mint and not only at the write. The
      // binding writer refuses to store this (see the binding tests), so
      // reaching the mint means the application LOST a scope it once had —
      // which must take it away from the workload at the next mint, exactly as
      // it does for a credential.
      const application = await applicationFixture({ scopes: ['user:read'] });
      const subject = `${SUBJECT}-above-ceiling`;
      await getDb()
        .insert(applicationWorkloadIdentities)
        .values({
          applicationId: application.id,
          provider: 'aws-iam',
          subject,
          scopes: ['user:read', 'federation:write'],
        });

      expect(scopesOf((await exchange(subject)).token)).toEqual(['user:read']);
    });

    it('drops a privileged scope the binding names once the application loses it', async () => {
      // Stated separately from the case above because the direction that
      // matters is the REVOCATION: taking a privileged scope off an
      // application is a staff act, and it has to reach a workload token
      // without anyone touching the binding row.
      const application = await applicationFixture({ scopes: ['user:read', 'signals:write'] });
      const subject = `${SUBJECT}-app-revoked`;
      await bind(application.id, subject, { scopes: ['user:read', 'signals:write'] });

      expect(scopesOf((await exchange(subject)).token).sort()).toEqual([
        'signals:write',
        'user:read',
      ]);

      await getDb()
        .update(applications)
        .set({ scopes: ['user:read'] })
        .where(eq(applications.id, application.id));

      expect(scopesOf((await exchange(subject)).token)).toEqual(['user:read']);
    });
  });
});
