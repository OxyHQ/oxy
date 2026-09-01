/**
 * The billing and wallet tables, against a REAL Postgres.
 *
 * These six tables move money, so the properties below are the ones whose
 * failure is silent and unrecoverable: a float residue in a ledger, a replayed
 * Stripe webhook granting a second month of credits, and an account erasure
 * quietly taking a balance or an invoice history with it.
 *
 * Every assertion runs through the application's own pool against the throwaway
 * database `jest.globalSetup.ts` migrated, so what passes is what the shipped
 * DDL does. The whole run shares one database, so every row carries a per-test
 * random owner and no assertion depends on a table being empty.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { EXPIRY_SWEEP_TARGETS } from '../../expiry';
import { billingSubscriptions } from '../billingSubscriptions';
import { billingTransactions } from '../billingTransactions';
import { subscriptions } from '../subscriptions';
import { transactions } from '../transactions';
import { userCredits } from '../userCredits';
import { users } from '../users';
import { wallets } from '../wallets';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';
/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

/** The tables this file owns. */
const MONEY_TABLES = [
  'wallets',
  'transactions',
  'subscriptions',
  'billing_subscriptions',
  'billing_transactions',
  'user_credits',
] as const;

/**
 * Every column across those tables that carries an amount, a price or a credit
 * count, with the type it must have. Listing them by name is the vacuity floor:
 * the catalogue sweep below would pass by examining nothing if the query broke,
 * and a value column that quietly went missing would look identical to one that
 * is correctly typed.
 */
const VALUE_COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  ['wallets', 'balance', 'numeric'],
  ['transactions', 'amount', 'numeric'],
  ['billing_transactions', 'amount_minor_units', 'bigint'],
  ['billing_transactions', 'credits', 'bigint'],
  ['billing_subscriptions', 'plan_price_minor_units', 'bigint'],
  ['billing_subscriptions', 'plan_credits_per_month', 'bigint'],
  ['user_credits', 'credits_free', 'bigint'],
  ['user_credits', 'credits_free_limit', 'bigint'],
  ['user_credits', 'credits_daily_refresh', 'bigint'],
  ['user_credits', 'credits_paid', 'bigint'],
];

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** A real `users` row — every `user_id` in this file carries a foreign key. */
async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

/**
 * The SQLSTATE a driver error carries. Drizzle wraps a driver failure in its own
 * error, so the code lives on the `cause` — walking the chain is what makes the
 * assertions below say "the constraint fired" rather than "something threw".
 */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** The constraint or index a failure names, so a test cannot pass on the wrong one. */
function pgConstraintName(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const name: unknown = Reflect.get(current, 'constraint_name');
    if (typeof name === 'string') return name;
  }
  return undefined;
}

/**
 * Await a query expecting it to be rejected, and return the error.
 *
 * Awaiting a drizzle query builder twice RUNS it twice, so `expect(q).rejects`
 * followed by a `catch` would issue two statements; this issues exactly one.
 */
async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

/** A `billing_subscriptions` row with everything the NOT NULLs require. */
function billingSubscriptionValues(userId: string, stripeSubscriptionId: string) {
  return {
    userId,
    stripeCustomerId: `cus_${randomUUID()}`,
    stripeSubscriptionId,
    stripePriceId: `price_${randomUUID()}`,
    currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
    planName: 'Pro',
    planCreditsPerMonth: 10_000,
    planPriceMinorUnits: 2999,
  };
}

