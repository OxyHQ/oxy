/**
 * The customer-facing billing audit read, against a REAL Postgres.
 *
 * The claim that carries the whole endpoint is that **the amount is derived by
 * one kind-independent rule and can never count a posting twice**, so most of
 * this file exists to make the wrong answers produce a red rather than to
 * confirm the right one.
 *
 * Four groups, and each names what it would report if the thing it measures were
 * absent:
 *
 *  1. **The partition gates.** The four included kinds plus the five excluded
 *     ones must equal `LEDGER_ENTRY_KINDS` exactly, and the four customer
 *     accounts plus the three counterparties must equal `LEDGER_ACCOUNTS`
 *     exactly. Neither is derived from the other — a derived list would make the
 *     assertion true by construction, which is the failure it exists to catch.
 *     Without them a tenth entry kind is silently withheld from every customer,
 *     and an eighth ledger account is silently treated as a counterparty, which
 *     turns an internal move into a customer-facing change. Neither has any
 *     functional symptom at all.
 *  2. **The amount, against the REAL writers.** `recordTopUp`,
 *     `recordPromotionalGrant`, `reverseReceipt` and `recordInvoicePayment` each
 *     write their own entry, and the read must return the amount the writer was
 *     handed. Fixtures that hand-build postings would only test the fixture's
 *     idea of what a writer does.
 *  3. **Multi-posting, twice over.** A real two-posting reversal, where picking
 *     one posting gives the wrong answer; and a hand-built entry mixing a
 *     boundary posting with an internal one, where SUMMING gives the wrong
 *     answer. Both carry a positive control stating the wrong answer's value, so
 *     "the test passed" cannot mean "the fixture was too simple to tell".
 *  4. **What is withheld.** The five internal kinds, another account's entries,
 *     and the staff actor's user id — the last asserted over the whole
 *     serialised entry rather than field by field, so a future field cannot
 *     reintroduce it.
 *
 * Every fixture owns its identifiers and every account is fresh, so a sibling
 * suite seeding this shared database cannot change an answer here.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { exactDecimalSchema } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { billingInvoices } from '../../db/schema/billingInvoices';
import {
  LEDGER_ACCOUNTS,
  LEDGER_ENTRY_KINDS,
  billingLedgerPostings,
  type LedgerAccount,
} from '../../db/schema/billingLedgerEntries';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { users } from '../../db/schema/users';
import {
  provisionBillingProfile,
  recordPromotionalGrant,
  recordTopUp,
  reserve,
  reverseReceipt,
  settle,
  type LedgerAttribution,
} from '../inferenceLedger.service';
import { recordInvoicePayment } from '../accountInvoicing.service';
import {
  COUNTERPARTY_LEDGER_ACCOUNTS,
  CUSTOMER_FACING_LEDGER_KINDS,
  CUSTOMER_LEDGER_ACCOUNTS,
  INTERNAL_LEDGER_KINDS,
  decodeBillingAuditCursor,
  encodeBillingAuditCursor,
  listAccountBillingAudit,
} from '../accountBillingAudit.service';

jest.setTimeout(60_000);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

interface Fixture {
  readonly accountId: string;
  /** A platform staff member, distinct from the account, for authored entries. */
  readonly staffUserId: string;
  readonly applicationId: string;
  readonly priceVersionId: string;
  readonly attribution: LedgerAttribution;
}

/** $3 per million input tokens, so one settled request costs a round number. */
async function insertPriceVersion(): Promise<string> {
  const [version] = await getDb()
    .insert(priceVersions)
    .values({
      modelReference: `oxy/bau-${randomUUID().slice(0, 8)}`,
      provider: 'oxy-hosted',
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });

  await getDb()
    .insert(priceVersionUnitPrices)
    .values([
      {
        priceVersionId: version.id,
        unit: 'input_tokens',
        amount: '3.000000000000',
        per: 1_000_000,
      },
    ]);
  return version.id;
}

