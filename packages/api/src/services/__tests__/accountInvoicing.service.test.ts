/**
 * Invoicing an account billed in arrears, against a REAL Postgres.
 *
 * The property this file holds is that ROUNDING CONSERVES VALUE. Per-request
 * amounts carry sub-cent precision by design, so the invoice boundary is where
 * that precision meets a currency — and the difference between the exact
 * subtotal and the rounded total is booked as an `invoice_rounding` ledger entry
 * rather than discarded. A discarded remainder is money that exists in one
 * system and not the other, and the next reconciliation pass would report it
 * with nobody able to explain it.
 *
 * The second property is that a PREPAID account is refused. Its charges were
 * settled from its own money at request time; an invoice for one would be a
 * statement, and a statement that booked a rounding entry would move money that
 * has already been paid.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountBalances } from '../../db/schema/accountBalances';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { billingInvoiceReceipts } from '../../db/schema/billingInvoices';
import { billingLedgerEntries } from '../../db/schema/billingLedgerEntries';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { users } from '../../db/schema/users';
import { closeInvoicePeriod, recordInvoicePayment } from '../accountInvoicing.service';
import { provisionBillingProfile, settle } from '../inferenceLedger.service';

jest.setTimeout(60_000);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

interface Fixture {
  readonly accountId: string;
  readonly applicationId: string;
  readonly credentialId: string;
  readonly priceVersionId: string;
}

/** $3 per million input tokens — one token costs 0.000003, well below a cent. */
async function seedFixture(billingMode: 'prepaid' | 'invoiced'): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const [account] = await getDb()
    .insert(users)
    .values({ username: `inv-${suffix}`, email: `inv-${suffix}@example.test` })
    .returning({ id: users.id });

  await provisionBillingProfile({
    accountId: account.id,
    billingMode,
    creditLimit: billingMode === 'invoiced' ? '100.000000000000' : '0',
  });

  const [application] = await getDb()
    .insert(applications)
    .values({ name: `Inv ${suffix}`, ownerAccountId: account.id })
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
      modelReference: `oxy/inv-${suffix}`,
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
    accountId: account.id,
    applicationId: application.id,
    credentialId: credential.id,
    priceVersionId: version.id,
  };
}

async function settleTokens(fixture: Fixture, inputTokens: number, settledAt: Date): Promise<void> {
  const result = await settle({
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
    units: { input_tokens: inputTokens },
    resolvedModelReference: 'oxy/inv',
    servingProvider: 'oxy-hosted',
    priceVersionId: fixture.priceVersionId,
    settledAt,
  });
  expect(result.status).toBe('settled');
}

async function outstandingOf(accountId: string): Promise<number> {
  const [row] = await getDb()
    .select({ outstanding: accountBalances.invoicedOutstanding })
    .from(accountBalances)
    .where(and(eq(accountBalances.accountId, accountId), eq(accountBalances.currency, 'USD')))
    .limit(1);
  return Number(row.outstanding);
}