describe('money columns are never floating point', () => {
  it('gives every amount, price and credit column an exact type', async () => {
    const rows = await getDb().execute<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(sql`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
        and table_name in (${sql.join(
          MONEY_TABLES.map((name) => sql`${name}`),
          sql`, `
        )})
    `);

    const byColumn = new Map(
      rows.map((row) => [`${row.table_name}.${row.column_name}`, row.data_type])
    );

    // The named set, with the type each one must have. A column that vanished
    // reads as `undefined` here rather than passing silently.
    expect(
      VALUE_COLUMNS.map(([table, column, expected]) => {
        const actual = byColumn.get(`${table}.${column}`);
        return `${table}.${column} = ${actual ?? 'MISSING'} (want ${expected})`;
      }).filter((line, index) => {
        const [table, column, expected] = VALUE_COLUMNS[index];
        return byColumn.get(`${table}.${column}`) !== expected;
      })
    ).toEqual([]);

    // And the sweep, which catches a NEW column nobody thought about. `real` and
    // `double precision` cannot represent 0.1; in a ledger that is a residue
    // that compounds and cannot be reconciled after the fact.
    expect(
      [...byColumn.entries()]
        .filter(([, type]) => type === 'real' || type === 'double precision')
        .map(([id, type]) => `${id} = ${type}`)
    ).toEqual([]);
  });

  it('gives the FairCoin columns the same precision and scale', async () => {
    const rows = await getDb().execute<{
      table_name: string;
      numeric_precision: number;
      numeric_scale: number;
    }>(sql`
      select table_name, numeric_precision, numeric_scale
      from information_schema.columns
      where table_schema = 'public'
        and (table_name, column_name) in (('wallets', 'balance'), ('transactions', 'amount'))
      order by table_name
    `);

    // A debit compared against a balance of a different scale starts rounding at
    // the comparison, so the two columns must not be able to drift apart.
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.numeric_precision, row.numeric_scale])).toEqual([
      [38, 8],
      [38, 8],
    ]);
  });
});

describe('wallets — decimal arithmetic, not float arithmetic', () => {
  it('leaves exactly zero after a sequence a double cannot represent', async () => {
    const userId = await owner();
    await getDb().insert(wallets).values({ userId, balance: '0' });

    // Ten credits of 0.1 and one debit of 1. In IEEE-754 this leaves a residue;
    // the control below proves the sequence really does distinguish the two, so
    // this assertion cannot pass for the wrong reason.
    let asDouble = 0;
    for (let i = 0; i < 10; i += 1) {
      asDouble += 0.1;
      await getDb()
        .update(wallets)
        .set({ balance: sql`${wallets.balance} + 0.10000000` })
        .where(eq(wallets.userId, userId));
    }
    asDouble -= 1;
    await getDb()
      .update(wallets)
      .set({ balance: sql`${wallets.balance} - 1.00000000` })
      .where(eq(wallets.userId, userId));

    expect(asDouble).not.toBe(0);

    const [row] = await getDb().select().from(wallets).where(eq(wallets.userId, userId));
    expect(row.balance).toBe('0.00000000');
  });

  it('holds exact through a realistic run of credits and debits', async () => {
    const userId = await owner();
    await getDb().insert(wallets).values({ userId, balance: '7.00000000' });

    // A hundred small purchases against a whole starting balance.
    let asDouble = 7;
    for (let i = 0; i < 100; i += 1) {
      asDouble -= 0.07;
      await getDb()
        .update(wallets)
        .set({ balance: sql`${wallets.balance} - 0.07000000` })
        .where(eq(wallets.userId, userId));
    }

    expect(asDouble).not.toBe(0);

    const [row] = await getDb().select().from(wallets).where(eq(wallets.userId, userId));
    expect(row.balance).toBe('0.00000000');
  });

  it('round-trips a value far outside a double\'s exact integer range', async () => {
    const userId = await owner();
    const huge = '123456789012345678901234567890.12345678';
    await getDb().insert(wallets).values({ userId, balance: huge });

    const [row] = await getDb().select().from(wallets).where(eq(wallets.userId, userId));
    expect(row.balance).toBe(huge);
    // A double would have collapsed it; this is what proves the read path is not
    // quietly parsing the column into one.
    expect(Number(row.balance).toString()).not.toBe(huge);
  });

  it('refuses to let a balance go negative', async () => {
    const userId = await owner();
    await getDb().insert(wallets).values({ userId, balance: '1.00000000' });

    const error = await rejection(
      getDb()
        .update(wallets)
        .set({ balance: sql`${wallets.balance} - 2.00000000` })
        .where(eq(wallets.userId, userId))
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraintName(error)).toBe('wallets_balance_check');
  });

  it('allows one wallet per account and no more', async () => {
    const userId = await owner();
    await getDb().insert(wallets).values({ userId });

    const error = await rejection(getDb().insert(wallets).values({ userId }));
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgConstraintName(error)).toBe('wallets_user_id_key');
  });
});

