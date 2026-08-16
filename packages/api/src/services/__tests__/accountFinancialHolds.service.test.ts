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
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { billingSubscriptions } from '../../db/schema/billingSubscriptions';
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

describe('an account that has never transacted', () => {
  it('reports nothing standing in the way', async () => {
    const accountId = await seedAccount();
    const holds = await describeAccountFinancialHolds(accountId);

    expect(holds.blocksHardDelete).toBe(false);
    expect(holds.hasLiveSubscription).toBe(false);
    expect(holds.heldReservations).toBe(0);
    expect(holds.retainedRecords).toEqual([]);
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
