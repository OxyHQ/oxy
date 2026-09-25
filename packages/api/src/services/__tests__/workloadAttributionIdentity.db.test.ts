/**
 * Materialising an attested identity, against a real Postgres.
 *
 * Two things this file is for, and they pull in opposite directions.
 *
 * **The row must exist**, because `usage_reservations`, `usage_receipts`,
 * `inference_usage_events` and `inference_usage_daily_rollups` all name the
 * identity that authorised a spend with a `NOT NULL` foreign key to
 * `application_credentials.id`. Without it an attested caller authenticates
 * perfectly and then fails a constraint mid-request, which is why the inference
 * edge refused `proof === 'workload'` outright until this existed.
 *
 * **And it must not be a credential.** The schema's four CHECKs make that
 * unrepresentable (`db/schema/__tests__/workloadAttributionCredential.test.ts`
 * asserts each one against the database); this file asserts the other half — that
 * the paths which could still FIND one by row id or by `application_id` do not,
 * and that the ones that look a caller's `public_key` up cannot, because the
 * column is NULL on a workload row.
 *
 * The lifecycle cases in between are the ones a reader cannot check: a subject
 * unbound and bound again must reattach to its OWN history, and a subject whose
 * history belongs to another application must be refused rather than re-labelled.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { users } from '../../db/schema/users';
import {
  resolveCredentialAttribution,
  resolveCredentialAttributionById,
} from '../attribution.service';
import { resolveLiveAgencyCoordinator } from '../agencyServicePrincipal.service';
import { bindWorkloadIdentity, WorkloadBindingError } from '../workloadIdentityBinding.service';
import { workloadAttestationHandle } from '../workloadAttestation.service';
import {
  ensureWorkloadAttributionIdentity,
  WorkloadAttributionError,
} from '../workloadAttributionIdentity.service';
import { resolveApplicationIdFromClientId } from '../../utils/resolveApplicationFromClientId';

/** The operator at a terminal, which is what `bind-workload-identity.ts` claims. */
const STAFF = { isPlatformStaff: true, describedAs: 'the attribution tests, as staff' } as const;

const ACCOUNT = '237343248947';
const roleArn = () => `arn:aws:iam::${ACCOUNT}:role/oxy-attr-${randomUUID()}`;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function applicationFixture(
  overrides: Partial<typeof applications.$inferInsert> = {}
): Promise<string> {
  const [owner] = await getDb().insert(users).values({}).returning({ id: users.id });
  const [application] = await getDb()
    .insert(applications)
    .values({
      name: `Attribution test ${randomUUID()}`,
      ownerAccountId: owner.id,
      status: 'active',
      type: 'first_party',
      isOfficial: true,
      isInternal: true,
      scopes: ['user:read'],
      ...overrides,
    })
    .returning({ id: applications.id });
  return application.id;
}

async function bindingFixture(applicationId: string, subject: string): Promise<string> {
  const [binding] = await getDb()
    .insert(applicationWorkloadIdentities)
    .values({ applicationId, provider: 'aws-iam', subject })
    .returning({ id: applicationWorkloadIdentities.id });
  return binding.id;
}

async function readRow(id: string) {
  const [row] = await getDb()
    .select()
    .from(applicationCredentials)
    .where(eq(applicationCredentials.id, id))
    .limit(1);
  return row;
}

describe('ensureWorkloadAttributionIdentity', () => {
  it('writes an inert row whose id IS the attestation handle', async () => {
    const applicationId = await applicationFixture();
    const subject = roleArn();
    const bindingId = await bindingFixture(applicationId, subject);

    const result = await ensureWorkloadAttributionIdentity({ bindingId, applicationId, subject });
    expect(result).toEqual({ credentialId: workloadAttestationHandle(subject), state: 'created' });

    const row = await readRow(result.credentialId);
    expect(row.type).toBe('workload');
    expect(row.applicationId).toBe(applicationId);
    expect(row.workloadIdentityId).toBe(bindingId);
    // Nothing to present and nothing to read as authority. Each of these is the
    // reason one of the schema's CHECKs exists, asserted here on the value the
    // writer actually chooses rather than on the constraint.
    expect(row.publicKey).toBeNull();
    expect(row.secretHash).toBeNull();
    expect(row.tokenPrefix).toBeNull();
    expect(row.tokenHash).toBeNull();
    expect(row.scopes).toEqual([]);
    // The name is the role, for whoever reads the table; it is never compared.
    expect(row.name).toBe(subject);
  });

  it('is idempotent — a second call reports `unchanged` and writes nothing new', async () => {
    const applicationId = await applicationFixture();
    const subject = roleArn();
    const bindingId = await bindingFixture(applicationId, subject);

    await ensureWorkloadAttributionIdentity({ bindingId, applicationId, subject });
    const before = await readRow(workloadAttestationHandle(subject));
    const again = await ensureWorkloadAttributionIdentity({ bindingId, applicationId, subject });

    expect(again.state).toBe('unchanged');
    const after = await readRow(workloadAttestationHandle(subject));
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('reattaches a re-bound subject to its OWN row rather than starting a second identity', async () => {
    const applicationId = await applicationFixture();
    const subject = roleArn();
    const first = await bindingFixture(applicationId, subject);
    const { credentialId } = await ensureWorkloadAttributionIdentity({
      bindingId: first,
      applicationId,
      subject,
    });

    // Unbind — how a compromised or retiring workload is cut off — then bind the
    // same role again, which is a routine operator action.
    await getDb()
      .delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.id, first));
    expect((await readRow(credentialId)).workloadIdentityId).toBeNull();

    const second = await bindingFixture(applicationId, subject);
    const relinked = await ensureWorkloadAttributionIdentity({
      bindingId: second,
      applicationId,
      subject,
    });

    // The SAME id, because the handle derives from the subject and from nothing
    // else — so the spend the role already made is still its own.
    expect(relinked).toEqual({ credentialId, state: 'relinked' });
    expect((await readRow(credentialId)).workloadIdentityId).toBe(second);
  });

  it('refuses to re-attribute a subject whose history belongs to another application', async () => {
    const first = await applicationFixture();
    const second = await applicationFixture();
    const subject = roleArn();
    const bindingId = await bindingFixture(first, subject);
    await ensureWorkloadAttributionIdentity({ bindingId, applicationId: first, subject });

    await getDb()
      .delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.id, bindingId));
    const moved = await bindingFixture(second, subject);

    const error = await ensureWorkloadAttributionIdentity({
      bindingId: moved,
      applicationId: second,
      subject,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkloadAttributionError);
    expect((error as WorkloadAttributionError).reason).toBe('attributed_elsewhere');
    // Neither relabelled nor relinked: the row still names the application that
    // spent the money.
    const row = await readRow(workloadAttestationHandle(subject));
    expect(row.applicationId).toBe(first);
    expect(row.workloadIdentityId).toBeNull();
  });
});

