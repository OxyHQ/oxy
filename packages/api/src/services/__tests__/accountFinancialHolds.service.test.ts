/**
 * What stands between an account and deletion, against a REAL Postgres.
 *
 * ## The blocking set is derived, and this file proves it can SEE
 *
 * `listRestrictingReferences` reads `pg_constraint`. A test asserting "the
 * financial tables are in the list" would pass just as happily against a query
 * that returned every foreign key in the database, so the assertions here are
 * two-sided: the financial tables ARE present, a table referencing `users` with
 * `ON DELETE CASCADE` is NOT, and the list has a non-zero floor. Without the
 * negative control, a broken predicate reads as a working one.
 *
 * ## The bug this module exists for
 *
 * `DELETE /users/me` used to destroy the mailboxes, the identity backup, the
 * sessions and the whole social graph and THEN fail on a foreign key violation
 * for any account that had ever transacted. The route now asks this module
 * first. The test that matters is therefore not "holds are detected" but "an
 * account with a receipt is reported as blocking", because that is the input the
 * route branches on.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { billingSubscriptions } from '../../db/schema/billingSubscriptions';
import {
  inferenceProviderConnections,
  type ProviderCredentialCustodyStateValue,
  type ProviderConnectionStatusValue,
} from '../../db/schema/inferenceProviderConnections';
import { inferenceProviders } from '../../db/schema/inferenceProviders';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { users } from '../../db/schema/users';
import {
  archiveAccountForRetention,
  describeAccountFinancialHolds,
  listRestrictingReferences,
} from '../accountFinancialHolds.service';
import { provisionBillingProfile, reserve, settle } from '../inferenceLedger.service';

jest.setTimeout(60_000);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function seedAccount(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [account] = await getDb()
    .insert(users)
    .values({ username: `hold-${suffix}`, email: `hold-${suffix}@example.test` })
    .returning({ id: users.id });
  return account.id;
}

async function seedSpender(): Promise<{
  accountId: string;
  applicationId: string;
  credentialId: string;
  priceVersionId: string;
}> {
  const accountId = await seedAccount();
  const suffix = randomUUID().slice(0, 8);

  await provisionBillingProfile({
    accountId,
    billingMode: 'invoiced',
    creditLimit: '100.000000000000',
  });

  const [application] = await getDb()
    .insert(applications)
    .values({ name: `Hold ${suffix}`, ownerAccountId: accountId })
    .returning({ id: applications.id });
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: application.id,
      name: 'test',
      publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
      type: 'service',
      environment: 'production',
    })
    .returning({ id: applicationCredentials.id });

  const [version] = await getDb()
    .insert(priceVersions)
    .values({
      modelReference: `oxy/hold-${suffix}`,
      provider: 'oxy-hosted',
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });
  await getDb().insert(priceVersionUnitPrices).values({
    priceVersionId: version.id,
    unit: 'input_tokens',
    amount: '3.000000000000',
    per: 1_000_000,
  });

  return {
    accountId,
    applicationId: application.id,
    credentialId: credential.id,
    priceVersionId: version.id,
  };
}

describe('the blocking set is read from the catalogue', () => {
  it('finds the financial tables and excludes the cascading ones', async () => {
    const references = await listRestrictingReferences();
    const tables = references.map((reference) => reference.table);

    // A floor first: an empty or near-empty list would make every "is present"
    // assertion below pass for the wrong reason.
    expect(references.length).toBeGreaterThan(5);

    for (const table of [
      'usage_receipts',
      'billing_ledger_entries',
      'billing_transactions',
      'billing_profiles',
      'account_balances',
      'billing_external_payments',
    ]) {
      expect(tables).toContain(table);
    }

    // The NEGATIVE control. `user_credits` references `users` with ON DELETE
    // CASCADE, so a predicate that ignored `confdeltype` would list it — and
    // would then report every account on the platform as unblockable.
    expect(tables).not.toContain('user_credits');
  });
});

/**
 * A BYOK connection row in a chosen status.
 *
 * The id is generated here to mirror the exact identity bound to Kaana's opaque
 * handle and revision.
 */
async function seedProviderConnection(
  accountId: string,
  status: ProviderConnectionStatusValue,
  custodyState: ProviderCredentialCustodyStateValue = 'ready'
): Promise<string> {
  const tag = randomUUID().replace(/-/g, '').slice(0, 10);
  const provider = `prv${tag}`;
  await getDb().insert(inferenceProviders).values({
    slug: provider,
    displayName: 'Holds Fixture Provider',
    kind: 'customer_byok',
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });

  const id = uuidv7();
  const environment = 'production';
  await getDb()
    .insert(inferenceProviderConnections)
    .values({
      id,
      provider,
      ownerAccountId: accountId,
      scopeKind: 'account',
      applicationId: null,
      environment,
      status,
      custodyState,
      credentialHandle: `kcred_${'a'.repeat(16)}${tag.replace(/[0189]/g, 'a')}`,
      credentialRevision: 1,
      validationState: status === 'active' ? 'valid' : 'unvalidated',
    });
  return id;
}

