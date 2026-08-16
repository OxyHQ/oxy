/**
 * Product entitlements and cost centres, against a REAL Postgres.
 *
 * The property this file exists to hold is the SEPARATION, and it is asserted
 * structurally rather than described: allowances are integer counts, money is an
 * exact decimal string, and `productEntitlementSchema` is `.strict()` with no
 * field that is both. A serializer that started emitting "total credits
 * including balance" would fail here rather than in a product that then bills
 * its users against it.
 *
 * The second property is that `payAsYouGo: null` and a zero balance are
 * DIFFERENT answers. Collapsing them is the audit's §6 finding, and a consumer
 * that treated them alike would either refuse a customer who has never been
 * provisioned or serve one who can never be charged.
 *
 * Cost-centre attribution is tested through settled RECEIPTS, not through the
 * telemetry stream, because #972 workstream 8 is explicit that the exact billed
 * amount comes from the financial ledger.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { userAncestors } from '../../db/schema/userAncestors';
import { userCredits } from '../../db/schema/userCredits';
import { users } from '../../db/schema/users';
import { productEntitlementSchema } from '@oxyhq/contracts';
import { updateBillingProfile } from '../accountBilling.service';
import {
  ALLOWANCE_KEYS,
  costCenterSpend,
  listCostCenters,
  registerCostCenter,
  resolveCostCenterForAccount,
  resolveCostCenterForApplication,
  resolveProductEntitlement,
  retireCostCenter,
} from '../entitlement.service';
import {
  provisionBillingProfile,
  recordPromotionalGrant,
  recordTopUp,
  settle,
} from '../inferenceLedger.service';

jest.setTimeout(60_000);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function seedAccount(parentAccountId?: string): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [account] = await getDb()
    .insert(users)
    .values({
      username: `ent-${suffix}`,
      email: `ent-${suffix}@example.test`,
      kind: parentAccountId === undefined ? 'organization' : 'project',
      parentAccountId,
    })
    .returning({ id: users.id });

  if (parentAccountId !== undefined) {
    const parentAncestors = await getDb()
      .select({ ancestorId: userAncestors.ancestorId, depth: userAncestors.depth })
      .from(userAncestors)
      .where(eq(userAncestors.userId, parentAccountId));

    await getDb()
      .insert(userAncestors)
      .values([
        ...parentAncestors.map((row) => ({
          userId: account.id,
          ancestorId: row.ancestorId,
          depth: row.depth,
        })),
        { userId: account.id, ancestorId: parentAccountId, depth: parentAncestors.length },
      ]);
  }
  return account.id;
}

async function seedApplication(ownerAccountId: string): Promise<{
  applicationId: string;
  credentialId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const [application] = await getDb()
    .insert(applications)
    .values({ name: `Ent ${suffix}`, ownerAccountId })
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
  return { applicationId: application.id, credentialId: credential.id };
}

async function seedPriceVersion(): Promise<string> {
  const [version] = await getDb()
    .insert(priceVersions)
    .values({
      modelReference: `oxy/ent-${randomUUID().slice(0, 8)}`,
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
  return version.id;
}


describe('a plan allowance and a balance are different things', () => {
  it('reports allowances as integers and money as exact decimals, with nothing that is both', async () => {
    const accountId = await seedAccount();
    await provisionBillingProfile({ accountId });
    await recordTopUp({
      idempotencyKey: `fund-${randomUUID()}`,
      accountId,
      currency: 'USD',
      amount: '25.000000000000',
    });
    await recordPromotionalGrant({
      idempotencyKey: `grant-${randomUUID()}`,
      accountId,
      currency: 'USD',
      amount: '5.000000000000',
    });
    await getDb()
      .insert(userCredits)
      .values({ userId: accountId, creditsPaid: 1200 })
      .onConflictDoUpdate({ target: userCredits.userId, set: { creditsPaid: 1200 } });

    const resolved = await resolveProductEntitlement(accountId);
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') return;
    const entitlement = resolved.entitlement;

    const purchased = entitlement.allowances.find(
      (allowance) => allowance.key === ALLOWANCE_KEYS.purchased
    );
    expect(purchased?.included).toBe(1200);
    expect(Number.isInteger(purchased?.included)).toBe(true);

    expect(entitlement.payAsYouGo).not.toBeNull();
    expect(typeof entitlement.payAsYouGo?.purchasedBalance).toBe('string');
    expect(Number(entitlement.payAsYouGo?.purchasedBalance)).toBe(25);
    expect(Number(entitlement.payAsYouGo?.promotionalBalance)).toBe(5);
    expect(entitlement.payAsYouGo?.canSpend).toBe(true);

    // Structural: the contract is strict and declares no combined figure, so a
    // serializer that started summing credits and money would fail HERE.
    expect(() =>
      productEntitlementSchema.parse({ ...entitlement, totalCredits: 1230 })
    ).toThrow();
  });

  it('reports payAsYouGo as null for an unprovisioned account, not as zero', async () => {
    const accountId = await seedAccount();

    const resolved = await resolveProductEntitlement(accountId);
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') return;
    // "Nobody has decided who pays for this account yet" is not "spent
    // everything", and a consumer that read them alike would serve an account
    // that can never be charged.
    expect(resolved.entitlement.payAsYouGo).toBeNull();
  });

  it('reports canSpend false for a suspended profile with money in it', async () => {
    const accountId = await seedAccount();
    await provisionBillingProfile({ accountId });
    await recordTopUp({
      idempotencyKey: `fund-${randomUUID()}`,
      accountId,
      currency: 'USD',
      amount: '10.000000000000',
    });
    await updateBillingProfile(accountId, { status: 'suspended' });

    const resolved = await resolveProductEntitlement(accountId);
    if (resolved.status !== 'resolved') throw new Error('expected a resolved entitlement');
    expect(Number(resolved.entitlement.payAsYouGo?.availableToSpend)).toBe(10);
    expect(resolved.entitlement.payAsYouGo?.canSpend).toBe(false);
  });

  it('refuses an unknown account', async () => {
    await expect(resolveProductEntitlement(`missing-${randomUUID()}`)).resolves.toMatchObject({
      status: 'unknown-account',
    });
  });
});

describe('a cost centre is an account, resolved nearest-first', () => {
  it('attributes a project to its organization when only the organization is a centre', async () => {
    const organizationId = await seedAccount();
    const projectId = await seedAccount(organizationId);
    const slug = `org-${randomUUID().slice(0, 8)}`;
    await registerCostCenter({ accountId: organizationId, slug, label: 'Org' });

    const resolved = await resolveCostCenterForAccount(projectId);
    expect(resolved?.slug).toBe(slug);
  });

  it('prefers the NEARER centre when a project has one of its own', async () => {
    const organizationId = await seedAccount();
    const projectId = await seedAccount(organizationId);
    const orgSlug = `org-${randomUUID().slice(0, 8)}`;
    const projectSlug = `prj-${randomUUID().slice(0, 8)}`;
    await registerCostCenter({ accountId: organizationId, slug: orgSlug, label: 'Org' });
    await registerCostCenter({ accountId: projectId, slug: projectSlug, label: 'Project' });

    const resolved = await resolveCostCenterForAccount(projectId);
    expect(resolved?.slug).toBe(projectSlug);
  });

  it('resolves an application through its owner account', async () => {
    const organizationId = await seedAccount();
    const slug = `app-${randomUUID().slice(0, 8)}`;
    await registerCostCenter({ accountId: organizationId, slug, label: 'Org' });
    const app = await seedApplication(organizationId);

    const resolved = await resolveCostCenterForApplication(app.applicationId);
    expect(resolved?.slug).toBe(slug);
  });

  it('refuses to move a slug to a different account', async () => {
    const firstId = await seedAccount();
    const secondId = await seedAccount();
    const slug = `fix-${randomUUID().slice(0, 8)}`;
    await registerCostCenter({ accountId: firstId, slug, label: 'First' });

    await expect(
      registerCostCenter({ accountId: secondId, slug, label: 'Second' })
    ).resolves.toMatchObject({ status: 'slug-taken' });
  });

  it('retires rather than deletes, and stops attributing new spend', async () => {
    const accountId = await seedAccount();
    const slug = `ret-${randomUUID().slice(0, 8)}`;
    await registerCostCenter({ accountId, slug, label: 'Retiring' });

    const retired = await retireCostCenter(slug);
    expect(retired.status).toBe('retired');
    expect(await resolveCostCenterForAccount(accountId)).toBeUndefined();

    // Still there, so a historical report that names it keeps resolving.
    const all = await listCostCenters(true);
    expect(all.map((center) => center.slug)).toContain(slug);
    const active = await listCostCenters(false);
    expect(active.map((center) => center.slug)).not.toContain(slug);
  });
});

describe('cost-centre spend comes from settled receipts', () => {
  it('sums the financial ledger, not telemetry, and attributes to the nearest centre', async () => {
    const organizationId = await seedAccount();
    const projectId = await seedAccount(organizationId);
    await provisionBillingProfile({ accountId: organizationId });
    await recordTopUp({
      idempotencyKey: `fund-${randomUUID()}`,
      accountId: organizationId,
      currency: 'USD',
      amount: '50.000000000000',
    });

    const projectSlug = `spend-${randomUUID().slice(0, 8)}`;
    await registerCostCenter({ accountId: projectId, slug: projectSlug, label: 'Project' });

    const app = await seedApplication(projectId);
    const priceVersionId = await seedPriceVersion();
    const settledAt = new Date();

    const settlement = await settle({
      idempotencyKey: `settle-${randomUUID()}`,
      attribution: {
        accountId: projectId,
        applicationId: app.applicationId,
        applicationCredentialId: app.credentialId,
        requestId: `req-${randomUUID()}`,
        environment: 'production',
      },
      outcome: 'completed',
      usageSource: 'provider_reported',
      units: { input_tokens: 1_000_000 },
      resolvedModelReference: 'oxy/ent',
      servingProvider: 'oxy-hosted',
      priceVersionId,
      settledAt,
    });
    expect(settlement.status).toBe('settled');

    const spend = await costCenterSpend({
      periodStart: new Date(settledAt.getTime() - 60_000),
      periodEnd: new Date(settledAt.getTime() + 60_000),
      currency: 'USD',
    });

    const mine = spend.find((entry) => entry.costCenter.slug === projectSlug);
    expect(mine).toBeDefined();
    expect(Number(mine?.billedAmount)).toBe(3);
    expect(mine?.requestCount).toBe(1);
    // `count(*)` is a bigint that postgres.js decodes as a string; a serializer
    // that forwarded it unconverted would put a string in a number field and
    // every arithmetic on it downstream would concatenate.
    expect(typeof mine?.requestCount).toBe('number');
  });
});
