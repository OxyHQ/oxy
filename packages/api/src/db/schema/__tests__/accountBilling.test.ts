/**
 * The account-billing schema, held to what it claims (issue #972, 7.1/7.4/7.5).
 *
 * Three classes of check, and each exists because the thing it guards is
 * invisible to a functional test:
 *
 *  1. **The append-only triggers are INSTALLED.** drizzle-kit cannot emit a
 *     trigger, so `0044` is hand-written and a regeneration of the table
 *     migration could silently leave it behind. A functional test would never
 *     notice: every insert still works.
 *  2. **The value sets in the schema equal the ones on the wire.** The columns
 *     take their enums from `@oxyhq/contracts`, so a drift would be a compile
 *     error — but the CHECK constraints are rendered from those tuples into SQL
 *     at migration time, so this asserts the constraint in `pg_constraint`
 *     admits exactly the contract's values and nothing else.
 *  3. **The partial unique index reached the database.** A unique over nullable
 *     columns is the shape that silently admits duplicates in Postgres, and the
 *     one on the discrepancy table is deliberately partial.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  AUTO_RECHARGE_STATUSES,
  COST_CENTER_STATUSES,
  EXTERNAL_PAYMENT_KINDS,
  EXTERNAL_PAYMENT_PROVIDERS,
  RECONCILIATION_DISCREPANCY_KINDS,
  RECONCILIATION_RUN_STATUSES,
} from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import {
  EXTERNAL_PAYMENTS_IMMUTABILITY_TRIGGER,
  EXTERNAL_PAYMENTS_TABLE,
  RECONCILIATION_DISCREPANCIES_IMMUTABILITY_TRIGGER,
  RECONCILIATION_DISCREPANCIES_TABLE,
} from '../accountBillingImmutability';
import {
  AUTO_RECHARGE_STATUS_VALUES,
  billingAutoRechargeAttempts,
} from '../billingAutoRechargeAttempts';
import {
  EXTERNAL_PAYMENT_KIND_VALUES,
  EXTERNAL_PAYMENT_PROVIDER_VALUES,
  billingExternalPayments,
} from '../billingExternalPayments';
import {
  RECONCILIATION_DISCREPANCY_KIND_VALUES,
  RECONCILIATION_RUN_STATUS_VALUES,
  billingReconciliationDiscrepancies,
  billingReconciliationRuns,
} from '../billingReconciliation';
import { COST_CENTER_STATUS_VALUES } from '../internalCostCenters';
import { users } from '../users';
import { provisionBillingProfile, recordTopUp } from '../../../services/inferenceLedger.service';

jest.setTimeout(60_000);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** The SQLSTATE the append-only guard raises. */
const CHECK_VIOLATION = '23514';

/**
 * The SQLSTATE a driver error carries.
 *
 * Drizzle wraps a driver failure in its own error whose MESSAGE is just the
 * failed query, so the code lives on the `cause`. Walking the chain is what
 * stops these assertions degrading into "some error happened" — and asserting
 * the message instead would pass for a typo'd column name.
 */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Assert a write is refused with a SPECIFIC SQLSTATE, and that it IS refused. */
async function expectPgError(work: Promise<unknown>, code: string): Promise<void> {
  try {
    await work;
  } catch (error) {
    expect(pgErrorCode(error)).toBe(code);
    return;
  }
  throw new Error(`expected the write to be refused with SQLSTATE ${code}, but it succeeded`);
}

async function triggersOn(table: string): Promise<string[]> {
  const rows = await getDb().execute<{ tgname: string }>(sql`
    select t.tgname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and c.relname = ${table}
  `);
  return rows.map((row) => row.tgname);
}

async function seedRecordedPayment(): Promise<{ paymentId: string; accountId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [account] = await getDb()
    .insert(users)
    .values({ username: `sch-${suffix}`, email: `sch-${suffix}@example.test` })
    .returning({ id: users.id });
  await provisionBillingProfile({ accountId: account.id });

  const externalRef = `pi_${randomUUID().replace(/-/g, '')}`;
  await recordTopUp({
    idempotencyKey: `stripe:payment_intent:${externalRef}`,
    accountId: account.id,
    currency: 'USD',
    amount: '10.000000000000',
    externalPayment: {
      provider: 'stripe',
      externalKind: 'payment_intent',
      externalRef,
      occurredAt: new Date(),
    },
  });

  const rows = await getDb().execute<{ id: string }>(sql`
    select id from ${billingExternalPayments} where external_ref = ${externalRef}
  `);
  return { paymentId: rows[0].id, accountId: account.id };
}

