/**
 * The inference ledger's SCHEMA, against a REAL Postgres.
 *
 * One `describe` per decision in the schema files that a comment alone would not
 * keep true: the two self-referencing foreign keys (which this repo has already
 * had silently dropped from a generated migration once), the append-only
 * triggers, the discriminant CHECKs a wrong row could otherwise satisfy, the
 * money column's exact type, and the two hand-maintained maps that would
 * silently stop covering their vocabulary.
 *
 * Every row carries a per-test random identifier, so no assertion depends on a
 * table being empty and a sibling file seeding rows cannot change an answer.
 */

import { randomUUID } from 'node:crypto';
import { eq, getTableColumns, sql } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import { USAGE_UNITS } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { accountBalances } from '../accountBalances';
import {
  billingLedgerEntries,
  billingLedgerPostings,
  LEDGER_ACCOUNTS,
  LEDGER_ACTOR_KINDS,
  RESERVATION_DRAW_ORDER,
} from '../billingLedgerEntries';
import { billingProfiles } from '../billingProfiles';
import { applications } from '../applications';
import { applicationCredentials } from '../applicationCredentials';
import { IMMUTABLE_LEDGER_TABLES } from '../ledgerImmutability';
import {
  USAGE_UNIT_COLUMN_KEYS,
  usageUnitColumns,
  zeroUsageUnits,
} from '../ledgerColumns';
import { priceVersions, priceVersionUnitPrices } from '../priceVersions';
import { usageReceipts } from '../usageReceipts';
import { usageRefunds } from '../usageRefunds';
import { usageReservations } from '../usageReservations';
import { users } from '../users';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `check_violation` — also what the immutability trigger raises. */
const CHECK_VIOLATION = '23514';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/**
 * The SQLSTATE a driver error carries. Drizzle wraps a driver failure in its own
 * `DrizzleQueryError`, so the code lives on the `cause` — walking the chain is
 * what stops every assertion below from degrading into "some error happened".
 */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * The DRIVER's own message, taken from the same link in the cause chain that
 * carries the SQLSTATE — never drizzle's wrapper, whose text is the query.
 *
 * `23514` alone cannot tell the immutability TRIGGER from an ordinary CHECK: the
 * trigger raises that code deliberately, so `isCheckViolation` recognises it.
 * Any test claiming "the trigger refused this" has to read what refused it.
 */
function pgErrorMessage(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return current.message;
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

async function insertAccount(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [row] = await getDb()
    .insert(users)
    .values({ username: `ledger-${suffix}`, email: `ledger-${suffix}@example.test` })
    .returning({ id: users.id });
  return row.id;
}

async function insertApplication(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `Ledger ${randomUUID().slice(0, 8)}`, ownerAccountId })
    .returning({ id: applications.id });
  return row.id;
}

async function insertCredential(applicationId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId,
      name: 'test',
      publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
      type: 'service',
      environment: 'production',
    })
    .returning({ id: applicationCredentials.id });
  return row.id;
}

async function insertPriceVersion(): Promise<string> {
  const [row] = await getDb()
    .insert(priceVersions)
    .values({
      modelReference: `oxy/test-${randomUUID().slice(0, 8)}`,
      provider: 'oxy-hosted',
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });
  return row.id;
}

interface Fixture {
  accountId: string;
  applicationId: string;
  credentialId: string;
  priceVersionId: string;
}

async function fixture(): Promise<Fixture> {
  const accountId = await insertAccount();
  const applicationId = await insertApplication(accountId);
  const credentialId = await insertCredential(applicationId);
  const priceVersionId = await insertPriceVersion();
  await getDb().insert(billingProfiles).values({ accountId });
  await getDb().insert(accountBalances).values({ accountId, currency: 'USD' });
  return { accountId, applicationId, credentialId, priceVersionId };
}

