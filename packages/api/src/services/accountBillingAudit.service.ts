/**
 * One account's BILLING audit trail — the ledger entries a customer did, or had
 * done to them (issue #972, "audit dashboards for credential and billing
 * changes"; the credential half is `accountAuditTrail.service.ts`).
 *
 * `billing_ledger_entries` is the double-entry journal every balance is derived
 * from, and it is written for internal correctness rather than for reading. This
 * is the customer-facing projection of it: which of those entries a customer has
 * a right to see, what each one is worth to THEM, and who caused it — with the
 * internal accounting deliberately left behind.
 *
 * Read-only, and beside the ledger service rather than inside it: nothing here
 * may ever grow a write.
 *
 * ## Four of the nine kinds
 *
 * {@link CUSTOMER_FACING_LEDGER_KINDS} is `top_up`, `promotional_grant`,
 * `settlement_reversal` and `invoice_payment`. The other five —
 * `reservation_hold`, `reservation_release`, `reservation_expiry`, `settlement`
 * and `invoice_rounding` — are excluded, and volume is the WEAKER of the two
 * reasons: the reservation kinds are one to four rows per inference request, so
 * at real traffic they bury the events a human is auditing.
 *
 * The stronger reason is that they are not CHANGES. They are the mechanics of
 * usage, and usage has its own reporting endpoints. The amount rule below
 * restates that numerically without being told to: the three reservation kinds
 * net to exactly ZERO here, because a hold, a release and an expiry move value
 * only between the customer's OWN buckets.
 *
 * The split is a PARTITION, asserted in both directions by
 * `__tests__/accountBillingAudit.test.ts`, so a tenth entry kind added to the
 * schema fails a test instead of being silently omitted from every customer's
 * audit trail. A list that merely skips what it does not know about would be no
 * gate at all.
 *
 * ## The amount is DERIVED, because no entry carries one
 *
 * `billing_ledger_entries` has no amount column. The money lives on
 * `billing_ledger_postings`, which this projection does not expose (see the
 * exclusions below), so the customer-facing amount has to be computed — and
 * there is a wrong answer available.
 *
 * ONE rule, with no `kind` in it:
 *
 *   **the amount is the signed NET across the boundary between the customer's
 *   own accounts and Oxy's counterparty accounts** — positive when the
 *   customer's side is the posting's destination, negative when it is the
 *   source, and zero when both sides are the customer's own.
 *
 * A per-kind mapping was considered and rejected: it is wrong the moment a
 * tenth kind is added and nobody updates it, and it fails by falling through to
 * a default, which is silent. This rule is kind-independent and correct for all
 * nine kinds today — `top_up`, `promotional_grant`, `settlement_reversal` and
 * `invoice_payment` positive, `settlement` negative, `invoice_rounding` either
 * way by direction, and the three reservation kinds zero.
 *
 * The single-posting form of the rule — "the posting whose other side is the
 * customer" — holds for three of the four included kinds and NOT for
 * `settlement_reversal`, which returns money to every bucket the original charge
 * drew from: reversing a charge that spent promotional and purchased funds
 * writes two postings, and the customer-facing amount is their total (it equals
 * `usage_refunds.amount`). Hence a net over postings rather than a lookup of one.
 *
 * ### Why a double count is not merely avoided
 *
 * Two things make it unrepresentable rather than tested-for.
 *
 * `billing_ledger_postings` is in TRANSFER normal form — one row is one amount
 * moving from one account to another, not a debit row beside a credit row — so
 * the textbook "every amount appears twice" double count has nothing to count
 * twice. That is the schema's decision, argued in its own header.
 *
 * What remains is counting a posting that never crossed the boundary, and the
 * `case` below is why it cannot: each posting is visited once and yields exactly
 * one term, and an internal move yields `0`. There is no branch a posting can
 * take twice and no branch it can miss.
 *
 * The `else 0` is also why {@link CUSTOMER_LEDGER_ACCOUNTS} needs its own
 * completeness gate. An account absent from that list is treated as a
 * counterparty, which turns a customer-internal move into a customer-facing
 * change — a wrong amount with no error anywhere. The test asserts the customer
 * accounts and the counterparty accounts partition `LEDGER_ACCOUNTS` exactly.
 *
 * ## Direction is a field, not a sign
 *
 * `exactDecimalSchema` (`@oxyhq/contracts`) is non-negative BY REGEX, and its
 * docblock states the rule the whole ledger is built on: direction is carried by
 * the shape, never by a sign, because "a signed amount is how a reversal
 * silently becomes a second charge". A negative `amount` string would be outside
 * the published contract, so {@link BillingAuditEntry.direction} carries it
 * instead and `amount` is always non-negative.
 *
 * Not `credit`/`debit`: `billingLedgerEntries.ts` refuses those two as column
 * names on the grounds that they are correct accounting vocabulary and are read
 * backwards by most engineers most of the time. `in` / `out` / `none` cannot be.
 *
 * The perspective is the customer's OXY books, and it is stated because it is a
 * decision rather than a fact. All four included kinds are `in` today, including
 * `invoice_payment` — which reduces what the customer owes while being money
 * leaving their bank account. `top_up` has exactly the same property and nobody
 * reads it as negative, so one consistent rule is better than matching the
 * intuition for one kind and breaking it for the other.
 *
 * ## What this projection deliberately does NOT publish
 *
 * Each is a decision, not an omission:
 *
 *  1. **`actor_user_id`.** The actor KIND is exposed and the id never is. "A
 *     human did this, not an automated process" is precisely what a customer
 *     auditing a surprise credit needs; the name of the Oxy employee who issued
 *     it is not, and naming them would make an internal staffing fact
 *     customer-visible forever in an append-only table. This matches the coarse,
 *     non-identifying attribution the codebase already chose for the approval
 *     screen's `requesterLabel`. The column is not merely dropped after
 *     selection — it is not in the query at all, so no future edit to the row
 *     mapper can leak it.
 *  2. **The postings themselves** — `sourceAccount`, `destinationAccount`,
 *     `sequence`. They name Oxy's internal chart of accounts
 *     (`platform_revenue`, `promotional_issuance`, `invoice_receivable`).
 *     Publishing it would make an internal accounting reorganisation a breaking
 *     API change, and it is the reason the amount above is derived rather than
 *     read.
 *  3. **`idempotency_key`.** Internal write-dedup, meaningless to a reader, and
 *     a probe surface: the keys are derived from processor event ids and
 *     operation prefixes, so publishing them would leak both.
 *  4. **`reservation_id`.** A reservation is an internal hold with no
 *     customer-facing existence — the kinds that name one are precisely the
 *     kinds excluded above. `receipt_id`, `refund_id` and `invoice_id` are
 *     published because each names a document the customer already has.
 *
 * `top_up` and `promotional_grant` therefore carry NO reference id at all, which
 * is a true statement about the entry: a top-up's processor reference lives on
 * `billing_external_payments`, which points at the entry rather than the other
 * way round. Joining it in is a separate decision about exposing a processor id.
 *
 * ## Ordering, and the two traps `accountAuditTrail.service.ts` measured
 *
 * The sort key is `(created_at desc, id desc)`, it is defined EXACTLY ONCE in
 * the statement, and every component descends — because the cursor is a
 * row-value comparison, and that expresses a keyset only when the whole key
 * sorts one way. Mixed directions beside a row-value cursor skip rows silently.
 *
 * "Exactly once" is the half that had to be measured. An earlier draft computed
 * the amount in a CTE and re-ordered outside it, which is two `order by` clauses
 * that must agree forever; flipping the inner one to ascending id changed which
 * rows the LIMIT selected, the outer clause re-sorted whatever came out, and the
 * whole suite stayed green. The `lateral` join below is what reduces it to one
 * clause — see the note there.
 *
 * `created_at` alone is not a total order: `settle` writes a `settlement` and a
 * `reservation_release` in one transaction sharing `now()`, and uuid v7 is not
 * monotone within a millisecond. Only one of those two kinds is customer-facing
 * today, but a cursor that is correct only because of the current kind filter is
 * a cursor that breaks when the filter changes.
 *
 * The cursor carries the timestamp EXACTLY as Postgres returned it, and the raw
 * `execute` is CHOSEN rather than tolerated. Measured against this table, with a
 * row written at `10:00:00.000123+00`:
 *
 *   - raw `db.execute` returns the string `2026-08-18 10:00:00.000123+00` —
 *     Postgres wire format, microseconds intact, neither a `Date` nor ISO-8601;
 *   - the same row through drizzle's query builder comes back as a `Date`, whose
 *     `toISOString()` is `2026-08-18T10:00:00.000Z`. The `123` is gone, and a
 *     cursor built from it would exclude every row between that millisecond and
 *     the true value.
 *
 * So the query builder would reintroduce the silent row-skip through the RESULT
 * MAPPER rather than through the ordering, and `new Date(v).toISOString()` does
 * the same thing by hand. Only the wire `createdAt` is normalised to ISO.
 *
 * `created_at`'s DEFAULT is `date_trunc('milliseconds', now())` (`@oxyhq/db`'s
 * `createdAt()`), so every row written by today's ledger writers is already
 * millisecond-precision and would survive the lossy path. That is a property of
 * a column default in another package, not of this module: the column itself is
 * plain `timestamptz` and stores microseconds happily, as the fixture above
 * proves. A cursor that is correct only because of somebody else's default is a
 * cursor waiting for that default to change.
 *
 * The raw `execute` also means no `bigint` column may enter this projection
 * without revisiting `mode: 'number'` — none is here, and the money is
 * `numeric`, which `postgres.js` decodes as a string either way.
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import type {
  LedgerAccount,
  LedgerActorKind,
  LedgerEntryKind,
} from '../db/schema/billingLedgerEntries';

/**
 * The entry kinds a customer may read: things they did, or that were done to
 * them. See the header for why these four and not the other five.
 */
