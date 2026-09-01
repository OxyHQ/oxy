/**
 * `billing_ledger_entries` + `billing_ledger_postings` — the double-entry
 * journal every balance in this schema is derived from.
 *
 * # Double-entry, in TRANSFER normal form — the choice #972 asks to be argued
 *
 * The epic allows "double-entry or equivalently auditable". This is double
 * entry, written so that an unbalanced entry is UNREPRESENTABLE rather than
 * monitored:
 *
 *   a posting is ONE non-negative amount, a SOURCE account and a DESTINATION
 *   account.
 *
 * The alternative shape — a row per leg carrying `(account, direction, amount)`
 * and a rule that the legs of one entry must sum to zero — is the textbook
 * layout and it is worse here for one specific reason. Postgres cannot express
 * "the rows of this group sum to zero" as a table constraint; it needs a
 * deferred trigger or an out-of-band check. That turns the ledger's central
 * invariant into something you ALERT on, and #972 duly asks for "alerts for
 * ledger imbalance". In transfer form there is no imbalance to alert on: one
 * amount cannot leave one account without arriving at another. The imbalance
 * alert becomes a check on the PROJECTION (`account_balances`) disagreeing with
 * the journal, which is a real and different failure worth watching.
 *
 * Nothing is lost. An entry involving three accounts — a settlement that draws
 * partly from promotional and partly from purchased funds — is two postings
 * under one entry, which is exactly what a three-legged journal entry is.
 *
 * `debit` / `credit` are deliberately not the column names. They are correct
 * accounting vocabulary and they are read backwards by most engineers most of
 * the time; `source` and `destination` cannot be. The header of every ledger
 * account below says which side of the customer's books it is.
 *
 * # The chart of accounts
 *
 * Four accounts belong to the CUSTOMER and are what a balance is made of:
 *
 *  - `purchased_funds`     prepaid money the customer bought
 *  - `promotional_funds`   granted credit — not purchased, may expire, never refundable
 *  - `reserved_funds`      held against in-flight requests; not money spent
 *  - `invoice_receivable`  drawn against a credit limit and not yet paid
 *
 * Three are Oxy's counterparties, and exist so that money entering or leaving
 * the customer's books has somewhere to come from:
 *
 *  - `external_settlement`   the payment processor — a top-up arrives here, an invoice payment returns here
 *  - `promotional_issuance`  where a grant originates
 *  - `platform_revenue`      where a settled charge lands
 *
 * `invoice_receivable` is the one whose sign needs care, and the convention is
 * stated in full on `account_balances`: the journal rule is
 * `balance = Σ(destination) − Σ(source)` for every account, and
 * `invoiced_outstanding` is the single negation of that, so every projected
 * column can stay non-negative.
 *
 * # Idempotency lives on the ENTRY, not the posting
 *
 * `idempotency_key` is UNIQUE across the table. Every write path derives it from
 * the caller's own key with an operation prefix (`reserve:…`, `settle:…`), so a
 * retry, a redelivered data-plane event or a duplicated webhook produces the
 * same entry rather than a second movement of money. It is enforced by a unique
 * index and written with `ON CONFLICT … DO NOTHING RETURNING`, never by catching
 * a duplicate-key error: a duplicate key and a dropped connection are
 * indistinguishable inside a `catch`, so an exception handler would answer
 * "already done" to an infrastructure failure.
 *
 * # Append-only
 *
 * Both tables are immutable by trigger (`db/schema/ledgerImmutability.ts`).
 * Neither carries an `updated_at`. A correction is a NEW entry referencing what
 * it corrects.
 *
 * # Who authored an entry (issue #1023)
 *
 * `actor_kind` + `actor_user_id` answer "which person did this", for the one
 * entry type where nothing else can: a `promotional_grant` creates customer
 * balance out of nothing, and before this pair the kind of entry was
 * distinguishable while the person was not.
 *
 * Three states, and the whole point of the design is that no two of them can be
 * confused for one another:
 *
 *   ('staff',   <user id>)  a named person authored it. The id is a real foreign
 *                           key to `users`, RESTRICT like every other reference
 *                           out of this table, so "who issued this grant" is a
 *                           join and the journal outlives an attempt to remove
 *                           the account that answers it.
 *   ('machine',  null)      NO PERSON authored it, by design — a Stripe webhook,
 *                           the expiry sweep, the inference edge settling a
 *                           request. This is a POSITIVE value, not an absence.
 *   (null,       null)      the row PREDATES the column. Nothing else can
 *                           produce this state: {@link LedgerActor} is a
 *                           required field on `EntryInput`, the only insert
 *                           into this table, and the CHECK below refuses a
 *                           half-filled pair in either direction.
 *
 * Existing rows were NOT back-filled and never will be. Back-filling them
 * `'machine'` would be a claim nobody can support — those entries were written
 * before anything recorded authorship, so "no person authored it" and "we did
 * not record who did" are exactly the two readings the pair exists to separate.
 * A null `actor_kind` therefore means "written before 0046", which `created_at`
 * corroborates, and it means nothing else.
 *
 * `machine` is deliberately ONE value rather than a taxonomy of automations. An
 * automated writer's own attribution already lives on the document the entry is
 * about — a settlement names its reservation, which carries the application, the
 * credential and the request id; a top-up names its `billing_external_payments`
 * row, which carries the processor's reference. A second, shallower copy of that
 * on the entry would be a thing to keep in sync, not a thing to read.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList } from '@oxyhq/db';
import { billingInvoices } from './billingInvoices';
import { currencyCode, currencyCodeCheck, exactAmount } from './ledgerColumns';
import { usageReceipts } from './usageReceipts';
import { usageRefunds } from './usageRefunds';
import { usageReservations } from './usageReservations';
import { users } from './users';

/**
 * The chart of accounts. See the header for what each one means and which side
 * of the customer's books it sits on.
 */
