/**
 * What stands between an account and deletion, financially.
 *
 * `DELETE /users/me` used to run its destructive steps first and delete the
 * `users` row last. Every financial table in this schema references `users` with
 * `ON DELETE RESTRICT` — deliberately, because those rows are the record of
 * money this platform charged a person — so for any account that had ever
 * transacted, that route destroyed the mailboxes, the identity backup, the
 * sessions and the whole social graph and THEN failed with a foreign key
 * violation. A 500, after the irreversible part.
 *
 * This module is what turns that constraint into an ANSWER. It is called before
 * anything is destroyed, and it reports three separable things:
 *
 *  1. **A live subscription.** Stripe keeps billing a customer whose account no
 *     longer exists. This one is refused outright rather than worked around: the
 *     platform must not cancel somebody's payment agreement as a side effect of
 *     a delete, and if Stripe were unreachable it would delete anyway and keep
 *     billing.
 *  2. **Money in flight.** A held reservation is money neither spent nor
 *     returned. Deleting through it strands it.
 *  3. **Retained financial history.** Receipts, ledger entries, invoices,
 *     processor payments. These are kept by law and by reconciliation need, so
 *     the account is RETAINED-and-archived rather than removed — the erasure of
 *     optional data still happens, and #972 section 12's "deletion that preserves
 *     legally required financial records while deleting optional payload data" is
 *     what that boundary implements.
 *
 * ## The blocking set is DERIVED, never listed
 *
 * {@link listRestrictingReferences} reads `pg_constraint` for every foreign key
 * into `users` whose delete action blocks (`RESTRICT` or `NO ACTION`). A
 * hand-maintained list would be a gate that silently stops covering the next
 * financial table somebody adds — and the failure mode of that is the exact
 * partial-destruction bug this module exists to fix, returning quietly the day a
 * new table lands.
 *
 * The introspection is cached for the process lifetime because the schema does
 * not change while the process runs; a migration means a new process.
 */

import { sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import { getDb } from '../config/postgres';
import { LIVE_PRODUCT_PLAN_STATUSES } from '@oxyhq/contracts';

/** A foreign key into `users` whose delete action blocks the delete. */
export interface RestrictingReference {
  readonly table: string;
  readonly column: string;
}

let cachedReferences: RestrictingReference[] | undefined;

/**
 * Every foreign key into `users` that would block a DELETE.
 *
 * `confdeltype` is Postgres's own record of the action: `r` is RESTRICT, `a` is
 * NO ACTION. Both raise on delete; `c` (CASCADE), `n` (SET NULL) and `d` (SET
 * DEFAULT) do not. Reading the catalogue means this cannot disagree with the
 * database, which is the whole point — a list in TypeScript can.
 */
export async function listRestrictingReferences(): Promise<RestrictingReference[]> {
  if (cachedReferences !== undefined) return cachedReferences;

  const rows = await executeRows<{ table_name: string; column_name: string }>(
    getDb(),
    sql`
      select
        child.relname as table_name,
        att.attname as column_name
      from pg_constraint c
      join pg_class child on child.oid = c.conrelid
      join pg_class parent on parent.oid = c.confrelid
      join lateral unnest(c.conkey) as k(attnum) on true
      join pg_attribute att on att.attrelid = c.conrelid and att.attnum = k.attnum
      where c.contype = 'f'
        and parent.relname = 'users'
        and c.confdeltype in ('r', 'a')
      order by child.relname, att.attname
    `
  );

  cachedReferences = rows.map((row) => ({ table: row.table_name, column: row.column_name }));
  return cachedReferences;
}

/** Reset the cached introspection. For tests that create tables mid-run. */
export function resetRestrictingReferenceCache(): void {
  cachedReferences = undefined;
}

/** One blocking table and how many of its rows name this account. */
export interface RetainedRecordCount {
  readonly table: string;
  readonly column: string;
  readonly rows: number;
}

export interface AccountFinancialHolds {
  readonly accountId: string;
  /** Stripe subscriptions still `active` or `trialing`. */
  readonly liveSubscriptionIds: readonly string[];
  /** Reservations still `held` — money neither spent nor returned. */
  readonly heldReservations: number;
  /** Every blocking table with at least one row, and how many. */
  readonly retainedRecords: readonly RetainedRecordCount[];
  /** True when Stripe would keep charging a deleted customer. */
  readonly hasLiveSubscription: boolean;
  /** True when a `DELETE FROM users` would raise a foreign key violation. */
  readonly blocksHardDelete: boolean;
}

/**
 * Everything that stands between this account and a hard delete.
 *
 * Read-only, and cheap enough to run on the delete path: one catalogue lookup
 * (cached), one indexed count per blocking table, and two small selects. It
 * never deletes, never archives and never talks to Stripe — the caller decides
 * what to do with the answer.
 */
export async function describeAccountFinancialHolds(
  accountId: string
): Promise<AccountFinancialHolds> {
  const db = getDb();
  const references = await listRestrictingReferences();

  const retainedRecords: RetainedRecordCount[] = [];
  for (const reference of references) {
    // Identifiers cannot be bound as parameters, and these come from
    // `pg_constraint` rather than from a request — but they are still quoted
    // through `format(%I)` so the query is correct for any identifier the
    // catalogue can hold, not merely for the ones that happen to be plain.
    const rows = await executeRows<{ total: string }>(
      db,
      sql`
        select count(*)::text as total
        from ${sql.raw(quoteIdentifier(reference.table))}
        where ${sql.raw(quoteIdentifier(reference.column))} = ${accountId}
      `
    );
    const total = Number(rows[0]?.total ?? '0');
    if (total > 0) {
      retainedRecords.push({ table: reference.table, column: reference.column, rows: total });
    }
  }

  const subscriptions = await executeRows<{ id: string }>(
    db,
    sql`
      select id
      from billing_subscriptions
      where user_id = ${accountId}
        and status = any(${sql.param([...LIVE_PRODUCT_PLAN_STATUSES])}::text[])
    `
  );

  const held = await executeRows<{ total: string }>(
    db,
    sql`
      select count(*)::text as total
      from usage_reservations
      where account_id = ${accountId} and status = 'held'
    `
  );

  return {
    accountId,
    liveSubscriptionIds: subscriptions.map((row) => row.id),
    heldReservations: Number(held[0]?.total ?? '0'),
    retainedRecords,
    hasLiveSubscription: subscriptions.length > 0,
    blocksHardDelete: retainedRecords.length > 0,
  };
}

/**
 * Quote a catalogue identifier for interpolation into raw SQL.
 *
 * `"` is the only character that needs escaping inside a quoted identifier, and
 * doubling it is how Postgres itself does it. The inputs here come from
 * `pg_constraint`, never from a request, so this is defence in depth rather than
 * the boundary — but an unquoted identifier interpolation is exactly the shape a
 * later refactor turns into an injection point.
 */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Archive an account whose financial history must be retained.
 *
 * `users.account_status = 'archived'` is an EXISTING state with existing
 * meaning: `accountService.resolveEffectiveAccess` resolves an archived account
 * to nothing, so no membership, no application access and no billing authority
 * survives it. Combined with the session revocation the delete path already
 * performs, the account can no longer act.
 *
 * What this deliberately does NOT do is anonymise the profile. Releasing a
 * username, clearing an email and rewriting a display name is a separate
 * decision with its own consequences (a released handle is immediately
 * claimable by somebody else), it belongs to #972 section 12's deletion/export
 * work rather than to the financial-holds question, and doing it here by
 * inference would be the kind of scope creep that is discovered later as data
 * loss. The boundary is stated rather than implied.
 */
export async function archiveAccountForRetention(accountId: string): Promise<void> {
  await getDb().execute(sql`
    update users
    set account_status = 'archived',
        updated_at = date_trunc('milliseconds', now())
    where id = ${accountId}
  `);
}