describe('billing_transactions — the Stripe webhook idempotency index', () => {
  /** One renewal payment for a given subscription and period. */
  function renewal(userId: string, stripeSubscriptionId: string, periodStart: Date) {
    return {
      userId,
      stripeSubscriptionId,
      stripeSubscriptionPeriodStart: periodStart,
      type: 'subscription_payment' as const,
      amountMinorUnits: 2999,
      credits: 10_000,
      status: 'completed' as const,
    };
  }

  it('rejects the same renewal webhook replayed', async () => {
    const userId = await owner();
    const subscriptionId = `sub_${randomUUID()}`;
    const periodStart = new Date('2026-01-01T00:00:00Z');

    await getDb().insert(billingTransactions).values(renewal(userId, subscriptionId, periodStart));

    // Stripe retries webhooks. Without this index the retry grants a second
    // month of credits (`billing.ts:427-463`) and nothing anywhere says so.
    const error = await rejection(
      getDb().insert(billingTransactions).values(renewal(userId, subscriptionId, periodStart))
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgConstraintName(error)).toBe('billing_transactions_subscription_period_key');
  });

  it('allows the next billing period', async () => {
    const userId = await owner();
    const subscriptionId = `sub_${randomUUID()}`;

    await getDb()
      .insert(billingTransactions)
      .values(renewal(userId, subscriptionId, new Date('2026-01-01T00:00:00Z')));

    await expect(
      getDb()
        .insert(billingTransactions)
        .values(renewal(userId, subscriptionId, new Date('2026-02-01T00:00:00Z')))
    ).resolves.toBeDefined();
  });

  it('does not collide a one-time purchase with a renewal', async () => {
    const userId = await owner();
    const subscriptionId = `sub_${randomUUID()}`;
    const periodStart = new Date('2026-01-01T00:00:00Z');

    await getDb().insert(billingTransactions).values(renewal(userId, subscriptionId, periodStart));

    await expect(
      getDb()
        .insert(billingTransactions)
        .values({
          userId,
          stripeSubscriptionId: subscriptionId,
          stripeSubscriptionPeriodStart: periodStart,
          type: 'credit_purchase',
          amountMinorUnits: 500,
          credits: 1000,
          status: 'completed',
        })
    ).resolves.toBeDefined();
  });

  it('constrains ONLY renewals — two refunds may share a subscription period', async () => {
    const userId = await owner();
    const subscriptionId = `sub_${randomUUID()}`;
    const periodStart = new Date('2026-03-01T00:00:00Z');

    const refund = {
      userId,
      stripeSubscriptionId: subscriptionId,
      stripeSubscriptionPeriodStart: periodStart,
      type: 'refund' as const,
      amountMinorUnits: -500,
      credits: -1000,
      status: 'refunded' as const,
    };

    // THIS is what the `type = 'subscription_payment'` clause of the predicate
    // buys, and the reason the previous case is not enough on its own: `type` is
    // also an indexed COLUMN, so a differing type already avoids a collision
    // without any predicate at all. Only two rows of the SAME non-renewal type
    // distinguish the two shapes — drop the clause and this insert starts
    // failing, constraining rows Mongo deliberately left unconstrained.
    await getDb().insert(billingTransactions).values(refund);
    await expect(getDb().insert(billingTransactions).values(refund)).resolves.toBeDefined();
  });

  it('states all three predicate clauses in the shipped index', async () => {
    const rows = await getDb().execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where schemaname = 'public'
        and tablename = 'billing_transactions'
        and indexname = 'billing_transactions_subscription_period_key'
    `);

    expect(rows).toHaveLength(1);
    const [{ indexdef }] = rows;
    expect(indexdef).toContain('UNIQUE');
    expect(indexdef).toContain('stripe_subscription_id, stripe_subscription_period_start, type');
    expect(indexdef).toContain("type = 'subscription_payment'");
    // The two `is not null` clauses reproduce Mongo's `$exists`. In Postgres they
    // are index-SIZE fidelity rather than semantics — a btree already treats
    // NULLs as distinct, so a period-less row could never have collided (the case
    // below proves that end to end). A behavioural test therefore cannot hold
    // them; the shipped predicate is asserted here instead so a rewrite that
    // silently widens what the index covers goes red.
    expect(indexdef).toContain('stripe_subscription_id IS NOT NULL');
    expect(indexdef).toContain('stripe_subscription_period_start IS NOT NULL');
  });

  it('never constrains a renewal that carries no billing period', async () => {
    const userId = await owner();
    const subscriptionId = `sub_${randomUUID()}`;

    const periodless = {
      userId,
      stripeSubscriptionId: subscriptionId,
      type: 'subscription_payment' as const,
      amountMinorUnits: 100,
      credits: 1,
      status: 'completed' as const,
    };

    await expect(
      getDb().insert(billingTransactions).values([periodless, periodless])
    ).resolves.toBeDefined();
  });

  it('keeps minor units exact through a round trip', async () => {
    const userId = await owner();
    const [inserted] = await getDb()
      .insert(billingTransactions)
      .values({
        userId,
        type: 'credit_purchase',
        amountMinorUnits: 15_000,
        credits: 50_000,
        status: 'completed',
      })
      .returning();

    expect(inserted.amountMinorUnits).toBe(15_000);
    expect(inserted.credits).toBe(50_000);
    expect(inserted.currency).toBe('usd');
  });
});

describe('user_credits — one Stripe customer resolves to one account', () => {
  it('rejects a second account claiming the same Stripe customer', async () => {
    const stripeCustomerId = `cus_${randomUUID()}`;
    await getDb().insert(userCredits).values({ userId: await owner(), stripeCustomerId });

    // `billing.ts:387` resolves the account for a subscription webhook with
    // `findOne({stripeCustomerId})`. A `findOne` IS a uniqueness assumption.
    const error = await rejection(
      getDb().insert(userCredits).values({ userId: await owner(), stripeCustomerId })
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgConstraintName(error)).toBe('user_credits_stripe_customer_id_key');
  });

  it('lets any number of accounts have no Stripe customer at all', async () => {
    await expect(
      getDb()
        .insert(userCredits)
        .values([{ userId: await owner() }, { userId: await owner() }])
    ).resolves.toBeDefined();
  });

  it('keys the row on the account id, with the Mongoose defaults', async () => {
    const userId = await owner();
    const [row] = await getDb().insert(userCredits).values({ userId }).returning();

    expect(row.userId).toBe(userId);
    expect(row.creditsFree).toBe(1000);
    expect(row.creditsFreeLimit).toBe(1000);
    expect(row.creditsDailyRefresh).toBe(300);
    expect(row.creditsPaid).toBe(0);
  });
});

describe('what deleting an account does to a financial row', () => {
  async function deleteAccount(userId: string): Promise<unknown> {
    return rejection(getDb().delete(users).where(eq(users.id, userId)));
  }

  it('refuses to erase an account that still holds a wallet', async () => {
    const userId = await owner();
    await getDb().insert(wallets).values({ userId, balance: '4.20000000' });

    // A wallet is money held, and it is not derivable from the ledger (a pending
    // withdrawal debits nothing). CASCADE here would destroy value silently.
    const error = await deleteAccount(userId);
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
    expect(pgConstraintName(error)).toBe('wallets_user_id_users_id_fk');
  });

  it('refuses to erase an account that still has ledger rows', async () => {
    const userId = await owner();
    await getDb()
      .insert(transactions)
      .values({ userId, type: 'purchase', amount: '1.00000000', status: 'completed' });

    const error = await deleteAccount(userId);
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
    expect(pgConstraintName(error)).toBe('transactions_user_id_users_id_fk');
  });

  it('will not let one erasure rewrite another person\'s ledger', async () => {
    const payer = await owner();
    const payee = await owner();
    await getDb()
      .insert(transactions)
      .values({
        userId: payer,
        recipientId: payee,
        type: 'transfer',
        amount: '12.50000000',
        status: 'completed',
      });

    // The payee is only the COUNTERPARTY. Cascading would delete the payer's
    // record of the transfer; SET NULL would rewrite it into something with no
    // counterparty, which is what NULL already means on this column.
    const error = await deleteAccount(payee);
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
    expect(pgConstraintName(error)).toBe('transactions_recipient_id_users_id_fk');
  });

  it('refuses to erase an account that still has an invoice history', async () => {
    const userId = await owner();
    await getDb()
      .insert(billingTransactions)
      .values({
        userId,
        type: 'credit_purchase',
        amountMinorUnits: 500,
        credits: 1000,
        status: 'completed',
      });

    const error = await deleteAccount(userId);
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
    expect(pgConstraintName(error)).toBe('billing_transactions_user_id_users_id_fk');
  });

  it('takes the entitlements with it', async () => {
    const userId = await owner();
    await getDb().insert(userCredits).values({ userId, creditsPaid: 500 });
    await getDb()
      .insert(subscriptions)
      .values({ userId, plan: 'pro', endDate: new Date('2030-01-01T00:00:00Z') });
    await getDb()
      .insert(billingSubscriptions)
      .values(billingSubscriptionValues(userId, `sub_${randomUUID()}`));

    // Credits, the legacy plan and the Stripe MIRROR are entitlements, not
    // money: the record of what was paid lives in `billing_transactions`, which
    // is what blocks the delete above.
    await getDb().delete(users).where(eq(users.id, userId));

    expect(await getDb().select().from(userCredits).where(eq(userCredits.userId, userId))).toEqual([]);
    expect(await getDb().select().from(subscriptions).where(eq(subscriptions.userId, userId))).toEqual([]);
    expect(
      await getDb().select().from(billingSubscriptions).where(eq(billingSubscriptions.userId, userId))
    ).toEqual([]);
  });
});

describe('subscriptions — expiry is derived, never a deletion', () => {
  it('is deliberately absent from the expiry sweep registry', () => {
    // Mongo declared `index({endDate: 1}, {expireAfterSeconds: 0})`, which
    // DELETES the document — destroying the record of what a user bought the
    // moment the period closed. `db/expiry.ts` deletes rows too, so registering
    // this table there would reintroduce exactly that bug under a new name.
    expect(
      EXPIRY_SWEEP_TARGETS.filter((target) => target.table === subscriptions)
    ).toEqual([]);
    // Non-empty registry, so this cannot pass because the registry broke.
    expect(EXPIRY_SWEEP_TARGETS.length).toBeGreaterThan(0);
  });

  it('keeps a lapsed subscription readable', async () => {
    const userId = await owner();
    await getDb()
      .insert(subscriptions)
      .values({
        userId,
        plan: 'pro',
        status: 'active',
        endDate: new Date(Date.now() - 60_000),
      });

    const rows = await getDb().select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].plan).toBe('pro');
  });

  it('excludes it from the entitlement read without any job having run', async () => {
    const userId = await owner();
    await getDb()
      .insert(subscriptions)
      .values({ userId, plan: 'pro', status: 'active', endDate: new Date(Date.now() - 60_000) });

    // The ported read. Correctness never depends on the projection below —
    // class (A) in `db/expiry.ts`'s taxonomy.
    const entitled = await getDb()
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.status, 'active'),
          gt(subscriptions.endDate, new Date())
        )
      );

    expect(entitled).toEqual([]);
  });

  // The projection itself — that `active` + lapsed becomes `expired`, that a
  // cancellation is never overwritten, that a second pass writes nothing — is
  // tested against its REAL implementation in `db/__tests__/subscriptionStatus.test.ts`.
  //
  // It used to be re-tested here with a hand-written copy of the UPDATE. That
  // copy was deleted for two reasons, and the second one is why it had to go
  // rather than merely being redundant: a second definition of a predicate can
  // DRIFT from the one that ships, and — because jest runs suites in parallel
  // against ONE database — the real projection is fleet-wide and would race this
  // copy for its own rows, failing it intermittently for no reason a reader
  // could see.

  it('backs the projection with the index its predicate needs', async () => {
    const rows = await getDb().execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where schemaname = 'public'
        and tablename = 'subscriptions'
        and indexname = 'subscriptions_active_end_date_idx'
    `);

    // Mongo's TTL index carried the same obligation: without it the projection
    // is a sequential scan of the whole table every interval.
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('end_date');
    expect(rows[0].indexdef).toContain("WHERE (status = 'active'");
  });

  it('reassembles the six feature booleans the wire contract promises', async () => {
    const userId = await owner();
    const [row] = await getDb()
      .insert(subscriptions)
      .values({
        userId,
        plan: 'business',
        endDate: new Date('2030-01-01T00:00:00Z'),
        featureAnalytics: true,
        featureBusinessTools: true,
      })
      .returning();

    // Real columns, not `jsonb`: a partial `features` subdocument is no longer
    // representable, and the serializer builds the object from these.
    expect({
      analytics: row.featureAnalytics,
      premiumBadge: row.featurePremiumBadge,
      unlimitedFollowing: row.featureUnlimitedFollowing,
      higherUploadLimits: row.featureHigherUploadLimits,
      promotedPosts: row.featurePromotedPosts,
      businessTools: row.featureBusinessTools,
    }).toEqual({
      analytics: true,
      premiumBadge: false,
      unlimitedFollowing: false,
      higherUploadLimits: false,
      promotedPosts: false,
      businessTools: true,
    });
  });
});