export const LEDGER_ACCOUNTS = [
  'purchased_funds',
  'promotional_funds',
  'reserved_funds',
  'invoice_receivable',
  'external_settlement',
  'promotional_issuance',
  'platform_revenue',
] as const;

export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];

/**
 * The customer-side accounts a reservation may DRAW from, in the order it draws.
 *
 * Promotional money first. It is the balance that can expire and can never be
 * refunded, so any other order silently strands it — a customer who was granted
 * credit and then topped up would burn the money they paid for while the grant
 * timed out. This deliberately DIFFERS from `db/credits.ts`, which spends
 * purchased API credits before free ones; that is a different product with a
 * daily-refreshing free tier, where the same argument does not apply.
 *
 * `invoice_receivable` is last: an invoiced account draws against its credit
 * limit only once it has no prepaid or granted money left.
 *
 * The ORDER is load-bearing — `inferenceLedger.service.ts` computes the
 * settle/release split from a three-term expression written against exactly
 * these three accounts in exactly this order, and
 * `schema/__tests__/inferenceLedger.test.ts` asserts the tuple's contents and
 * LENGTH so a fourth account cannot be added without that expression being
 * revisited.
 */
export const RESERVATION_DRAW_ORDER = [
  'promotional_funds',
  'purchased_funds',
  'invoice_receivable',
] as const satisfies readonly LedgerAccount[];

export type ReservationDrawAccount = (typeof RESERVATION_DRAW_ORDER)[number];

/**
 * What a journal entry records. Distinct from the refund REASON, which is the
 * customer-facing explanation: `reservation_release` and `reservation_expiry`
 * both carry the reason `unused_reservation`, and only the entry kind says which
 * of the two happened.
 */
export const LEDGER_ENTRY_KINDS = [
  'top_up',
  'promotional_grant',
  'reservation_hold',
  'reservation_release',
  'reservation_expiry',
  'settlement',
  'settlement_reversal',
  'invoice_rounding',
  'invoice_payment',
] as const;

export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

/**
 * Who authored an entry. See "Who authored an entry" in the header for why
 * `machine` is a value rather than an absence, and why there are only two.
 */
export const LEDGER_ACTOR_KINDS = ['staff', 'machine'] as const;

