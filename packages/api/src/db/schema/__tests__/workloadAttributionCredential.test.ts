/**
 * The materialised `workload` row, against a REAL Postgres.
 *
 * ADR 0026's attested caller authenticates and then has to SPEND, and four tables
 * carry the identity that authorised a spend in `application_credential_id`,
 * `NOT NULL`, with a foreign key to `application_credentials.id` — on
 * `inference_usage_daily_rollups` as part of the PRIMARY KEY. The answer in
 * `db/schema/applicationCredentials.ts` is a row whose `id` IS the attestation
 * handle, so those four constraints keep working untouched.
 *
 * Two claims are load-bearing and neither is checkable by reading:
 *
 *   1. the four foreign keys, the rollup primary key and the chosen cascade
 *      behaviour all actually accept and hold an attested identity;
 *   2. a `workload` row cannot be made to look like a credential. That is four
 *      CHECK constraints rather than filter discipline, so each one is asserted
 *      here against the database that enforces it.
 *
 * Every row carries a per-test random identifier, so no assertion depends on a
 * table being empty.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { accountBalances } from '../accountBalances';
import { applications } from '../applications';
import { applicationCredentials } from '../applicationCredentials';
import { applicationWorkloadIdentities } from '../applicationWorkloadIdentities';
import { billingProfiles } from '../billingProfiles';
import { inferenceUsageDailyRollups } from '../inferenceUsageDailyRollups';
import { inferenceUsageEvents } from '../inferenceUsageEvents';
import { zeroUsageUnits } from '../ledgerColumns';
import { priceVersions } from '../priceVersions';
import { usageReceipts } from '../usageReceipts';
import { usageReservations } from '../usageReservations';
import { users } from '../users';
import { workloadAttestationHandle } from '../../../services/workloadAttestation.service';

/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';
/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';
/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/**
 * `ON DELETE RESTRICT` reports `23503 foreign_key_violation`, not `23001`.
 * Postgres raises `restrict_violation` only for a deferred `NO ACTION` check.
 */
const RESTRICT_REFUSAL = FOREIGN_KEY_VIOLATION;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** The SQLSTATE a driver error carries, walking drizzle's wrapper chain. */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** The named constraint that refused a statement, from the driver's own error. */
function pgConstraint(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const name: unknown = Reflect.get(current, 'constraint_name');
    if (typeof name === 'string') return name;
  }
  return undefined;
}

async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the statement to be rejected, but it succeeded.');
}

interface Fixture {
  accountId: string;
  applicationId: string;
  bindingId: string;
  subject: string;
  /** The `wl_…` handle, which is also the materialised row's id. */
  handle: string;
  priceVersionId: string;
}

async function fixture(): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const [account] = await getDb()
    .insert(users)
    .values({ username: `wlattr-${suffix}`, email: `wlattr-${suffix}@example.test` })
    .returning({ id: users.id });
  const [application] = await getDb()
    .insert(applications)
    .values({
      name: `Workload attribution ${suffix}`,
      ownerAccountId: account.id,
      type: 'first_party',
      isOfficial: true,
      isInternal: true,
    })
    .returning({ id: applications.id });
  const subject = `arn:aws:iam::237343248947:role/oxy-test-${suffix}`;
  const [binding] = await getDb()
    .insert(applicationWorkloadIdentities)
    .values({ applicationId: application.id, provider: 'aws-iam', subject })
    .returning({ id: applicationWorkloadIdentities.id });
  const [priceVersion] = await getDb()
    .insert(priceVersions)
    .values({
      modelReference: `oxy/test-${suffix}`,
      provider: 'oxy-hosted',
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });
  await getDb().insert(billingProfiles).values({ accountId: account.id });
  await getDb().insert(accountBalances).values({ accountId: account.id, currency: 'USD' });
  return {
    accountId: account.id,
    applicationId: application.id,
    bindingId: binding.id,
    subject,
    handle: workloadAttestationHandle(subject),
    priceVersionId: priceVersion.id,
  };
}

/** The materialised row, written exactly as the service writes it. */
async function insertWorkloadRow(f: Fixture): Promise<void> {
  await getDb()
    .insert(applicationCredentials)
    .values({
      id: f.handle,
      applicationId: f.applicationId,
      name: f.subject,
      publicKey: null,
      type: 'workload',
      environment: 'production',
      scopes: [],
      workloadIdentityId: f.bindingId,
    });
}