export const CUSTOMER_FACING_LEDGER_KINDS = [
  'top_up',
  'promotional_grant',
  'settlement_reversal',
  'invoice_payment',
] as const satisfies readonly LedgerEntryKind[];

/**
 * The kinds this trail withholds, listed rather than left implicit.
 *
 * Written out so the split can be asserted as a PARTITION of
 * `LEDGER_ENTRY_KINDS` in both directions. A test that only checked the included
 * four exist would pass forever while a tenth kind went unmentioned by either
 * list — which is the shape of a gate that gates nothing.
 */
export const INTERNAL_LEDGER_KINDS = [
  'reservation_hold',
  'reservation_release',
  'reservation_expiry',
  'settlement',
  'invoice_rounding',
] as const satisfies readonly LedgerEntryKind[];

/**
 * The accounts that belong to the CUSTOMER, from the chart in
 * `billingLedgerEntries.ts`. Everything in `LEDGER_ACCOUNTS` that is not here is
 * one of Oxy's counterparties.
 *
 * The boundary between these two sets IS the amount rule, so this list is
 * load-bearing and gated: an account missing from it is treated as a
 * counterparty, and a customer-internal move then reads as a customer-facing
 * change.
 */
export const CUSTOMER_LEDGER_ACCOUNTS = [
  'purchased_funds',
  'promotional_funds',
  'reserved_funds',
  'invoice_receivable',
] as const satisfies readonly LedgerAccount[];