export type LedgerActorKind = (typeof LEDGER_ACTOR_KINDS)[number];

/** A named platform staff member, from a staff-gated request. */
export interface StaffLedgerActor {
  readonly kind: 'staff';
  /** `users.id`. Required BY THE TYPE — a staff entry with no id is unwritable. */
  readonly userId: string;
}

/** No person authored this entry: a webhook, a sweep, or the inference edge. */
export interface MachineLedgerActor {
  readonly kind: 'machine';
}

/**
 * The author of one journal entry, as every writer must state it.
 *
 * A discriminated union rather than an optional id beside an optional kind: it
 * makes `{ kind: 'staff' }` with no user id a COMPILE error and
 * `{ kind: 'machine', userId }` an excess-property error, so the two column
 * states the CHECK constraint refuses cannot be constructed in the first place.
 * The constraint is the second line, for anything reaching the table by another
 * route.
 */
export type LedgerActor = StaffLedgerActor | MachineLedgerActor;

export const billingLedgerEntries = pgTable(
  'billing_ledger_entries',
  {
    id: generatedId(),

    /** Unique across the table. See "Idempotency" in the header. */
    idempotencyKey: text().notNull(),

    /** Whose books this entry belongs to. Always an account, never a user. */
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    currency: currencyCode(),

    kind: text({ enum: LEDGER_ENTRY_KINDS }).notNull(),

    // ---- what this entry is ABOUT ------------------------------------------
    // Each is a real foreign key to a table in this database, so "which
    // reservation did this release" is a join rather than a convention. All
    // `RESTRICT`: the documents are immutable and the journal must outlive any
    // attempt to remove one.
    reservationId: text().references(() => usageReservations.id, { onDelete: 'restrict' }),
    receiptId: text().references(() => usageReceipts.id, { onDelete: 'restrict' }),
    refundId: text().references(() => usageRefunds.id, { onDelete: 'restrict' }),
    invoiceId: text().references(() => billingInvoices.id, { onDelete: 'restrict' }),

    // ---- who AUTHORED this entry --------------------------------------------
    // Both nullable, and null in both means one specific thing: the row predates
    // 0046. See "Who authored an entry" in the header — this is the state that
    // must never be confused with `machine`, and the CHECK below is what stops
    // any other combination existing.
    actorKind: text({ enum: LEDGER_ACTOR_KINDS }),
    actorUserId: text().references(() => users.id, { onDelete: 'restrict' }),

    createdAt: createdAt(),
  },
  (t) => [
    unique('billing_ledger_entries_idempotency_key_key').on(t.idempotencyKey),

    // The account's journal, newest first — the reconciliation read and the
    // audit view.
    index('billing_ledger_entries_account_id_created_at_idx').on(
      t.accountId,
      t.createdAt.desc()
    ),
    // "What happened to this hold / this receipt", which the settle path reads
    // to recover a reservation's per-bucket draw.
    index('billing_ledger_entries_reservation_id_idx').on(t.reservationId),
    index('billing_ledger_entries_receipt_id_idx').on(t.receiptId),
    index('billing_ledger_entries_invoice_id_idx').on(t.invoiceId),
    // "Every entry this staff member authored" — the question the whole actor
    // pair exists to answer, and the one nobody asks until something has gone
    // wrong. Indexed deliberately: a missing index has no functional symptom at
    // all, so no test here could ever detect its absence.
    index('billing_ledger_entries_actor_user_id_idx').on(t.actorUserId),

    check(
      'billing_ledger_entries_kind_check',
      sql`${t.kind} in (${sql.raw(inList(LEDGER_ENTRY_KINDS))})`
    ),
    check('billing_ledger_entries_currency_check', currencyCodeCheck(t.currency)),
    // Each kind must name the document it is about. Written as an implication
    // per kind rather than as a biconditional: an entry may legitimately name
    // MORE than the minimum (a settlement names both its reservation and its
    // receipt), and a biconditional would reject that.
    check(
      'billing_ledger_entries_subject_check',
      sql`(${t.kind} not in ('reservation_hold', 'reservation_release', 'reservation_expiry')
             or ${t.reservationId} is not null)
        and (${t.kind} not in ('settlement', 'settlement_reversal') or ${t.receiptId} is not null)
        and (${t.kind} not in ('invoice_rounding', 'invoice_payment') or ${t.invoiceId} is not null)`
    ),
    // The actor pair, as a TOTAL disjunction over the three legal states rather
    // than as separate presence and vocabulary checks. Written this way because
    // the failure worth refusing is a HALF-FILLED pair in either direction: a
    // `staff` row with no id says a person authored it and declines to say who,
    // and a `machine` row carrying an id says nobody authored it and then names
    // them. Neither is expressible here, and neither is expressible in
    // {@link LedgerActor} either.
    //
    // The `(null, null)` branch is the grandfather clause and nothing else. It
    // admits rows written before this column existed; it is NOT a licence for a
    // new writer to omit an actor, which the required field on `EntryInput`
    // forbids at the only insert site in the codebase.
    //
    // Vocabulary is enforced by the same expression — each branch names its kind
    // as a literal, so a value outside `LEDGER_ACTOR_KINDS` satisfies no branch.
    //
    // `is not distinct from`, not `=`, and this is load-bearing rather than
    // stylistic: a CHECK rejects only FALSE, and `null = 'staff'` is NULL. Written
    // with `=`, the row `(actor_kind, actor_user_id) = (null, <a user id>)`
    // evaluates to `false or null or false` = NULL and is ACCEPTED — a person
    // named with no kind beside them, which is the one combination that would put
    // a real id where nothing says what it means. Measured: the test below caught
    // exactly that. `is not distinct from` returns a real boolean for a NULL
    // operand, so no branch can go unknown and the disjunction is total.
    check(
      'billing_ledger_entries_actor_check',
      sql`(${t.actorKind} is null and ${t.actorUserId} is null)
        or (${t.actorKind} is not distinct from 'staff' and ${t.actorUserId} is not null)
        or (${t.actorKind} is not distinct from 'machine' and ${t.actorUserId} is null)`
    ),
  ]
);