async function makeFixture(
  options: { fund?: string; promotional?: string; billingMode?: 'prepaid' | 'invoiced' } = {}
): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const [account] = await getDb()
    .insert(users)
    .values({ username: `bau-${tag}`, email: `bau-${tag}@example.test` })
    .returning({ id: users.id });

  const [staff] = await getDb()
    .insert(users)
    .values({
      username: `bau-staff-${tag}`,
      email: `bau-staff-${tag}@example.test`,
      isStaff: true,
    })
    .returning({ id: users.id });

  const [application] = await getDb()
    .insert(applications)
    .values({ name: `Bau ${tag}`, ownerAccountId: account.id })
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

  await provisionBillingProfile({
    accountId: account.id,
    billingMode: options.billingMode ?? 'prepaid',
    creditLimit: options.billingMode === 'invoiced' ? '100.000000000000' : '0',
  });

  // Promotional FIRST, because `RESERVATION_DRAW_ORDER` spends it first and the
  // multi-posting reversal below depends on a hold that spans both buckets.
  if (options.promotional !== undefined) {
    await recordPromotionalGrant({
      idempotencyKey: `grant-${randomUUID()}`,
      accountId: account.id,
      currency: 'USD',
      amount: options.promotional,
      actor: { kind: 'staff', userId: staff.id },
    });
  }
  if (options.fund !== undefined) {
    await recordTopUp({
      idempotencyKey: `fund-${randomUUID()}`,
      accountId: account.id,
      currency: 'USD',
      amount: options.fund,
      actor: { kind: 'machine' },
    });
  }

  return {
    accountId: account.id,
    staffUserId: staff.id,
    applicationId: application.id,
    priceVersionId: await insertPriceVersion(),
    attribution: {
      accountId: account.id,
      applicationId: application.id,
      applicationCredentialId: credential.id,
      requestId: `req-${randomUUID()}`,
      environment: 'production',
    },
  };
}

/** Compare two exact decimal strings NUMERICALLY — `3.0` and `3.000` are one amount. */
async function expectAmount(actual: string, expected: string): Promise<void> {
  const rows = await getDb().execute<{ equal: boolean }>(
    sql`select (${actual}::numeric = ${expected}::numeric) as equal`
  );
  expect({ actual, expected, equal: rows[0].equal }).toEqual({ actual, expected, equal: true });
}

/**
 * Write a ledger entry and its postings by hand.
 *
 * `top_up` is the kind throughout, and not for convenience: it and
 * `promotional_grant` are the only two included kinds the `subject_check`
 * constraint lets stand alone (the other two must name a receipt or an invoice).
 * That the kind is `top_up` while some of these fixtures move value the way a
 * charge does is the POINT of them — the rule under test never reads `kind`, and
 * a fixture whose kind and postings disagree is what proves it.
 *
 * The id is minted here because `generatedId()` is applied by drizzle, not by a
 * column default, so a raw insert must supply one.
 */
async function insertRawEntry(options: {
  accountId: string;
  postings: ReadonlyArray<{ source: LedgerAccount; destination: LedgerAccount; amount: string }>;
  actorKind?: 'staff' | 'machine' | null;
  actorUserId?: string | null;
  createdAt?: string;
}): Promise<string> {
  const id = uuidv7();
  const createdAt =
    options.createdAt === undefined
      ? sql`date_trunc('milliseconds', now())`
      : sql`${options.createdAt}::timestamptz`;
  await getDb().execute(sql`
    insert into billing_ledger_entries
      (id, idempotency_key, account_id, currency, kind, actor_kind, actor_user_id, created_at)
    values (
      ${id},
      ${`raw-${randomUUID()}`},
      ${options.accountId},
      'USD',
      'top_up',
      ${options.actorKind ?? null},
      ${options.actorUserId ?? null},
      ${createdAt}
    )
  `);
  if (options.postings.length > 0) {
    await getDb()
      .insert(billingLedgerPostings)
      .values(
        options.postings.map((posting, sequence) => ({
          entryId: id,
          sequence,
          sourceAccount: posting.source,
          destinationAccount: posting.destination,
          amount: posting.amount,
        }))
      );
  }
  return id;
}

/** The raw postings of one entry — the positive control for every amount claim. */
async function postingsOf(entryId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ amount: billingLedgerPostings.amount })
    .from(billingLedgerPostings)
    .where(sql`${billingLedgerPostings.entryId} = ${entryId}`)
    .orderBy(billingLedgerPostings.sequence);
  return rows.map((row) => row.amount);
}

/* -------------------------------------------------------------------------- */
/*  1. The two partitions                                                      */
/* -------------------------------------------------------------------------- */