describe('closing a period', () => {
  it('keeps the exact subtotal and books the rounding it applied', async () => {
    const fixture = await seedFixture('invoiced');
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    const periodEnd = new Date(Date.now() + 60 * 60 * 1000);

    // 1_234_567 tokens at $3/M = 3.703701 exactly — six decimal places, three of
    // them below a cent. Rounding this per REQUEST is what the ledger's scale
    // exists to avoid; rounding it here is the one place it is correct.
    await settleTokens(fixture, 1_234_567, new Date());

    const result = await closeInvoicePeriod({
      accountId: fixture.accountId,
      currency: 'USD',
      periodStart,
      periodEnd,
    });
    expect(result.status).toBe('issued');
    if (result.status !== 'issued') return;

    expect(Number(result.invoice.subtotalAmount)).toBeCloseTo(3.703701, 9);
    expect(Number(result.invoice.totalAmount)).toBe(3.7);
    expect(result.invoice.minorUnitExponent).toBe(2);
    expect(result.invoice.status).toBe('open');
    expect(result.invoice.receiptCount).toBe(1);

    // The remainder is BOOKED, not discarded.
    const rounding = await getDb()
      .select({ id: billingLedgerEntries.id })
      .from(billingLedgerEntries)
      .where(
        and(
          eq(billingLedgerEntries.invoiceId, result.invoice.id),
          eq(billingLedgerEntries.kind, 'invoice_rounding')
        )
      );
    expect(rounding).toHaveLength(1);

    // Rounded DOWN, so the account owes less than the exact sum by the remainder.
    expect(await outstandingOf(fixture.accountId)).toBeCloseTo(3.7, 6);
  });

  it('links every receipt exactly once and refuses a second close', async () => {
    const fixture = await seedFixture('invoiced');
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    const periodEnd = new Date(Date.now() + 60 * 60 * 1000);

    await settleTokens(fixture, 1_000_000, new Date());
    await settleTokens(fixture, 2_000_000, new Date());

    const first = await closeInvoicePeriod({
      accountId: fixture.accountId,
      currency: 'USD',
      periodStart,
      periodEnd,
    });
    expect(first.status).toBe('issued');
    if (first.status !== 'issued') return;
    expect(Number(first.invoice.subtotalAmount)).toBe(9);
    expect(first.invoice.receiptCount).toBe(2);

    const links = await getDb()
      .select({ receiptId: billingInvoiceReceipts.receiptId })
      .from(billingInvoiceReceipts)
      .where(eq(billingInvoiceReceipts.invoiceId, first.invoice.id));
    expect(links).toHaveLength(2);

    // Billing the same settled charge on two invoices is what the receipt-keyed
    // link makes unrepresentable; the second close finds the invoice instead.
    const second = await closeInvoicePeriod({
      accountId: fixture.accountId,
      currency: 'USD',
      periodStart,
      periodEnd,
    });
    expect(second.status).toBe('already-issued');
  });

  it('refuses a prepaid account by name', async () => {
    const fixture = await seedFixture('prepaid');
    await expect(
      closeInvoicePeriod({
        accountId: fixture.accountId,
        currency: 'USD',
        periodStart: new Date(Date.now() - 60 * 60 * 1000),
        periodEnd: new Date(Date.now() + 60 * 60 * 1000),
      })
    ).resolves.toMatchObject({ status: 'not-invoiced' });
  });

  it('reports an empty period rather than issuing a zero invoice', async () => {
    const fixture = await seedFixture('invoiced');
    await expect(
      closeInvoicePeriod({
        accountId: fixture.accountId,
        currency: 'USD',
        periodStart: new Date(Date.now() - 120 * 60 * 1000),
        periodEnd: new Date(Date.now() - 60 * 60 * 1000),
      })
    ).resolves.toMatchObject({ status: 'nothing-to-invoice' });
  });
});

describe('recording a payment', () => {
  it('reduces what the account owes and is idempotent', async () => {
    const fixture = await seedFixture('invoiced');
    await settleTokens(fixture, 1_000_000, new Date());

    const closed = await closeInvoicePeriod({
      accountId: fixture.accountId,
      currency: 'USD',
      periodStart: new Date(Date.now() - 60 * 60 * 1000),
      periodEnd: new Date(Date.now() + 60 * 60 * 1000),
    });
    if (closed.status !== 'issued') throw new Error('expected an issued invoice');
    expect(await outstandingOf(fixture.accountId)).toBeCloseTo(3, 6);

    const externalRef = `in_${randomUUID().replace(/-/g, '')}`;
    const paid = await recordInvoicePayment({
      invoiceId: closed.invoice.id,
      amount: closed.invoice.totalAmount,
      externalRef,
    });
    expect(paid.status).toBe('recorded');
    expect(await outstandingOf(fixture.accountId)).toBe(0);

    // A redelivered processor event composes the same journal key and writes
    // nothing; the invoice is already `paid`.
    const replay = await recordInvoicePayment({
      invoiceId: closed.invoice.id,
      amount: closed.invoice.totalAmount,
      externalRef,
    });
    expect(replay.status).toBe('already-recorded');
    expect(await outstandingOf(fixture.accountId)).toBe(0);
  });

  it('refuses an unknown invoice', async () => {
    await expect(
      recordInvoicePayment({
        invoiceId: `missing-${randomUUID()}`,
        amount: '1.000000000000',
        externalRef: `in_${randomUUID()}`,
      })
    ).resolves.toMatchObject({ status: 'unknown-invoice' });
  });
});