async function insertReservation(f: Fixture, amount = '1.000000000000'): Promise<string> {
  const [row] = await getDb()
    .insert(usageReservations)
    .values({
      idempotencyKey: `res-${randomUUID()}`,
      accountId: f.accountId,
      applicationId: f.applicationId,
      applicationCredentialId: f.credentialId,
      requestId: `req-${randomUUID()}`,
      environment: 'production',
      reservedAmount: amount,
      ceilingPriceVersionId: f.priceVersionId,
      ...zeroUsageUnits(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning({ id: usageReservations.id });
  return row.id;
}

async function insertReceipt(
  f: Fixture,
  overrides: Partial<typeof usageReceipts.$inferInsert> = {}
): Promise<string> {
  const [row] = await getDb()
    .insert(usageReceipts)
    .values({
      idempotencyKey: `rcp-${randomUUID()}`,
      accountId: f.accountId,
      applicationId: f.applicationId,
      applicationCredentialId: f.credentialId,
      requestId: `req-${randomUUID()}`,
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
      ...overrides,
    })
    .returning({ id: usageReceipts.id });
  return row.id;
}

describe('the two self-referencing foreign keys reached pg_constraint', () => {
  // A column-level circular reference has been silently DROPPED from both a
  // generated migration and its snapshot in this repo before, so the
  // declaration proves nothing. These read the catalogue.
  it.each([
    ['price_versions', 'supersedes_price_version_id'],
    ['usage_receipts', 'corrects_receipt_id'],
  ])('%s.%s has a real FOREIGN KEY constraint', async (table, column) => {
    const rows = await getDb().execute(sql`
      select c.conname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
      where c.contype = 'f' and t.relname = ${table} and a.attname = ${column}
    `);
    expect(rows.length).toBe(1);
  });

  it('refuses a supersedes pointer to a price version that does not exist', async () => {
    const error = await rejection(
      getDb()
        .insert(priceVersions)
        .values({
          modelReference: 'oxy/missing',
          provider: 'oxy-hosted',
          effectiveFrom: new Date(),
          supersedesPriceVersionId: `absent-${randomUUID()}`,
        })
    );
    // `23503` foreign_key_violation — the constraint is enforced, not decorative.
    expect(pgErrorCode(error)).toBe('23503');
  });
});

describe('settled history is append-only', () => {
  it.each(IMMUTABLE_LEDGER_TABLES)('%s has its immutability trigger installed', async (table) => {
    const rows = await getDb().execute(sql`
      select t.tgname
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relname = ${table}
    `);
    expect(rows.map((row) => row.tgname)).toContain(`${table}_immutable`);
  });

  it('refuses an UPDATE to a settled receipt', async () => {
    const f = await fixture();
    const receiptId = await insertReceipt(f);
    const error = await rejection(
      getDb()
        .update(usageReceipts)
        .set({ billedAmount: '999.000000000000' })
        .where(eq(usageReceipts.id, receiptId))
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);

    // The wrong answer is not produced either: the row is unchanged.
    const [row] = await getDb()
      .select({ billedAmount: usageReceipts.billedAmount })
      .from(usageReceipts)
      .where(eq(usageReceipts.id, receiptId));
    expect(Number(row.billedAmount)).toBeCloseTo(0.00003, 12);
  });

  it('refuses a DELETE of a settled receipt', async () => {
    const f = await fixture();
    const receiptId = await insertReceipt(f);
    const error = await rejection(
      getDb().delete(usageReceipts).where(eq(usageReceipts.id, receiptId))
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('leaves usage_reservations mutable, because a hold is a lifecycle', async () => {
    const f = await fixture();
    const reservationId = await insertReservation(f);
    await getDb()
      .update(usageReservations)
      .set({ status: 'expired' })
      .where(eq(usageReservations.id, reservationId));
    const [row] = await getDb()
      .select({ status: usageReservations.status })
      .from(usageReservations)
      .where(eq(usageReservations.id, reservationId));
    expect(row.status).toBe('expired');
  });
});

describe('a refund cannot misdescribe what it acts on', () => {
  it('refuses a receipt-kind refund pointing at a reservation', async () => {
    const f = await fixture();
    const reservationId = await insertReservation(f);
    const error = await rejection(
      getDb().insert(usageRefunds).values({
        idempotencyKey: `x-${randomUUID()}`,
        accountId: f.accountId,
        requestId: 'req-1',
        subjectKind: 'receipt',
        reservationId,
        reason: 'billing_correction',
        amount: '1.000000000000',
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses unused_reservation against a receipt', async () => {
    const f = await fixture();
    const receiptId = await insertReceipt(f);
    const error = await rejection(
      getDb().insert(usageRefunds).values({
        idempotencyKey: `x-${randomUUID()}`,
        accountId: f.accountId,
        requestId: 'req-1',
        subjectKind: 'receipt',
        receiptId,
        reason: 'unused_reservation',
        amount: '1.000000000000',
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses billing_correction against a reservation', async () => {
    const f = await fixture();
    const reservationId = await insertReservation(f);
    const error = await rejection(
      getDb().insert(usageRefunds).values({
        idempotencyKey: `x-${randomUUID()}`,
        accountId: f.accountId,
        requestId: 'req-1',
        subjectKind: 'reservation',
        reservationId,
        reason: 'billing_correction',
        amount: '1.000000000000',
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('accepts the two legitimate combinations', async () => {
    const f = await fixture();
    const reservationId = await insertReservation(f);
    const receiptId = await insertReceipt(f);
    await getDb().insert(usageRefunds).values([
      {
        idempotencyKey: `ok-a-${randomUUID()}`,
        accountId: f.accountId,
        requestId: 'req-1',
        subjectKind: 'reservation',
        reservationId,
        reason: 'unused_reservation',
        amount: '1.000000000000',
      },
      {
        idempotencyKey: `ok-b-${randomUUID()}`,
        accountId: f.accountId,
        requestId: 'req-1',
        subjectKind: 'receipt',
        receiptId,
        reason: 'billing_correction',
        amount: '1.000000000000',
      },
    ]);
    const rows = await getDb()
      .select({ id: usageRefunds.id })
      .from(usageRefunds)
      .where(eq(usageRefunds.accountId, f.accountId));
    expect(rows.length).toBe(2);
  });
});

describe('a charge cannot be billed against nothing metered', () => {
  it('refuses a non-zero amount with every unit column at zero', async () => {
    const f = await fixture();
    const error = await rejection(
      insertReceipt(f, { ...zeroUsageUnits(), billedAmount: '5.000000000000' })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('accepts a zero charge with no units — a failed request settles zero', async () => {
    const f = await fixture();
    const receiptId = await insertReceipt(f, {
      ...zeroUsageUnits(),
      billedAmount: '0',
      outcome: 'failed',
    });
    expect(receiptId).toBeTruthy();
  });
});

describe('a posting is a real transfer', () => {
  async function entry(accountId: string): Promise<string> {
    const [row] = await getDb()
      .insert(billingLedgerEntries)
      .values({
        idempotencyKey: `e-${randomUUID()}`,
        accountId,
        kind: 'top_up',
      })
      .returning({ id: billingLedgerEntries.id });
    return row.id;
  }

  it('refuses a posting from an account to itself', async () => {
    const f = await fixture();
    const entryId = await entry(f.accountId);
    const error = await rejection(
      getDb().insert(billingLedgerPostings).values({
        entryId,
        sequence: 0,
        sourceAccount: 'purchased_funds',
        destinationAccount: 'purchased_funds',
        amount: '1.000000000000',
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses a posting of zero', async () => {
    const f = await fixture();
    const entryId = await entry(f.accountId);
    const error = await rejection(
      getDb().insert(billingLedgerPostings).values({
        entryId,
        sequence: 0,
        sourceAccount: 'external_settlement',
        destinationAccount: 'purchased_funds',
        amount: '0',
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses a second entry under one idempotency key', async () => {
    const f = await fixture();
    const key = `dup-${randomUUID()}`;
    await getDb()
      .insert(billingLedgerEntries)
      .values({ idempotencyKey: key, accountId: f.accountId, kind: 'top_up' });
    const error = await rejection(
      getDb()
        .insert(billingLedgerEntries)
        .values({ idempotencyKey: key, accountId: f.accountId, kind: 'top_up' })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('requires a reservation-shaped entry to name its reservation', async () => {
    const f = await fixture();
    const error = await rejection(
      getDb().insert(billingLedgerEntries).values({
        idempotencyKey: `e-${randomUUID()}`,
        accountId: f.accountId,
        kind: 'reservation_hold',
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });
});

describe('an entry says who authored it, or says it predates the question', () => {
  /** Insert one `top_up` entry with an explicit actor pair. */
  async function entryWithActor(
    accountId: string,
    actor: Pick<typeof billingLedgerEntries.$inferInsert, 'actorKind' | 'actorUserId'>
  ): Promise<string> {
    const [row] = await getDb()
      .insert(billingLedgerEntries)
      .values({ idempotencyKey: `a-${randomUUID()}`, accountId, kind: 'top_up', ...actor })
      .returning({ id: billingLedgerEntries.id });
    return row.id;
  }

  async function readActor(
    entryId: string
  ): Promise<{ actorKind: string | null; actorUserId: string | null }> {
    const [row] = await getDb()
      .select({
        actorKind: billingLedgerEntries.actorKind,
        actorUserId: billingLedgerEntries.actorUserId,
      })
      .from(billingLedgerEntries)
      .where(eq(billingLedgerEntries.id, entryId));
    return row;
  }

  it('is exactly two kinds, and nothing here reads a fourth state into the pair', () => {
    // The CHECK enumerates its branches by literal, so a kind added to this
    // tuple and nowhere else is refused by the database rather than stored.
    expect([...LEDGER_ACTOR_KINDS]).toEqual(['staff', 'machine']);
    expect(LEDGER_ACTOR_KINDS).toHaveLength(2);
  });

  it('accepts a staff author who is named, and a machine author who is not', async () => {
    const f = await fixture();
    const staffUserId = await insertAccount();

    const staffEntry = await entryWithActor(f.accountId, {
      actorKind: 'staff',
      actorUserId: staffUserId,
    });
    const machineEntry = await entryWithActor(f.accountId, {
      actorKind: 'machine',
      actorUserId: null,
    });

    expect(await readActor(staffEntry)).toEqual({ actorKind: 'staff', actorUserId: staffUserId });
    expect(await readActor(machineEntry)).toEqual({ actorKind: 'machine', actorUserId: null });
  });

  it('admits the grandfathered pair, and it reads as neither of the two kinds', async () => {
    // What every row written before 0046 carries. It is legal, it is the ONLY
    // legal way to say nothing, and it is a third value — not the machine one.
    const f = await fixture();
    const historical = await entryWithActor(f.accountId, {
      actorKind: null,
      actorUserId: null,
    });
    const machineEntry = await entryWithActor(f.accountId, {
      actorKind: 'machine',
      actorUserId: null,
    });

    const before = await readActor(historical);
    const after = await readActor(machineEntry);
    expect(before.actorKind).toBeNull();
    expect(after.actorKind).toBe('machine');
    expect(before.actorKind).not.toBe(after.actorKind);
  });

  it('refuses a staff author who names nobody', async () => {
    const f = await fixture();
    const error = await rejection(
      entryWithActor(f.accountId, { actorKind: 'staff', actorUserId: null })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses a machine author that names somebody', async () => {
    const f = await fixture();
    const error = await rejection(
      entryWithActor(f.accountId, { actorKind: 'machine', actorUserId: await insertAccount() })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses a named person with no kind beside them', async () => {
    const f = await fixture();
    const error = await rejection(
      entryWithActor(f.accountId, { actorKind: null, actorUserId: await insertAccount() })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses a kind outside the vocabulary', async () => {
    // Raw SQL on purpose: the column's TypeScript enum makes this unwritable
    // through the query builder, which is the point — this asserts the DATABASE
    // refuses it too, for anything arriving by another route.
    const f = await fixture();
    const error = await rejection(
      getDb().execute(sql`
        insert into ${billingLedgerEntries} (id, idempotency_key, account_id, currency, kind, actor_kind)
        values (${randomUUID()}, ${`a-${randomUUID()}`}, ${f.accountId}, 'USD', 'top_up', 'robot')
      `)
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('has a real FOREIGN KEY from actor_user_id to users', async () => {
    const rows = await getDb().execute(sql`
      select c.conname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
      where c.contype = 'f'
        and t.relname = 'billing_ledger_entries'
        and a.attname = 'actor_user_id'
    `);
    expect(rows.length).toBe(1);
  });

  it('refuses an author who is not an account at all', async () => {
    const f = await fixture();
    const error = await rejection(
      entryWithActor(f.accountId, { actorKind: 'staff', actorUserId: `absent-${randomUUID()}` })
    );
    // `23503` foreign_key_violation — "who did this" is a join, not a string.
    expect(pgErrorCode(error)).toBe('23503');
  });

  it('indexes the actor, because no functional test could detect its absence', async () => {
    const rows = await getDb().execute(sql`
      select indexname from pg_indexes
      where tablename = 'billing_ledger_entries'
        and indexname = 'billing_ledger_entries_actor_user_id_idx'
    `);
    expect(rows.length).toBe(1);
  });

  it('refuses an UPDATE to the actor in the trigger’s own words, while the same pair INSERTs cleanly', async () => {
    const f = await fixture();
    const staffUserId = await insertAccount();
    const entryId = await entryWithActor(f.accountId, {
      actorKind: 'machine',
      actorUserId: null,
    });

    const error = await rejection(
      getDb()
        .update(billingLedgerEntries)
        .set({ actorKind: 'staff', actorUserId: staffUserId })
        .where(eq(billingLedgerEntries.id, entryId))
    );

    // The trigger, named by its own message. `23514` alone would ALSO be what
    // the actor CHECK raises, so the code on its own cannot say which refused
    // this — and a refusal from the CHECK would mean the append-only rule was
    // never tested here at all.
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgErrorMessage(error)).toContain('billing_ledger_entries is append-only');
    expect(pgErrorMessage(error)).toContain('update');

    // The pairing that makes the assertion above mean something: the very values
    // the UPDATE was refused for violate NO constraint, so the refusal can only
    // have come from the trigger.
    const fresh = await entryWithActor(f.accountId, {
      actorKind: 'staff',
      actorUserId: staffUserId,
    });
    expect(await readActor(fresh)).toEqual({ actorKind: 'staff', actorUserId: staffUserId });

    // And the original is unchanged — the wrong answer is not produced either.
    expect(await readActor(entryId)).toEqual({ actorKind: 'machine', actorUserId: null });
  });
});

describe('money is exact, and units are integers beside it', () => {
  it('stores every amount as numeric with the contract scale', async () => {
    const rows = await getDb().execute(sql`
      select table_name, column_name, data_type, numeric_precision, numeric_scale
      from information_schema.columns
      where table_schema = 'public'
        and column_name in (
          'billed_amount', 'reserved_amount', 'limit_amount', 'credit_limit',
          'purchased_balance', 'promotional_balance', 'reserved_balance',
          'invoiced_outstanding', 'subtotal_amount', 'total_amount'
        )
    `);

    // A floor, so "I found less" cannot pass as "there is less".
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      expect(row.data_type).toBe('numeric');
      expect(Number(row.numeric_scale)).toBe(12);
      expect(Number(row.numeric_precision)).toBe(30);
    }
  });

  it('stores no customer amount as double precision or real anywhere in the ledger', async () => {
    const rows = await getDb().execute(sql`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
        and data_type in ('double precision', 'real')
        and table_name in (
          'price_versions', 'price_version_unit_prices', 'billing_profiles',
          'account_balances', 'billing_ledger_entries', 'billing_ledger_postings',
          'usage_reservations', 'usage_receipts', 'usage_receipt_unit_prices',
          'usage_refunds', 'spending_limits', 'spending_limit_notifications',
          'billing_invoices', 'billing_invoice_receipts',
          'inference_usage_events', 'inference_usage_daily_rollups'
        )
    `);
    expect(rows).toEqual([]);

    // The vacuity floor for the census above: the same query WITHOUT the type
    // filter must see plenty of columns, so an empty result means "none are
    // floats", not "the scan read nothing".
    const scanned = await getDb().execute(sql`
      select count(*)::int as columns
      from information_schema.columns
      where table_schema = 'public'
        and table_name in (
          'usage_receipts', 'account_balances', 'inference_usage_events'
        )
    `);
    expect(Number(scanned[0].columns)).toBeGreaterThan(50);
  });

  it('carries a bigint column for every contract unit, on every metered table', async () => {
    for (const table of [usageReservations, usageReceipts]) {
      const columns = getTableColumns(table);
      for (const key of Object.values(USAGE_UNIT_COLUMN_KEYS)) {
        expect(columns[key]).toBeDefined();
      }
    }
  });
});

describe('the hand-maintained maps still cover their vocabulary', () => {
  it('maps every contract unit to a column, and no column to nothing', () => {
    // Both directions. A map that merely SKIPS what it does not know about is
    // not a gate — an added unit would silently go unpriced and unreported.
    expect(Object.keys(USAGE_UNIT_COLUMN_KEYS).sort()).toEqual([...USAGE_UNITS].sort());

    const columns = usageUnitColumns();
    for (const key of Object.values(USAGE_UNIT_COLUMN_KEYS)) {
      expect(columns[key]).toBeDefined();
    }
    expect(Object.keys(columns).sort()).toEqual([...Object.values(USAGE_UNIT_COLUMN_KEYS)].sort());
  });

  it('renders each unit column under the unit name the contract uses', () => {
    const columns = getTableColumns(usageReceipts);
    for (const [unit, key] of Object.entries(USAGE_UNIT_COLUMN_KEYS)) {
      expect(sqlColumnName(columns[key])).toBe(unit);
    }
  });

  it('keeps the reservation draw order to exactly the three accounts the split expression assumes', () => {
    // `inferenceLedger.service.ts` computes the settle/release split from a
    // THREE-term expression written against these accounts in this order. An
    // added fourth would be silently ignored by it, so the length is asserted
    // exactly rather than as a floor.
    expect([...RESERVATION_DRAW_ORDER]).toEqual([
      'promotional_funds',
      'purchased_funds',
      'invoice_receivable',
    ]);
    expect(RESERVATION_DRAW_ORDER.length).toBe(3);
    for (const account of RESERVATION_DRAW_ORDER) {
      expect(LEDGER_ACCOUNTS).toContain(account);
    }
  });
});

describe('one active price version per route', () => {
  it('refuses a second active version for the same model and provider', async () => {
    const modelReference = `oxy/dup-${randomUUID().slice(0, 8)}`;
    await getDb().insert(priceVersions).values({
      modelReference,
      provider: 'oxy-hosted',
      status: 'active',
      effectiveFrom: new Date(),
    });
    const error = await rejection(
      getDb().insert(priceVersions).values({
        modelReference,
        provider: 'oxy-hosted',
        status: 'active',
        effectiveFrom: new Date(),
      })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('allows a superseded version alongside the active one', async () => {
    const modelReference = `oxy/hist-${randomUUID().slice(0, 8)}`;
    await getDb().insert(priceVersions).values({
      modelReference,
      provider: 'oxy-hosted',
      status: 'superseded',
      effectiveFrom: new Date(Date.now() - 7200_000),
      effectiveUntil: new Date(Date.now() - 3600_000),
    });
    await getDb().insert(priceVersions).values({
      modelReference,
      provider: 'oxy-hosted',
      status: 'active',
      effectiveFrom: new Date(Date.now() - 3600_000),
    });
    const rows = await getDb()
      .select({ id: priceVersions.id })
      .from(priceVersions)
      .where(eq(priceVersions.modelReference, modelReference));
    expect(rows.length).toBe(2);
  });

  it('refuses a superseded version that never stopped applying', async () => {
    const error = await rejection(
      getDb().insert(priceVersions).values({
        modelReference: `oxy/open-${randomUUID().slice(0, 8)}`,
        provider: 'oxy-hosted',
        status: 'superseded',
        effectiveFrom: new Date(),
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses a unit priced twice in one version', async () => {
    const priceVersionId = await insertPriceVersion();
    await getDb()
      .insert(priceVersionUnitPrices)
      .values({ priceVersionId, unit: 'input_tokens', amount: '3.000000000000', per: 1_000_000 });
    const error = await rejection(
      getDb()
        .insert(priceVersionUnitPrices)
        .values({ priceVersionId, unit: 'input_tokens', amount: '4.000000000000', per: 1_000_000 })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('refuses a price quoted per zero units', async () => {
    const priceVersionId = await insertPriceVersion();
    const error = await rejection(
      getDb()
        .insert(priceVersionUnitPrices)
        .values({ priceVersionId, unit: 'input_tokens', amount: '3.000000000000', per: 0 })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });
});