describe('bindWorkloadIdentity materialises the row', () => {
  it('creates it with the binding, in one transaction', async () => {
    const applicationId = await applicationFixture();
    const subject = roleArn();

    const result = await bindWorkloadIdentity({
      applicationId,
      subject,
      provider: 'aws-iam',
      actor: STAFF,
    });
    expect(result.state).toBe('created');

    const row = await readRow(result.binding.attestationId);
    expect(row).toBeDefined();
    expect(row.workloadIdentityId).toBe(result.binding.id);
  });

  it('repairs a binding written before the row existed, on the command an operator re-runs', async () => {
    // The thirteen services already credential-free in production are in exactly
    // this state: a binding row and no materialised row. A raw insert reproduces
    // it, and the deploy step's re-run is what heals it — which is why the
    // migration carries no backfill.
    const applicationId = await applicationFixture();
    const subject = roleArn();
    const bindingId = await bindingFixture(applicationId, subject);
    const handle = workloadAttestationHandle(subject);
    expect(await readRow(handle)).toBeUndefined();

    const result = await bindWorkloadIdentity({
      applicationId,
      subject,
      provider: 'aws-iam',
      actor: STAFF,
    });
    // A re-run is not a create, and does not pretend to be one.
    expect(result.state).toBe('unchanged');
    expect((await readRow(handle)).workloadIdentityId).toBe(bindingId);
  });

  it('refuses a bind whose subject is attributed to another application', async () => {
    const first = await applicationFixture();
    const second = await applicationFixture();
    const subject = roleArn();
    const bindingId = await bindingFixture(first, subject);
    await ensureWorkloadAttributionIdentity({ bindingId, applicationId: first, subject });
    await getDb()
      .delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.id, bindingId));

    const error = await bindWorkloadIdentity({
      applicationId: second,
      subject,
      provider: 'aws-iam',
      actor: STAFF,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkloadBindingError);
    expect((error as WorkloadBindingError).reason).toBe('subject_attributed_elsewhere');
    // The refusal is a refusal, not a half-written state: no binding row exists.
    const bindings = await getDb()
      .select({ id: applicationWorkloadIdentities.id })
      .from(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.applicationId, second));
    expect(bindings).toHaveLength(0);
  });
});

describe('a workload row cannot authenticate as a credential', () => {
  async function materialised(): Promise<{ applicationId: string; handle: string }> {
    const applicationId = await applicationFixture();
    const subject = roleArn();
    const bindingId = await bindingFixture(applicationId, subject);
    const { credentialId } = await ensureWorkloadAttributionIdentity({
      bindingId,
      applicationId,
      subject,
    });
    return { applicationId, handle: credentialId };
  }

  it('is not resolvable as a credential by its row id', async () => {
    const { handle } = await materialised();
    // The explicit exclusion, on the one lookup that could otherwise match:
    // `resolveServiceTokenPrincipal` routes a `wl_` claim away from here, but this
    // function has other callers and the row has no secret, no scopes and no
    // public identifier for them to build an attribution from.
    await expect(resolveCredentialAttributionById(handle)).resolves.toEqual({
      status: 'unknown-credential',
      clientId: handle,
    });
  });

  it('is not resolvable as an OAuth client, by its handle or by anything else', async () => {
    const { handle } = await materialised();
    // By construction rather than by filter: `public_key` is NULL on a workload
    // row and every OAuth lane resolves `public_key = $1`, which no NULL
    // satisfies. There is no value a caller can send that finds this row.
    await expect(resolveCredentialAttribution(handle)).resolves.toEqual({
      status: 'unknown-credential',
      clientId: handle,
    });
    await expect(resolveApplicationIdFromClientId(handle)).resolves.toBeNull();
  });

  it('is not a service principal, so it cannot re-read as one on a control-plane call', async () => {
    const { applicationId, handle } = await materialised();
    // `loadPrincipal` requires `type = 'service'`. A workload row reaching it
    // would be a caller acting on capabilities and provider connections with no
    // credential behind it at all.
    await expect(resolveLiveAgencyCoordinator(applicationId, handle)).resolves.toBeNull();
  });
});
