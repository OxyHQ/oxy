/**
 * The export's financial section carries the CALLER's charges and nobody else's
 * (#972 section 12, "deletion/export behavior that preserves legally required
 * financial records while deleting optional payload data").
 *
 * ## The claim, and the only way it can fail usefully
 *
 * Cross-account isolation is what has to be measured, and "A's export contains
 * none of B's rows" is trivially true of an export that contains nothing at all.
 * So every case below is a PAIR against a real Postgres: A's own receipt, ledger
 * entry and reservation must be present by id, and B's must be absent — from the
 * same bundle, in the same assertion block. Drop the `where` clause on any of the
 * three reads and the absence assertions go red; drop the read entirely and the
 * presence assertions go red.
 *
 * The two accounts are seeded identically and spend identically, so nothing but
 * the `account_id` filter distinguishes them.
 */

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { users } from '../../db/schema/users';
import { buildExportBundle } from '../identityExport.service';
import { provisionBillingProfile, reserve, settle } from '../inferenceLedger.service';

jest.setTimeout(60_000);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

function tag(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

interface Spender {
  readonly accountId: string;
  readonly requestId: string;
  readonly reservationId: string;
  readonly receiptId: string;
}

/**
 * An account that has reserved and settled once, so all three financial tables
 * hold exactly one row naming it.
 *
 * `invoiced` with a credit limit rather than prepaid, so the settle does not have
 * to be funded first — this file is about which rows an export reads, not about
 * how a balance moves.
 */
async function seedSpender(): Promise<Spender> {
  const suffix = tag();
  const [account] = await getDb()
    .insert(users)
    .values({ username: `exp-${suffix}`, email: `exp-${suffix}@example.test` })
    .returning({ id: users.id });

  await provisionBillingProfile({
    accountId: account.id,
    billingMode: 'invoiced',
    creditLimit: '100.000000000000',
  });

  const [application] = await getDb()
    .insert(applications)
    .values({ name: `Export ${suffix}`, ownerAccountId: account.id })
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
      modelReference: `oxy/export-${suffix}`,
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

  const requestId = `req-${randomUUID()}`;
  const attribution = {
    accountId: account.id,
    applicationId: application.id,
    applicationCredentialId: credential.id,
    requestId,
    environment: 'production' as const,
  };

  const held = await reserve({
    idempotencyKey: `exp-reserve-${randomUUID()}`,
    attribution,
    ceilingPriceVersionId: version.id,
    // Comfortably above the 3.000000000000 the settle below bills, or the ledger
    // refuses it as `settlement-exceeds-reservation`.
    maxAmount: '5.000000000000',
    currency: 'USD',
    expiresInSeconds: 300,
  });
  if (held.status !== 'reserved') {
    throw new Error(`the fixture could not reserve: ${held.status}`);
  }

  const settled = await settle({
    idempotencyKey: `exp-settle-${randomUUID()}`,
    attribution,
    reservationId: held.reservation.reservationId,
    outcome: 'completed',
    usageSource: 'provider_reported',
    units: { input_tokens: 1_000_000 },
    resolvedModelReference: `oxy/export-${suffix}`,
    servingProvider: 'oxy-hosted',
    priceVersionId: version.id,
  });
  if (settled.status !== 'settled') {
    throw new Error(`the fixture could not settle: ${settled.status}`);
  }

  return {
    accountId: account.id,
    requestId,
    reservationId: held.reservation.reservationId,
    receiptId: settled.receipt.receiptId,
  };
}

describe('the subject-access export carries the caller’s own financial history', () => {
  it('contains A’s receipt, entry and hold, and none of B’s', async () => {
    const [a, b] = await Promise.all([seedSpender(), seedSpender()]);

    const result = await buildExportBundle(a.accountId);
    expect(result).not.toBeNull();
    if (result === null) throw new Error('unreachable');
    const { financial } = result.bundle;

    // PRESENT: A's own rows, by id. Without these the absence assertions below
    // would be satisfied by an empty section.
    expect(financial.receipts.map((receipt) => receipt.receiptId)).toEqual([a.receiptId]);
    expect(financial.reservations.map((reservation) => reservation.reservationId)).toEqual([
      a.reservationId,
    ]);
    expect(financial.ledgerEntries.length).toBeGreaterThan(0);

    // ABSENT: B's, in the same bundle. Serialized once, so a row hiding in any
    // arm of the section is found by the same pass.
    const serialized = JSON.stringify(financial);
    expect(serialized).not.toContain(b.receiptId);
    expect(serialized).not.toContain(b.reservationId);
    expect(serialized).not.toContain(b.requestId);
    // POSITIVE CONTROL on the search itself: A's request id IS found by it, so an
    // absence above is a real absence rather than an unreadable haystack.
    expect(serialized).toContain(a.requestId);
  });

  it('carries the amount as an exact decimal string, not a number', async () => {
    const a = await seedSpender();

    const result = await buildExportBundle(a.accountId);
    if (result === null) throw new Error('unreachable');
    const receipt = result.bundle.financial.receipts[0];

    expect(typeof receipt.billedAmount).toBe('string');
    // 1,000,000 input tokens at 3.000000000000 per 1,000,000.
    expect(receipt.billedAmount).toBe('3.000000000000');
    expect(receipt.currency).toBe('USD');
    expect(receipt.resolvedModelReference).toEqual(expect.stringContaining('oxy/export-'));
  });

  it('is three empty arrays for an account that has never transacted', async () => {
    const suffix = tag();
    const [account] = await getDb()
      .insert(users)
      .values({ username: `exp-${suffix}`, email: `exp-${suffix}@example.test` })
      .returning({ id: users.id });

    const result = await buildExportBundle(account.id);
    if (result === null) throw new Error('unreachable');
    // Empty, not absent: the section is a required part of the contract, so
    // "nothing was charged" is a statement rather than a missing key.
    expect(result.bundle.financial).toEqual({
      receipts: [],
      ledgerEntries: [],
      reservations: [],
    });
  });
});