/**
 * Oxy's side of the boundary: where money enters and leaves the customer's
 * books.
 *
 * Written out rather than derived by filtering `LEDGER_ACCOUNTS`. A derived list
 * would make the partition assertion below true BY CONSTRUCTION — it would hold
 * just as well for an eighth account nobody had thought about, which is the
 * whole failure the gate exists to catch. Two hand-written lists whose union
 * must equal the schema's is a gate; one derived from the other is arithmetic.
 */
export const COUNTERPARTY_LEDGER_ACCOUNTS = [
  'external_settlement',
  'promotional_issuance',
  'platform_revenue',
] as const satisfies readonly LedgerAccount[];

/**
 * Which way value moved across the boundary of the customer's own accounts.
 *
 * `none` is a real outcome rather than a placeholder: an entry whose postings
 * are all internal, or which has no postings at all (`writeEntry` skips a
 * zero-amount posting), moved nothing across that boundary, and saying `in` with
 * an amount of `0` would be a claim about a direction nothing took.
 */
export type BillingAuditDirection = 'in' | 'out' | 'none';

/**
 * Who authored an entry, coarsely.
 *
 * `staff` — a named person at Oxy did this, and the name is deliberately not
 * here. `machine` — no person authored it: a processor webhook, the expiry
 * sweep, the inference edge. `unknown` — the row predates the actor columns
 * (migration 0046) and never recorded one; those rows were NOT back-filled,
 * because "no person authored it" and "we did not record who did" are exactly
 * the two readings the columns exist to separate.
 */