describe('the ledger can name an attested identity', () => {
  it('holds a reservation and a receipt whose credential is a wl_ handle', async () => {
    const f = await fixture();
    await insertWorkloadRow(f);

    const requestId = `req-${randomUUID()}`;
    const [reservation] = await getDb()
      .insert(usageReservations)
      .values({
        idempotencyKey: `res-${randomUUID()}`,
        accountId: f.accountId,
        applicationId: f.applicationId,
        applicationCredentialId: f.handle,
        requestId,
        environment: 'production',
        reservedAmount: '1.000000000000',
        ceilingPriceVersionId: f.priceVersionId,
        ...zeroUsageUnits(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({
        id: usageReservations.id,
        applicationCredentialId: usageReservations.applicationCredentialId,
      });
    expect(reservation.applicationCredentialId).toBe(f.handle);
    expect(reservation.applicationCredentialId.startsWith('wl_')).toBe(true);

    const [receipt] = await getDb()
      .insert(usageReceipts)
      .values({
        idempotencyKey: `rcp-${randomUUID()}`,
        reservationId: reservation.id,
        accountId: f.accountId,
        applicationId: f.applicationId,
        applicationCredentialId: f.handle,
        requestId,
        environment: 'production',
        outcome: 'completed',
        usageSource: 'provider_reported',
        ...zeroUsageUnits(),
        outputTokens: 10,
        resolvedModelReference: 'oxy/test',
        servingProvider: 'oxy-hosted',
        priceVersionId: f.priceVersionId,
        billedAmount: '0.000030000000',
        settledAt: new Date(),
      })
      .returning({ applicationCredentialId: usageReceipts.applicationCredentialId });
    expect(receipt.applicationCredentialId).toBe(f.handle);
  });

  it('refuses a wl_ handle that names no row, so the foreign key is real', async () => {
    const f = await fixture();
    // Deliberately NOT materialised: this is the exact failure the inference
    // edge's `workload_attribution_unsupported` holding position stood in for.
    const error = await rejection(
      getDb()
        .insert(usageReservations)
        .values({
          idempotencyKey: `res-${randomUUID()}`,
          accountId: f.accountId,
          applicationId: f.applicationId,
          applicationCredentialId: f.handle,
          requestId: `req-${randomUUID()}`,
          environment: 'production',
          reservedAmount: '1.000000000000',
          ceilingPriceVersionId: f.priceVersionId,
          ...zeroUsageUnits(),
          expiresAt: new Date(Date.now() + 60_000),
        })
    );
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('accepts an attested identity in the rollup PRIMARY KEY and upserts onto it', async () => {
    const f = await fixture();
    await insertWorkloadRow(f);

    const key = {
      day: '2026-09-25',
      accountId: f.accountId,
      applicationId: f.applicationId,
      applicationCredentialId: f.handle,
      environment: 'production' as const,
      requestedModelReference: 'oxy/test',
      servingProvider: 'oxy-hosted',
      outcome: 'completed' as const,
    };
    for (const _ of [1, 2]) {
      await getDb()
        .insert(inferenceUsageDailyRollups)
        .values({ ...key, requestCount: 1, ...zeroUsageUnits() })
        .onConflictDoUpdate({
          target: [
            inferenceUsageDailyRollups.day,
            inferenceUsageDailyRollups.accountId,
            inferenceUsageDailyRollups.applicationId,
            inferenceUsageDailyRollups.applicationCredentialId,
            inferenceUsageDailyRollups.environment,
            inferenceUsageDailyRollups.requestedModelReference,
            inferenceUsageDailyRollups.servingProvider,
            inferenceUsageDailyRollups.outcome,
          ],
          set: { requestCount: sql`${inferenceUsageDailyRollups.requestCount} + 1` },
        });
    }

    const rows = await getDb()
      .select({ requestCount: inferenceUsageDailyRollups.requestCount })
      .from(inferenceUsageDailyRollups)
      .where(
        and(
          eq(inferenceUsageDailyRollups.applicationCredentialId, f.handle),
          eq(inferenceUsageDailyRollups.day, key.day)
        )
      );
    // One row, counted twice: the PK treated the handle as one identity rather
    // than inserting a second row beside it.
    expect(rows).toHaveLength(1);
    expect(rows[0].requestCount).toBe(2);
  });
});

describe('a deleted binding does not take the spend with it', () => {
  it('keeps the row and its ledger history, and records the deletion as a NULL link', async () => {
    const f = await fixture();
    await insertWorkloadRow(f);
    await getDb()
      .insert(usageReservations)
      .values({
        idempotencyKey: `res-${randomUUID()}`,
        accountId: f.accountId,
        applicationId: f.applicationId,
        applicationCredentialId: f.handle,
        requestId: `req-${randomUUID()}`,
        environment: 'production',
        reservedAmount: '1.000000000000',
        ceilingPriceVersionId: f.priceVersionId,
        ...zeroUsageUnits(),
        expiresAt: new Date(Date.now() + 60_000),
      });

    // Deleting the binding is how a compromised workload is cut off.
    await getDb()
      .delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.id, f.bindingId));

    const [row] = await getDb()
      .select({
        id: applicationCredentials.id,
        workloadIdentityId: applicationCredentials.workloadIdentityId,
        applicationId: applicationCredentials.applicationId,
      })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.id, f.handle));
    // `SET NULL`, not `CASCADE`: the identity that authorised the spend survives,
    // and the NULL is itself the record that the binding is no longer live.
    expect(row).toBeDefined();
    expect(row.workloadIdentityId).toBeNull();
    expect(row.applicationId).toBe(f.applicationId);

    const reservations = await getDb()
      .select({ id: usageReservations.id })
      .from(usageReservations)
      .where(eq(usageReservations.applicationCredentialId, f.handle));
    expect(reservations).toHaveLength(1);
  });

  it('refuses to delete the materialised row while a reservation references it', async () => {
    const f = await fixture();
    await insertWorkloadRow(f);
    await getDb()
      .insert(usageReservations)
      .values({
        idempotencyKey: `res-${randomUUID()}`,
        accountId: f.accountId,
        applicationId: f.applicationId,
        applicationCredentialId: f.handle,
        requestId: `req-${randomUUID()}`,
        environment: 'production',
        reservedAmount: '1.000000000000',
        ceilingPriceVersionId: f.priceVersionId,
        ...zeroUsageUnits(),
        expiresAt: new Date(Date.now() + 60_000),
      });

    const error = await rejection(
      getDb().delete(applicationCredentials).where(eq(applicationCredentials.id, f.handle))
    );
    // `RESTRICT` on `usage_reservations`, inherited unchanged — an attested
    // identity with spend against it is exactly as undeletable as a credential
    // with spend against it.
    expect(pgErrorCode(error)).toBe(RESTRICT_REFUSAL);
    expect(pgConstraint(error)).toBe(
      'usage_reservations_application_credential_id_application_creden'
    );
  });

  it('cascades the usage EVENT away with the row, as it does for a credential', async () => {
    const f = await fixture();
    await insertWorkloadRow(f);
    await getDb()
      .insert(inferenceUsageEvents)
      .values({
        accountId: f.accountId,
        applicationId: f.applicationId,
        applicationCredentialId: f.handle,
        requestId: `req-${randomUUID()}`,
        environment: 'production',
        requestedModelReference: 'oxy/test',
        servingProvider: 'oxy-hosted',
        outcome: 'completed',
        endpoint: '/v1/chat/completions',
        statusCode: 200,
        usageSource: 'provider_reported',
        ...zeroUsageUnits(),
      });

    await getDb().delete(applicationCredentials).where(eq(applicationCredentials.id, f.handle));
    const events = await getDb()
      .select({ id: inferenceUsageEvents.id })
      .from(inferenceUsageEvents)
      .where(eq(inferenceUsageEvents.applicationCredentialId, f.handle));
    // The behaviour the FK declares, unchanged. It is also the reason `SET NULL`
    // above is the only defensible choice on the binding link: a `CASCADE` there
    // would reach this table and destroy a retired service's usage history.
    expect(events).toHaveLength(0);
  });
});

describe('a workload row cannot be made to look like a credential', () => {
  it('refuses a workload row that carries an OAuth public identifier', async () => {
    const f = await fixture();
    const error = await rejection(
      getDb()
        .insert(applicationCredentials)
        .values({
          id: f.handle,
          applicationId: f.applicationId,
          name: f.subject,
          publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
          type: 'workload',
          environment: 'production',
          workloadIdentityId: f.bindingId,
        })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraint(error)).toBe('application_credentials_workload_public_key_check');
  });

  it('still refuses a real credential with no public identifier', async () => {
    const f = await fixture();
    const error = await rejection(
      getDb()
        .insert(applicationCredentials)
        .values({
          applicationId: f.applicationId,
          name: 'secretless service',
          publicKey: null,
          type: 'service',
          environment: 'production',
        })
    );
    // The biconditional, in the direction the old `not null` used to hold: making
    // the column nullable for one row kind must not make a credential nobody can
    // identify representable.
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraint(error)).toBe('application_credentials_workload_public_key_check');
  });

  it('refuses a workload row that carries a secret hash', async () => {
    const f = await fixture();
    const error = await rejection(
      getDb()
        .insert(applicationCredentials)
        .values({
          id: f.handle,
          applicationId: f.applicationId,
          name: f.subject,
          publicKey: null,
          secretHash: 'a'.repeat(64),
          type: 'workload',
          environment: 'production',
          workloadIdentityId: f.bindingId,
        })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraint(error)).toBe('application_credentials_workload_inert_check');
  });

  it('refuses a workload row that names scopes', async () => {
    const f = await fixture();
    const error = await rejection(
      getDb()
        .insert(applicationCredentials)
        .values({
          id: f.handle,
          applicationId: f.applicationId,
          name: f.subject,
          publicKey: null,
          type: 'workload',
          environment: 'production',
          scopes: ['inference:invoke'],
          workloadIdentityId: f.bindingId,
        })
    );
    // Authority is the binding's, decided live. A copy here would be a second,
    // stale answer to the same question.
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraint(error)).toBe('application_credentials_workload_inert_check');
  });

  it('refuses a workload row whose id is not an attestation handle', async () => {
    const f = await fixture();
    const error = await rejection(
      getDb()
        .insert(applicationCredentials)
        .values({
          applicationId: f.applicationId,
          name: f.subject,
          publicKey: null,
          type: 'workload',
          environment: 'production',
          workloadIdentityId: f.bindingId,
        })
    );
    // A generated uuid v7 — which is what a rotation of a workload row would mint.
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraint(error)).toBe('application_credentials_workload_handle_id_check');
  });

  it('refuses a real credential whose id looks like an attestation handle', async () => {
    const f = await fixture();
    const error = await rejection(
      getDb()
        .insert(applicationCredentials)
        .values({
          id: `wl_${'0'.repeat(24)}`,
          applicationId: f.applicationId,
          name: 'impostor',
          publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
          type: 'service',
          environment: 'production',
        })
    );
    // The other direction, and the one that matters for routing:
    // `isWorkloadAttestationHandle` sends a `wl_` claim to the BINDING resolver,
    // so a credential row reachable by one would be reachable by a claim meant
    // for something else. The CHECK makes that unrepresentable rather than a
    // property of how ids happen to be generated.
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraint(error)).toBe('application_credentials_workload_handle_id_check');
  });

  it('refuses a binding link on a row that is not a workload row', async () => {
    const f = await fixture();
    const error = await rejection(
      getDb()
        .insert(applicationCredentials)
        .values({
          applicationId: f.applicationId,
          name: 'service with a binding',
          publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
          type: 'service',
          environment: 'production',
          workloadIdentityId: f.bindingId,
        })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraint(error)).toBe('application_credentials_workload_identity_only_check');
  });

  it('allows at most one materialised row per binding', async () => {
    const f = await fixture();
    await insertWorkloadRow(f);
    const other = `arn:aws:iam::237343248947:role/oxy-other-${randomUUID().slice(0, 8)}`;
    const error = await rejection(
      getDb()
        .insert(applicationCredentials)
        .values({
          id: workloadAttestationHandle(other),
          applicationId: f.applicationId,
          name: other,
          publicKey: null,
          type: 'workload',
          environment: 'production',
          workloadIdentityId: f.bindingId,
        })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });
});