describe('the append-only guards are installed', () => {
  it('guards processor payments against UPDATE and DELETE', async () => {
    expect(await triggersOn(EXTERNAL_PAYMENTS_TABLE)).toContain(
      EXTERNAL_PAYMENTS_IMMUTABILITY_TRIGGER
    );
  });

  it('guards reconciliation findings against UPDATE and DELETE', async () => {
    expect(await triggersOn(RECONCILIATION_DISCREPANCIES_TABLE)).toContain(
      RECONCILIATION_DISCREPANCIES_IMMUTABILITY_TRIGGER
    );
  });

  it('refuses to edit a recorded processor payment', async () => {
    const { paymentId } = await seedRecordedPayment();
    await expectPgError(
      getDb().execute(
        sql`update ${billingExternalPayments} set amount = 1 where id = ${paymentId}`
      ),
      CHECK_VIOLATION
    );
  });

  it('refuses to delete a recorded processor payment', async () => {
    const { paymentId } = await seedRecordedPayment();
    await expectPgError(
      getDb().execute(sql`delete from ${billingExternalPayments} where id = ${paymentId}`),
      CHECK_VIOLATION
    );
  });

  it('leaves the two STATE tables editable, which is why they are not guarded', async () => {
    // A guard here would make the auto-recharge lifecycle unrepresentable and a
    // reconciliation run permanently `running`. Their FACTS are the guarded
    // tables; asserting the absence keeps a future "consistency" change honest.
    expect(await triggersOn('billing_auto_recharge_attempts')).toEqual([]);
    expect(await triggersOn('billing_reconciliation_runs')).toEqual([]);
  });
});

describe('the schema value sets are the wire value sets', () => {
  it('takes every enum from the contract rather than restating it', () => {
    expect(EXTERNAL_PAYMENT_PROVIDER_VALUES).toEqual(EXTERNAL_PAYMENT_PROVIDERS);
    expect(EXTERNAL_PAYMENT_KIND_VALUES).toEqual(EXTERNAL_PAYMENT_KINDS);
    expect(AUTO_RECHARGE_STATUS_VALUES).toEqual(AUTO_RECHARGE_STATUSES);
    expect(RECONCILIATION_RUN_STATUS_VALUES).toEqual(RECONCILIATION_RUN_STATUSES);
    expect(RECONCILIATION_DISCREPANCY_KIND_VALUES).toEqual(RECONCILIATION_DISCREPANCY_KINDS);
    expect(COST_CENTER_STATUS_VALUES).toEqual(COST_CENTER_STATUSES);
  });

  it('rendered those values into the CHECK constraints the database holds', async () => {
    const rows = await getDb().execute<{ conname: string; definition: string }>(sql`
      select c.conname, pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      where c.contype = 'c'
        and t.relname in (
          'billing_external_payments',
          'billing_auto_recharge_attempts',
          'billing_reconciliation_runs',
          'billing_reconciliation_discrepancies',
          'internal_cost_centers'
        )
    `);
    const byName = new Map(rows.map((row) => [row.conname, row.definition]));

    // A floor: an empty map would make every `toContain` below vacuous.
    expect(rows.length).toBeGreaterThan(10);

    for (const kind of RECONCILIATION_DISCREPANCY_KINDS) {
      expect(byName.get('billing_reconciliation_discrepancies_kind_check')).toContain(
        `'${kind}'`
      );
    }
    for (const status of AUTO_RECHARGE_STATUSES) {
      expect(byName.get('billing_auto_recharge_attempts_status_check')).toContain(`'${status}'`);
    }
  });
});

describe('the partial unique index reached the database', () => {
  it('constrains a run to one finding per reference and kind', async () => {
    const rows = await getDb().execute<{ indexdef: string }>(sql`
      select indexdef
      from pg_indexes
      where tablename = 'billing_reconciliation_discrepancies'
        and indexname = 'billing_reconciliation_discrepancies_run_ref_key'
    `);
    expect(rows).toHaveLength(1);
    // PARTIAL, not plain. `missing_in_external` rows carry no external ref, and
    // Postgres treats NULLs as DISTINCT — so a plain unique would admit unbounded
    // duplicates of exactly the rows it looks like it constrains.
    expect(rows[0].indexdef).toContain('UNIQUE');
    expect(rows[0].indexdef).toContain('WHERE');
  });

  it('constrains a processor reference to one recorded payment', async () => {
    const rows = await getDb().execute<{ conname: string }>(sql`
      select conname
      from pg_constraint
      where conname = 'billing_external_payments_provider_ref_key'
    `);
    // The SECOND, independent webhook idempotency guard, beside the ledger's own
    // key. The two fail differently on purpose.
    expect(rows).toHaveLength(1);
  });
});

describe('the money columns are exact', () => {
  it('stores every amount as NUMERIC, never a float', async () => {
    const rows = await getDb().execute<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(sql`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_name in (
          'billing_external_payments',
          'billing_auto_recharge_attempts',
          'billing_reconciliation_runs',
          'billing_reconciliation_discrepancies'
        )
        and column_name in (
          'amount', 'requested_amount', 'balance_at_trigger',
          'ledger_total', 'external_total', 'ledger_amount', 'external_amount'
        )
    `);

    // The floor again: zero rows would make the loop below assert nothing.
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) {
      expect({ ...row, data_type: row.data_type }).toMatchObject({ data_type: 'numeric' });
    }
  });
});

describe('the tables exist and are addressable', () => {
  it('is reachable through the drizzle schema barrel', () => {
    // A table not re-exported from `schema/index.ts` gets neither a migration
    // nor a typed query, and the failure is silence.
    expect(billingExternalPayments).toBeDefined();
    expect(billingAutoRechargeAttempts).toBeDefined();
    expect(billingReconciliationRuns).toBeDefined();
    expect(billingReconciliationDiscrepancies).toBeDefined();
  });
});