describe('an account that has never transacted', () => {
  it('reports nothing standing in the way', async () => {
    const accountId = await seedAccount();
    const holds = await describeAccountFinancialHolds(accountId);

    expect(holds.blocksHardDelete).toBe(false);
    expect(holds.hasLiveSubscription).toBe(false);
    expect(holds.heldReservations).toBe(0);
    expect(holds.hasLiveProviderConnection).toBe(false);
    expect(holds.liveProviderConnections).toEqual([]);
    expect(holds.retainedRecords).toEqual([]);
  });
});

/**
 * The arm that is not financial (#972 section 12).
 *
 * `inference_provider_connections.owner_account_id` is `RESTRICT` so that account
 * deletion cannot orphan a credential in the secret store, and its schema comment
 * promises "Account deletion must revoke these first, which is a deliberate, loud
 * step". The step did not exist: an account with a live connection archived and
 * the row stayed live, with its credential still in the store and the table
 * listed among the records Oxy claimed to be retaining for legal reasons.
 *
 * Custody acknowledgement is the whole claim. Serving status still exercises
 * active/disabled/pending-validation, while the critical cases pin that a local
 * `status='revoked'` cannot bypass the hold until Kaana has acknowledged
 * `custody_state='revoked'`.
 */
describe('a BYOK connection whose credential is still in the secret store', () => {
  it('is reported for an ACTIVE connection, by id', async () => {
    const accountId = await seedAccount();
    const connectionId = await seedProviderConnection(accountId, 'active');

    const holds = await describeAccountFinancialHolds(accountId);
    expect(holds.hasLiveProviderConnection).toBe(true);
    expect(holds.liveProviderConnections).toEqual([connectionId]);
  });

  it('is reported for a DISABLED connection, which keeps its secret', async () => {
    const accountId = await seedAccount();
    const connectionId = await seedProviderConnection(accountId, 'disabled');

    const holds = await describeAccountFinancialHolds(accountId);
    // `disabled` is reversible and only `revoke` destroys a stored credential, so
    // "may a request be served through it" is the wrong question here.
    expect(holds.liveProviderConnections).toEqual([connectionId]);
  });

  it('is reported for a connection still PENDING VALIDATION', async () => {
    const accountId = await seedAccount();
    const connectionId = await seedProviderConnection(accountId, 'pending_validation');

    const holds = await describeAccountFinancialHolds(accountId);
    expect(holds.liveProviderConnections).toEqual([connectionId]);
  });

  it('still blocks after local revoke while custody is ready', async () => {
    const accountId = await seedAccount();
    const connectionId = await seedProviderConnection(accountId, 'revoked', 'ready');

    const holds = await describeAccountFinancialHolds(accountId);
    expect(holds.liveProviderConnections).toEqual([connectionId]);
  });

  it('still blocks while a fenced revoke awaits reconciliation', async () => {
    const accountId = await seedAccount();
    const connectionId = await seedProviderConnection(accountId, 'revoked', 'reconcile');

    const holds = await describeAccountFinancialHolds(accountId);
    expect(holds.liveProviderConnections).toEqual([connectionId]);
  });

  it('is NOT reported once Kaana acknowledges revoked custody', async () => {
    const accountId = await seedAccount();
    await seedProviderConnection(accountId, 'revoked', 'revoked');

    const holds = await describeAccountFinancialHolds(accountId);
    expect(holds.hasLiveProviderConnection).toBe(false);
    expect(holds.liveProviderConnections).toEqual([]);
    // But the row still BLOCKS a hard delete, and that is the distinction the
    // readout's own documentation now makes: a blocking reference is not the same
    // thing as a financial record.
    expect(holds.blocksHardDelete).toBe(true);
    expect(holds.retainedRecords.map((record) => record.table)).toContain(
      'inference_provider_connections'
    );
  });

  it('refuses archival until custody is revoked, then establishes the archive fence', async () => {
    const accountId = await seedAccount();
    const connectionId = await seedProviderConnection(accountId, 'active');

    await expect(archiveAccountForRetention(accountId)).rejects.toMatchObject({
      statusCode: 409,
      details: { providerConnections: [connectionId] },
    });
    const [stillActive] = await getDb()
      .select({ status: users.accountStatus })
      .from(users)
      .where(eq(users.id, accountId));
    expect(stillActive.status).toBe('active');

    await getDb()
      .update(inferenceProviderConnections)
      .set({ status: 'revoked', custodyState: 'revoked' })
      .where(eq(inferenceProviderConnections.id, connectionId));
    await archiveAccountForRetention(accountId);
    const [archived] = await getDb()
      .select({ status: users.accountStatus })
      .from(users)
      .where(eq(users.id, accountId));
    expect(archived.status).toBe('archived');
  });
});