export type BillingAuditActorKind = LedgerActorKind | 'unknown';

/** One customer-facing ledger change. */
export interface BillingAuditEntry {
  /** `billing_ledger_entries.id` — the reference a customer quotes to support. */
  readonly id: string;
  readonly kind: (typeof CUSTOMER_FACING_LEDGER_KINDS)[number];
  readonly currency: string;
  /** Exact, non-negative decimal string. Never a `number`. */
  readonly amount: string;
  readonly direction: BillingAuditDirection;
  readonly actorKind: BillingAuditActorKind;
  /** The settled charge a reversal reverses. Null for every other kind. */
  readonly receiptId: string | null;
  /** The refund a reversal produced. Null for every other kind. */
  readonly refundId: string | null;
  /** The invoice a payment settled. Null for every other kind. */
  readonly invoiceId: string | null;
  readonly createdAt: string;
}

export interface BillingAuditPage {
  readonly entries: readonly BillingAuditEntry[];
  /** Hand back verbatim for the next page. Null when the trail is exhausted. */
  readonly nextCursor: string | null;
}

/**
 * The keyset a cursor encodes: the whole sort key.
 *
 * `createdAt` is the timestamp string EXACTLY as Postgres returned it, at
 * microsecond precision, and is never round-tripped through a `Date`. See the
 * header for the measurement.
 */
interface BillingAuditCursor {
  readonly createdAt: string;
  readonly id: string;
}

export const BILLING_AUDIT_MAX_LIMIT = 200;
export const BILLING_AUDIT_DEFAULT_LIMIT = 50;

/**
 * Encode a keyset position opaquely, following `accountAuditTrail.service.ts`.
 *
 * Opaque so the pagination axis stays an implementation detail and a caller
 * cannot pin `created_at` to an arbitrary point to probe when a specific charge
 * or grant was written.
 */