describe('closed value sets — text + CHECK, not a pg enum', () => {
  it('rejects an undeclared transaction type from a raw write', async () => {
    // Raw SQL on purpose: the typed column already refuses this at compile time,
    // so only a hand-written statement (backfill, psql) can reach the constraint
    // — which is precisely who it has to stop.
    const error = await rejection(
      getDb().execute(sql`
        insert into transactions (id, user_id, type, amount)
        values (${randomUUID()}, ${await owner()}, 'chargeback', 1)
      `)
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraintName(error)).toBe('transactions_type_check');
  });

  it('rejects an undeclared billing transaction type from a raw write', async () => {
    const error = await rejection(
      getDb().execute(sql`
        insert into billing_transactions (id, user_id, type, amount_minor_units, credits)
        values (${randomUUID()}, ${await owner()}, 'chargeback', 100, 0)
      `)
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraintName(error)).toBe('billing_transactions_type_check');
  });

  /**
   * `billing_subscriptions` is a MIRROR, so the CHECK admits every status Stripe
   * can send — including the three this platform does not sell
   * (`incomplete`, `incomplete_expired`, `paused`).
   *
   * Mongoose declared only the five sellable ones and never enforced them: the
   * webhook writes through `findOneAndUpdate` WITHOUT `runValidators`, so Mongo
   * stored whatever arrived. A CHECK *is* enforced, so porting the narrow list
   * would have turned a silent write into a failed webhook — Stripe retrying
   * forever while the mirror froze at its previous value. A subscription Stripe
   * had moved to `paused` would still read `active` here, and
   * `subscriptionPlan.ts` would keep granting premium to someone who stopped
   * paying. Widening grants nothing: only `active` and `trialing` ever count as
   * live.
   */
  it('accepts every status Stripe can send, including ones this platform does not sell', async () => {
    const userId = await owner();

    for (const status of ['incomplete', 'incomplete_expired', 'paused']) {
      await expect(
        getDb().execute(sql`
          insert into billing_subscriptions
            (id, user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, status,
             current_period_start, current_period_end, plan_name, plan_credits_per_month, plan_price_minor_units)
          values (${randomUUID()}, ${userId}, 'cus_x', ${`sub_${randomUUID()}`}, 'price_x', ${status},
                  now(), now() + interval '30 days', 'Pro', 10000, 2999)
        `)
      ).resolves.toBeDefined();
    }
  });

  it('still rejects a status Stripe cannot send', async () => {
    const userId = await owner();
    const error = await rejection(
      getDb().execute(sql`
        insert into billing_subscriptions
          (id, user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, status,
           current_period_start, current_period_end, plan_name, plan_credits_per_month, plan_price_minor_units)
        values (${randomUUID()}, ${userId}, 'cus_x', ${`sub_${randomUUID()}`}, 'price_x', 'chargeback',
                now(), now() + interval '30 days', 'Pro', 10000, 2999)
      `)
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraintName(error)).toBe('billing_subscriptions_status_check');
  });

  it('refuses a negative ledger amount — direction is `type`, not a sign', async () => {
    const error = await rejection(
      getDb()
        .insert(transactions)
        .values({ userId: await owner(), type: 'purchase', amount: '-1.00000000' })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraintName(error)).toBe('transactions_amount_check');
  });
});