describe('an account with retained financial history', () => {
  it('reports the tables that block, by name and count', async () => {
    const fixture = await seedSpender();
    await settle({
      idempotencyKey: `settle-${randomUUID()}`,
      attribution: {
        accountId: fixture.accountId,
        applicationId: fixture.applicationId,
        applicationCredentialId: fixture.credentialId,
        requestId: `req-${randomUUID()}`,
        environment: 'production',
      },
      outcome: 'completed',
      usageSource: 'provider_reported',
      units: { input_tokens: 1_000_000 },
      resolvedModelReference: 'oxy/hold',
      servingProvider: 'oxy-hosted',
      priceVersionId: fixture.priceVersionId,
    });

    const holds = await describeAccountFinancialHolds(fixture.accountId);
    expect(holds.blocksHardDelete).toBe(true);

    const byTable = new Map(
      holds.retainedRecords.map((record) => [record.table, record.rows])
    );
    expect(byTable.get('usage_receipts')).toBe(1);
    expect(byTable.get('billing_profiles')).toBe(1);
    expect(byTable.get('account_balances')).toBe(1);
    expect((byTable.get('billing_ledger_entries') ?? 0) > 0).toBe(true);
  });

  it('archives rather than deleting, and the archived account cannot act', async () => {
    const fixture = await seedSpender();
    await archiveAccountForRetention(fixture.accountId);

    const [account] = await getDb()
      .select({ status: users.accountStatus })
      .from(users)
      .where(eq(users.id, fixture.accountId))
      .limit(1);
    // `archived` is an existing state with existing meaning:
    // `accountService.resolveEffectiveAccess` resolves an archived account to
    // nothing, so no membership or application access survives it.
    expect(account.status).toBe('archived');
  });
});

describe('money in flight and live subscriptions', () => {
  it('reports a held reservation', async () => {
    const fixture = await seedSpender();
    const held = await reserve({
      idempotencyKey: `reserve-${randomUUID()}`,
      attribution: {
        accountId: fixture.accountId,
        applicationId: fixture.applicationId,
        applicationCredentialId: fixture.credentialId,
        requestId: `req-${randomUUID()}`,
        environment: 'production',
      },
      ceilingPriceVersionId: fixture.priceVersionId,
      maxAmount: '1.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    expect(held.status).toBe('reserved');

    const holds = await describeAccountFinancialHolds(fixture.accountId);
    // Money neither spent nor returned. Deleting through it strands it.
    expect(holds.heldReservations).toBe(1);
  });

  it('reports a live subscription, which Stripe would keep billing', async () => {
    const accountId = await seedAccount();
    const [subscription] = await getDb()
      .insert(billingSubscriptions)
      .values({
        userId: accountId,
        stripeCustomerId: `cus_${randomUUID().replace(/-/g, '')}`,
        stripeSubscriptionId: `sub_${randomUUID().replace(/-/g, '')}`,
        stripePriceId: 'price_test',
        status: 'active',
        currentPeriodStart: new Date(Date.now() - 1000),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        planName: 'Pro',
        planCreditsPerMonth: 10_000,
        planPriceMinorUnits: 2999,
      })
      .returning({ id: billingSubscriptions.id });

    const holds = await describeAccountFinancialHolds(accountId);
    expect(holds.hasLiveSubscription).toBe(true);
    expect(holds.liveSubscriptionIds).toEqual([subscription.id]);
  });

  it('does not report a cancelled subscription as live', async () => {
    const accountId = await seedAccount();
    await getDb()
      .insert(billingSubscriptions)
      .values({
        userId: accountId,
        stripeCustomerId: `cus_${randomUUID().replace(/-/g, '')}`,
        stripeSubscriptionId: `sub_${randomUUID().replace(/-/g, '')}`,
        stripePriceId: 'price_test',
        status: 'canceled',
        currentPeriodStart: new Date(Date.now() - 1000),
        currentPeriodEnd: new Date(Date.now() + 1000),
        planName: 'Pro',
        planCreditsPerMonth: 10_000,
        planPriceMinorUnits: 2999,
      });

    const holds = await describeAccountFinancialHolds(accountId);
    expect(holds.hasLiveSubscription).toBe(false);
  });
});