describe('the included and excluded sets partition what the schema declares', () => {
  it('accounts for every entry kind exactly once', () => {
    const declared = [...LEDGER_ENTRY_KINDS].sort();
    const covered = [...CUSTOMER_FACING_LEDGER_KINDS, ...INTERNAL_LEDGER_KINDS].sort();

    // Set equality in BOTH directions. A tenth kind added to the schema and to
    // neither list fails here, which is the only place it can fail: a kind
    // nobody mentions is simply absent from every customer's trail, forever,
    // with no error anywhere.
    expect(covered).toEqual(declared);
    // Stated separately, because two lists can cover the whole set and still
    // overlap — and an overlapping kind would be both published and withheld.
    expect(new Set(covered).size).toBe(LEDGER_ENTRY_KINDS.length);
    expect(CUSTOMER_FACING_LEDGER_KINDS).toHaveLength(4);
    expect(INTERNAL_LEDGER_KINDS).toHaveLength(5);
  });

  it('accounts for every ledger account exactly once, on one side of the boundary', () => {
    const declared = [...LEDGER_ACCOUNTS].sort();
    const covered = [...CUSTOMER_LEDGER_ACCOUNTS, ...COUNTERPARTY_LEDGER_ACCOUNTS].sort();

    // This is the gate with no functional symptom. An eighth ledger account
    // missing from both lists is treated as a COUNTERPARTY by the `else` branch
    // of the amount rule, so a move between two of the customer's own buckets
    // starts reading as money arriving or leaving — a wrong number on a customer
    // page, with nothing logged and nothing thrown.
    expect(covered).toEqual(declared);
    expect(new Set(covered).size).toBe(LEDGER_ACCOUNTS.length);
    expect(CUSTOMER_LEDGER_ACCOUNTS).toHaveLength(4);
    expect(COUNTERPARTY_LEDGER_ACCOUNTS).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. The amount rule, against the real writers                               */
/* -------------------------------------------------------------------------- */

describe('the amount is the one the writer was handed, for every included kind', () => {
  it('reports a top-up and a promotional grant with their own actor kinds', async () => {
    const f = await makeFixture({ fund: '50.000000000000', promotional: '5.000000000000' });

    const page = await listAccountBillingAudit(f.accountId, { limit: 50 });
    const byKind = new Map(page.entries.map((entry) => [entry.kind, entry]));

    const topUp = byKind.get('top_up');
    expect(topUp).toBeDefined();
    if (topUp === undefined) throw new Error('unreachable');
    await expectAmount(topUp.amount, '50.000000000000');
    expect(topUp.direction).toBe('in');
    // A processor webhook: no person authored it, and that is a POSITIVE fact
    // rather than a missing one.
    expect(topUp.actorKind).toBe('machine');
    expect(topUp.currency).toBe('USD');

    const grant = byKind.get('promotional_grant');
    expect(grant).toBeDefined();
    if (grant === undefined) throw new Error('unreachable');
    await expectAmount(grant.amount, '5.000000000000');
    expect(grant.direction).toBe('in');
    // The kind a customer auditing a surprise credit actually needs: a human at
    // Oxy did this, not an automated process.
    expect(grant.actorKind).toBe('staff');

    // Neither entry references a document in this database, and saying so is a
    // true statement about the entry rather than a gap: a top-up's processor
    // reference lives on `billing_external_payments`, which points AT the entry.
    expect([topUp.receiptId, topUp.refundId, topUp.invoiceId]).toEqual([null, null, null]);

    // Every amount on the wire satisfies the PUBLISHED contract, not just this
    // suite's idea of one. `exactDecimalSchema` refuses a leading `-`, an
    // exponent form and more than twelve fractional digits — the three shapes a
    // careless `::text` or a JS `Number` round-trip would produce, and none of
    // which a numeric comparison would notice.
    for (const entry of page.entries) {
      expect(exactDecimalSchema.safeParse(entry.amount).success).toBe(true);
    }
  });

  it('reports an invoice payment as value arriving, because it reduces what is owed', async () => {
    const f = await makeFixture({ billingMode: 'invoiced' });
    const [invoice] = await getDb()
      .insert(billingInvoices)
      .values({
        accountId: f.accountId,
        currency: 'USD',
        periodStart: new Date('2026-07-01T00:00:00.000Z'),
        periodEnd: new Date('2026-08-01T00:00:00.000Z'),
        status: 'open',
        subtotalAmount: '12.000000000000',
        totalAmount: '12.000000000000',
        issuedAt: new Date('2026-08-01T00:00:00.000Z'),
      })
      .returning({ id: billingInvoices.id });

    const paid = await recordInvoicePayment({
      invoiceId: invoice.id,
      amount: '12.000000000000',
      externalRef: `in_${randomUUID().slice(0, 12)}`,
      actor: { kind: 'machine' },
    });
    expect(paid.status).toBe('recorded');

    const page = await listAccountBillingAudit(f.accountId, { limit: 50 });
    const payment = page.entries.find((entry) => entry.kind === 'invoice_payment');
    expect(payment).toBeDefined();
    if (payment === undefined) throw new Error('unreachable');

    await expectAmount(payment.amount, '12.000000000000');
    // `in` from the customer's OXY books: the posting is
    // `external_settlement -> invoice_receivable`, so `invoiced_outstanding`
    // comes down and the customer owes less. It is money leaving their BANK, and
    // the header says why one consistent rule beats matching that intuition for
    // one kind and breaking it for `top_up`.
    expect(payment.direction).toBe('in');
    expect(payment.invoiceId).toBe(invoice.id);
    expect(payment.receiptId).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Multi-posting: one amount, and the two wrong answers                    */
/* -------------------------------------------------------------------------- */

describe('an entry with several postings yields exactly one amount', () => {
  it('sums a real reversal that returns money to two different buckets', async () => {
    // The hold spans both buckets: $1 promotional (spent first) and $4
    // purchased. Settling $3 consumes all $1 of the grant and $2 of the
    // purchased funds, so reversing it in full writes TWO postings.
    const f = await makeFixture({ promotional: '1.000000000000', fund: '10.000000000000' });
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '5.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error('reserve failed');

    const settled = await settle({
      idempotencyKey: `s-${randomUUID()}`,
      reservationId: reserved.reservation.reservationId,
      attribution: f.attribution,
      outcome: 'completed',
      usageSource: 'provider_reported',
      units: { input_tokens: 1_000_000 },
      resolvedModelReference: 'oxy/test',
      servingProvider: 'oxy-hosted',
      priceVersionId: f.priceVersionId,
    });
    if (settled.status !== 'settled') throw new Error('settle failed');

    const reversal = await reverseReceipt({
      idempotencyKey: `rev-${randomUUID()}`,
      receiptId: settled.receipt.receiptId,
      reason: 'billing_correction',
      actor: { kind: 'staff', userId: f.staffUserId },
    });
    expect(reversal.status).toBe('reversed');

    const page = await listAccountBillingAudit(f.accountId, { limit: 50 });
    const reversals = page.entries.filter((entry) => entry.kind === 'settlement_reversal');

    // ONE entry, ONE amount — not one row per posting.
    expect(reversals).toHaveLength(1);
    await expectAmount(reversals[0].amount, '3.000000000000');
    expect(reversals[0].direction).toBe('in');
    expect(reversals[0].actorKind).toBe('staff');
    expect(reversals[0].receiptId).toBe(settled.receipt.receiptId);
    expect(reversals[0].refundId).not.toBeNull();

    // POSITIVE CONTROL, and the mutation this fixture exists for: the entry
    // really does carry two postings, and NEITHER of them is the answer. A read
    // that picked one posting — the first, the largest, the one matching the
    // kind's usual destination — would return 1 or 2 here and pass every
    // single-posting test in this file.
    const postings = await postingsOf(
      (
        await getDb().execute<{ id: string }>(sql`
          select e.id from billing_ledger_entries e
          where e.account_id = ${f.accountId} and e.kind = 'settlement_reversal'
        `)
      )[0].id
    );
    expect(postings).toHaveLength(2);
    await expectAmount(postings[0], '1.000000000000');
    await expectAmount(postings[1], '2.000000000000');
  });

  it('counts only the postings that cross into the customer’s own accounts', async () => {
    const f = await makeFixture();

    // A boundary posting beside a purely INTERNAL one. No writer produces this
    // shape today — every posting the four included kinds write crosses the
    // boundary in the same direction, so summing them all happens to be right.
    // It is not a hypothetical shape: `reservation_hold` and
    // `reservation_release` write exactly this internal move, under kinds this
    // read excludes. The rule must be right for what the SCHEMA permits, not for
    // what today's four writers happen to emit, because the day that changes is
    // the day the sum starts double-counting silently.
    const entryId = await insertRawEntry({
      accountId: f.accountId,
      actorKind: 'machine',
      postings: [
        { source: 'external_settlement', destination: 'purchased_funds', amount: '7.000000000000' },
        { source: 'promotional_funds', destination: 'purchased_funds', amount: '4.000000000000' },
      ],
    });

    const page = await listAccountBillingAudit(f.accountId, { limit: 50 });
    expect(page.entries).toHaveLength(1);
    await expectAmount(page.entries[0].amount, '7.000000000000');
    expect(page.entries[0].direction).toBe('in');

    // POSITIVE CONTROL: the postings DO sum to something else. Replace the
    // boundary `case` with `sum(p.amount)` and this line is what goes red —
    // without it the assertion above is satisfied by a fixture too simple to
    // distinguish the two.
    const postings = await postingsOf(entryId);
    expect(postings).toHaveLength(2);
    const [total] = await getDb().execute<{ total: string }>(
      sql`select sum(p.amount)::text as total from billing_ledger_postings p where p.entry_id = ${entryId}`
    );
    await expectAmount(total.total, '11.000000000000');
  });

  it('reports an entry whose postings are all internal as moving nothing', async () => {
    const f = await makeFixture();
    // Both sides the customer's own — the shape a hold, a release and an expiry
    // all have, which is the numeric restatement of why those three kinds are
    // excluded: they are not changes.
    await insertRawEntry({
      accountId: f.accountId,
      actorKind: 'machine',
      postings: [
        { source: 'promotional_funds', destination: 'reserved_funds', amount: '9.000000000000' },
      ],
    });

    const page = await listAccountBillingAudit(f.accountId, { limit: 50 });
    expect(page.entries).toHaveLength(1);
    await expectAmount(page.entries[0].amount, '0');
    // Not `in` with an amount of zero: nothing took a direction.
    expect(page.entries[0].direction).toBe('none');
  });

  it('reports an entry with no postings at all as moving nothing', async () => {
    const f = await makeFixture();
    // Reachable: `writeEntry` filters out a zero-amount posting, so an entry can
    // legitimately end up with none. The `sum` over no rows is NULL, and an
    // uncoalesced NULL would reach the wire as an amount of `null`.
    await insertRawEntry({ accountId: f.accountId, actorKind: 'machine', postings: [] });

    const page = await listAccountBillingAudit(f.accountId, { limit: 50 });
    expect(page.entries).toHaveLength(1);
    await expectAmount(page.entries[0].amount, '0');
    expect(page.entries[0].direction).toBe('none');
  });

  it('reports value LEAVING the customer’s accounts as out, whatever the kind says', async () => {
    const f = await makeFixture();
    // The positive control for `direction` itself. Every kind this endpoint
    // publishes is `in` today, so without a reachable `out` the field could be
    // the constant string `'in'` and every other test in this file would pass.
    //
    // The entry's kind is `top_up` while its posting moves money the way a
    // settlement does. That contradiction is deliberate: the rule reads the
    // POSTINGS and never the kind, and a fixture whose two disagree is the only
    // one that can show it.
    await insertRawEntry({
      accountId: f.accountId,
      actorKind: 'machine',
      postings: [
        { source: 'purchased_funds', destination: 'platform_revenue', amount: '2.500000000000' },
      ],
    });

    const page = await listAccountBillingAudit(f.accountId, { limit: 50 });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].direction).toBe('out');
    // Non-negative on the wire even when the direction is out — the ledger's own
    // rule, and `exactDecimalSchema` refuses a leading `-` by regex.
    await expectAmount(page.entries[0].amount, '2.500000000000');
    expect(exactDecimalSchema.safeParse(page.entries[0].amount).success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. What is withheld                                                        */
/* -------------------------------------------------------------------------- */

describe('the trail withholds the mechanics of usage, and another account’s money', () => {
  it('serves the four customer-facing kinds and none of the five internal ones', async () => {
    const f = await makeFixture({ promotional: '1.000000000000', fund: '10.000000000000' });
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '5.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error('reserve failed');
    // One request produces a hold, a settlement and a release — three of the
    // five excluded kinds, all written by the real path.
    const settled = await settle({
      idempotencyKey: `s-${randomUUID()}`,
      reservationId: reserved.reservation.reservationId,
      attribution: f.attribution,
      outcome: 'completed',
      usageSource: 'provider_reported',
      units: { input_tokens: 1_000_000 },
      resolvedModelReference: 'oxy/test',
      servingProvider: 'oxy-hosted',
      priceVersionId: f.priceVersionId,
    });
    if (settled.status !== 'settled') throw new Error('settle failed');

    // POSITIVE CONTROL: the journal really does hold those kinds for this
    // account, so "none of them came back" is a statement about the read rather
    // than about an empty table.
    const written = await getDb().execute<{ kind: string }>(sql`
      select distinct e.kind from billing_ledger_entries e where e.account_id = ${f.accountId}
    `);
    const writtenKinds = written.map((row) => row.kind).sort();
    expect(writtenKinds).toContain('reservation_hold');
    expect(writtenKinds).toContain('settlement');
    expect(writtenKinds).toContain('reservation_release');

    const page = await listAccountBillingAudit(f.accountId, { limit: 50 });
    const served = page.entries.map((entry) => entry.kind).sort();
    // Exactly the funding pair the fixture created, and nothing from the request.
    expect(served).toEqual(['promotional_grant', 'top_up']);
    for (const kind of INTERNAL_LEDGER_KINDS) {
      expect(served).not.toContain(kind);
    }
  });

  it('withholds another account’s entries while serving its own', async () => {
    const mine = await makeFixture({ fund: '4.000000000000' });
    const theirs = await makeFixture({ fund: '99.000000000000' });

    const page = await listAccountBillingAudit(mine.accountId, { limit: 50 });

    // POSITIVE CONTROL first: without it, a query matching nothing would satisfy
    // the exclusion below.
    expect(page.entries).toHaveLength(1);
    await expectAmount(page.entries[0].amount, '4.000000000000');

    const theirPage = await listAccountBillingAudit(theirs.accountId, { limit: 50 });
    expect(theirPage.entries).toHaveLength(1);
    await expectAmount(theirPage.entries[0].amount, '99.000000000000');
    // The ids do not cross either — a scoping bug that returned both would still
    // pass an amount check on the first row.
    expect(page.entries[0].id).not.toBe(theirPage.entries[0].id);
  });

  it('never publishes the staff member behind a grant, in any field', async () => {
    const f = await makeFixture({ promotional: '2.000000000000' });

    const page = await listAccountBillingAudit(f.accountId, { limit: 50 });
    const grant = page.entries.find((entry) => entry.kind === 'promotional_grant');
    expect(grant).toBeDefined();
    if (grant === undefined) throw new Error('unreachable');

    // POSITIVE CONTROL: the id really is on the row, so its absence below is the
    // projection's doing.
    const [stored] = await getDb().execute<{ actorUserId: string | null }>(sql`
      select e.actor_user_id as "actorUserId" from billing_ledger_entries e
      where e.account_id = ${f.accountId} and e.kind = 'promotional_grant'
    `);
    expect(stored.actorUserId).toBe(f.staffUserId);

    // Asserted over the WHOLE serialised entry rather than field by field: a
    // future field carrying the id would slip past a per-field check.
    expect(JSON.stringify(grant)).not.toContain(f.staffUserId);
    expect(grant.actorKind).toBe('staff');
  });

  it('reports an entry written before the actor columns as unknown, not machine', async () => {
    const f = await makeFixture();
    // `(null, null)` is the grandfather state migration 0046 left behind, and it
    // means "we did not record who did this" — which is exactly the reading
    // `machine` ("no person did this") exists to be distinguished from.
    await insertRawEntry({
      accountId: f.accountId,
      actorKind: null,
      postings: [
        { source: 'external_settlement', destination: 'purchased_funds', amount: '1.000000000000' },
      ],
    });

    const page = await listAccountBillingAudit(f.accountId, { limit: 50 });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].actorKind).toBe('unknown');
  });
});

/* -------------------------------------------------------------------------- */
/*  5. Ordering and the cursor                                                 */
/* -------------------------------------------------------------------------- */

describe('the cursor pages a tie without skipping or repeating a row', () => {
  it('walks entries that share an instant, one page at a time', async () => {
    const f = await makeFixture();
    const tie = '2026-08-18T11:00:00.000Z';
    // FOUR entries, THREE of them at the same instant. `created_at` alone is not
    // a total order — `settle` writes two entries in one transaction sharing
    // `now()`, and uuid v7 is not monotone within a millisecond — so a cursor
    // keyed on the timestamp alone drops the tied rows behind the first.
    //
    // Three tied rows rather than two, deliberately: a tie group LARGER than the
    // page is what makes the sort direction observable. With two, a page of one
    // fetches both tied rows into the same window, and a mutation reversing the
    // key's second component reorders inside that window without losing anything.
    // At three the group straddles the boundary and the wrong direction strands
    // a row permanently — measured, as the first version of this test passed
    // against exactly that mutation.
    for (const amount of ['1.000000000000', '2.000000000000', '3.000000000000']) {
      await insertRawEntry({
        accountId: f.accountId,
        actorKind: 'machine',
        createdAt: tie,
        postings: [{ source: 'external_settlement', destination: 'purchased_funds', amount }],
      });
    }
    await insertRawEntry({
      accountId: f.accountId,
      actorKind: 'machine',
      createdAt: '2026-08-18T10:59:59.000Z',
      postings: [
        { source: 'external_settlement', destination: 'purchased_funds', amount: '4.000000000000' },
      ],
    });

    const whole = await listAccountBillingAudit(f.accountId, { limit: 50 });
    expect(whole.entries).toHaveLength(4);
    expect(whole.nextCursor).toBeNull();

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: Awaited<ReturnType<typeof listAccountBillingAudit>> =
        await listAccountBillingAudit(f.accountId, { limit: 1, cursor });
      walked.push(...page.entries.map((entry) => entry.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    expect(walked).toEqual(whole.entries.map((entry) => entry.id));
    // Stated separately, because a walk that repeated a row could still be
    // ordered.
    expect(new Set(walked).size).toBe(4);
  });

  it('does not skip a row whose timestamp carries microseconds', async () => {
    const f = await makeFixture();
    // `created_at`'s DEFAULT truncates to milliseconds, but the COLUMN is a
    // plain `timestamptz` and stores microseconds — so a cursor that round-trips
    // the value through a `Date` would place its bookmark 123µs early and skip
    // the row between. Measured, not assumed: drizzle's query builder returns
    // this exact row as a `Date` whose `toISOString()` is `…000Z`.
    await insertRawEntry({
      accountId: f.accountId,
      actorKind: 'machine',
      createdAt: '2026-08-18T10:00:00.000123Z',
      postings: [
        { source: 'external_settlement', destination: 'purchased_funds', amount: '1.000000000000' },
      ],
    });
    const second = await insertRawEntry({
      accountId: f.accountId,
      actorKind: 'machine',
      createdAt: '2026-08-18T10:00:00.000045Z',
      postings: [
        { source: 'external_settlement', destination: 'purchased_funds', amount: '2.000000000000' },
      ],
    });

    const first = await listAccountBillingAudit(f.accountId, { limit: 1 });
    expect(first.entries).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const next = await listAccountBillingAudit(f.accountId, {
      limit: 50,
      cursor: first.nextCursor,
    });
    // The 45µs row sorts BELOW the 123µs one and must survive the page boundary.
    // A cursor truncated to `10:00:00.000` would exclude it along with its own
    // row, and the page would come back empty.
    expect(next.entries.map((entry) => entry.id)).toEqual([second]);
  });

  it('round-trips a cursor verbatim and refuses one it did not issue', () => {
    const raw = { createdAt: '2026-08-18 10:00:00.000123+00', id: uuidv7() };
    expect(decodeBillingAuditCursor(encodeBillingAuditCursor(raw))).toEqual(raw);

    expect(decodeBillingAuditCursor('not-a-cursor')).toBeNull();
    expect(decodeBillingAuditCursor(Buffer.from('a|b|c').toString('base64url'))).toBeNull();
    expect(
      decodeBillingAuditCursor(Buffer.from('not-a-date|an-id').toString('base64url'))
    ).toBeNull();
    expect(decodeBillingAuditCursor(Buffer.from(`${raw.createdAt}|`).toString('base64url'))).toBeNull();
  });

  it('reads from the start when handed a cursor it refused', async () => {
    const f = await makeFixture({ fund: '6.000000000000' });
    const page = await listAccountBillingAudit(f.accountId, { limit: 50, cursor: 'garbage' });
    // Not an error: a stale bookmark should not become an error page, and a
    // refusal would confirm the format is guessable.
    expect(page.entries).toHaveLength(1);
    await expectAmount(page.entries[0].amount, '6.000000000000');
  });
});