export function encodeBillingAuditCursor(cursor: BillingAuditCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * Decode a cursor, or `null` when it is not one we issued.
 *
 * `null` rather than a throw, matching the account trail: the caller then reads
 * from the start, which is what passing nothing does. An error would confirm the
 * format is guessable.
 */
export function decodeBillingAuditCursor(raw: string): BillingAuditCursor | null {
  // No try/catch, deliberately: neither `Buffer.from(_, 'base64url')` nor
  // `new Date(_)` throws on garbage — the first yields a short or empty buffer
  // and the second an Invalid Date. A catch here would look like it handled
  // malformed input while the checks below are what actually do.
  const parts = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (parts.length !== 2) return null;
  const [rawCreatedAt, id] = parts;
  // Validated as a timestamp but KEPT as the original string: parsing proves it
  // is one, converting would cost the microseconds.
  if (Number.isNaN(new Date(rawCreatedAt).getTime()) || id === '') return null;
  return { createdAt: rawCreatedAt, id };
}

/**
 * The row shape the query projects. Text only — see the header on the raw
 * `execute`.
 *
 * A `type` rather than an `interface` because `db.execute<T>` constrains `T` to
 * `Record<string, unknown>`, which an interface does not satisfy — only a type
 * alias gets the implicit index signature.
 */
type BillingAuditRow = {
  readonly id: string;
  readonly kind: string;
  readonly currency: string;
  readonly amount: string;
  readonly direction: string;
  readonly actorKind: string | null;
  readonly receiptId: string | null;
  readonly refundId: string | null;
  readonly invoiceId: string | null;
  readonly createdAt: string;
};

/**
 * One page of an account's billing audit trail, newest first.
 *
 * Authorises nothing: the caller has already established that this account is
 * one it may read, and with which permission.
 */
export async function listAccountBillingAudit(
  accountId: string,
  options: { readonly limit: number; readonly cursor?: string | null } = {
    limit: BILLING_AUDIT_DEFAULT_LIMIT,
  }
): Promise<BillingAuditPage> {
  const limit = Math.min(Math.max(options.limit, 1), BILLING_AUDIT_MAX_LIMIT);
  const cursor =
    options.cursor === undefined || options.cursor === null
      ? null
      : decodeBillingAuditCursor(options.cursor);

  // Row-wise comparison against the WHOLE sort key. `created_at < x` alone would
  // skip every row tied with the cursor's own instant.
  const keyset =
    cursor === null
      ? sql`true`
      : sql`(e.created_at, e.id) < (${cursor.createdAt}::timestamptz, ${cursor.id})`;

  const customerAccounts = sql`${sql.param([...CUSTOMER_LEDGER_ACCOUNTS])}::text[]`;

  // The amount rule, as one expression over each posting exactly once. See the
  // header: a posting takes exactly one branch, an internal move takes `else 0`,
  // and every arithmetic step stays in Postgres — `numeric` never becomes a JS
  // `number` anywhere on this path.
  //
  // A LATERAL rather than a scalar subquery repeated twice, because the row's
  // amount and its direction are two readings of the same number and writing the
  // rule twice would let them disagree.
  const netJoin = sql`
    cross join lateral (
      select coalesce(sum(
        case
          when p.destination_account = any(${customerAccounts})
               and p.source_account <> all(${customerAccounts})
            then p.amount
          when p.source_account = any(${customerAccounts})
               and p.destination_account <> all(${customerAccounts})
            then -p.amount
          else 0
        end
      ), 0) as value
      from billing_ledger_postings p
      where p.entry_id = e.id
    ) net
  `;

  // One more than asked for, so "is there another page" is answered by reading a
  // row rather than by a second count query that could disagree with it.
  const rows = await getDb().execute<BillingAuditRow>(sql`
    select
      e.id         as id,
      e.kind       as kind,
      e.currency   as currency,
      e.actor_kind as "actorKind",
      e.receipt_id as "receiptId",
      e.refund_id  as "refundId",
      e.invoice_id as "invoiceId",
      e.created_at as "createdAt",
      -- Non-negative on the wire: the direction column carries which way it went,
      -- because a signed amount is outside the exact-decimal contract.
      abs(net.value)::text as amount,
      case when net.value > 0 then 'in' when net.value < 0 then 'out' else 'none' end as direction
    from billing_ledger_entries e
    ${netJoin}
    where e.account_id = ${accountId}
      and e.kind = any(${sql.param([...CUSTOMER_FACING_LEDGER_KINDS])}::text[])
      and ${keyset}
    -- The ONLY order by in this statement, and the one the cursor is built from.
    -- An earlier draft computed the amount in a CTE and re-ordered outside it,
    -- which gave the sort key TWO definitions that had to agree forever; a
    -- mutation flipping the inner one to ascending id changed which rows the LIMIT
    -- selected while the outer clause hid it, and every test still passed.
    order by e.created_at desc, e.id desc
    limit ${limit + 1}
  `);

  return pageOf(rows, limit);
}

/** Shape a fetched window into a page, dropping the lookahead row. */
function pageOf(rows: readonly BillingAuditRow[], limit: number): BillingAuditPage {
  const window = rows.slice(0, limit);
  const entries = window.map((row) => ({
    id: row.id,
    // The `where` clause is the only thing that admits a kind, so the cast
    // restates the filter rather than widening it.
    kind: row.kind as (typeof CUSTOMER_FACING_LEDGER_KINDS)[number],
    currency: row.currency,
    amount: row.amount,
    direction: row.direction as BillingAuditDirection,
    // Null means "written before migration 0046", never "machine". See
    // {@link BillingAuditActorKind}.
    actorKind: (row.actorKind ?? 'unknown') as BillingAuditActorKind,
    receiptId: row.receiptId,
    refundId: row.refundId,
    invoiceId: row.invoiceId,
    // ISO for the wire, so the published shape is stable; the CURSOR keeps the
    // raw microsecond string instead.
    createdAt: new Date(row.createdAt).toISOString(),
  }));

  const last = window[window.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined
      ? encodeBillingAuditCursor({ createdAt: last.createdAt, id: last.id })
      : null;

  return { entries, nextCursor };
}