/**
 * One movement of value: `amount` leaves `source_account` and arrives at
 * `destination_account`.
 *
 * `sequence` orders the postings within an entry so a multi-bucket draw reads
 * back in the order it was applied — which is what
 * `inferenceLedger.service.ts`'s release split depends on, and what makes the
 * journal legible to a human reading one entry.
 */
export const billingLedgerPostings = pgTable(
  'billing_ledger_postings',
  {
    entryId: text()
      .notNull()
      .references(() => billingLedgerEntries.id, { onDelete: 'cascade' }),
    sequence: integer().notNull(),

    sourceAccount: text({ enum: LEDGER_ACCOUNTS }).notNull(),
    destinationAccount: text({ enum: LEDGER_ACCOUNTS }).notNull(),
    amount: exactAmount().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.sequence] }),

    // The projection reconciliation sums by account across the whole journal.
    index('billing_ledger_postings_source_account_idx').on(t.sourceAccount),
    index('billing_ledger_postings_destination_account_idx').on(t.destinationAccount),

    check(
      'billing_ledger_postings_source_account_check',
      sql`${t.sourceAccount} in (${sql.raw(inList(LEDGER_ACCOUNTS))})`
    ),
    check(
      'billing_ledger_postings_destination_account_check',
      sql`${t.destinationAccount} in (${sql.raw(inList(LEDGER_ACCOUNTS))})`
    ),
    // A posting from an account to itself moves nothing while inflating both
    // sides of every sum computed over this table.
    check(
      'billing_ledger_postings_distinct_accounts_check',
      sql`${t.sourceAccount} <> ${t.destinationAccount}`
    ),
    // Zero is not a movement, and a negative one would invert the transfer —
    // which is the entire reason direction is carried by the two account
    // columns rather than by a sign.
    check('billing_ledger_postings_amount_check', sql`${t.amount} > 0`),
    check('billing_ledger_postings_sequence_check', sql`${t.sequence} >= 0`),
  ]
);
