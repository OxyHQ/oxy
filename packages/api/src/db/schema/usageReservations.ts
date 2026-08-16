/**
 * `usage_reservations` — the hold placed before a request enters the data plane.
 *
 * ADR 0009's first step: `ceiling = f(input units, max output units, allowed
 * route price ceiling)`, checked against the account's available balance, and
 * refused BEFORE anything is forwarded. A request that cannot be paid for is
 * discovered before the provider has been billed, not after.
 *
 * ## Attribution is stored as FIELDS, not as the wire envelope
 *
 * ADR 0007's tuple — account, application, credential, optional delegated user,
 * request id — is stored as real columns with real foreign keys. Two things
 * from the wire `attribution` block are deliberately NOT stored:
 *
 *  - **the credential's effective scopes.** They are an authorization fact of
 *    the moment the request was admitted, not a financial one, and a stale copy
 *    on a financial record is exactly the kind of value someone eventually reads
 *    as authority. The edge holds the live set; the ledger holds the money.
 *  - **`generation_id`**, which does not exist yet at reserve time — the data
 *    plane allocates it once a generation exists. It lands on the receipt.
 *
 * `environment` IS stored, because it is a property of the credential AT THE
 * TIME and a later rotation must not re-label historical spend.
 *
 * ## There is no `settled_receipt_id`
 *
 * The wire contract carries one; this table does not, and that is on purpose.
 * `usage_receipts.reservation_id` is UNIQUE, so the link already exists in one
 * direction and a second copy could disagree with it. Storing both would also
 * make `usage_reservations` ⇄ `usage_receipts` a circular foreign key, which
 * this repo has already had silently dropped from a generated migration and its
 * snapshot once. The serializer derives it.
 *
 * ## Idempotency
 *
 * `idempotency_key` is UNIQUE and supplied by the caller (ADR 0009 keys a
 * reservation on the edge's `requestId`). A retried reserve conflicts and
 * returns the original hold rather than taking a second one — implemented as
 * `ON CONFLICT … DO NOTHING RETURNING`, never as catch-the-duplicate, because a
 * duplicate key and a dropped connection are indistinguishable inside a `catch`.
 *
 * ## `ON DELETE RESTRICT` on every attribution key
 *
 * A hold is money. Deleting the account, application or credential it names must
 * not silently delete the record of it — the same posture
 * `billing_transactions` has taken since the Postgres port, so an account with
 * financial history already required an explicit erasure decision before this
 * table existed.
 *
 * ## Expiry is a REFUND, never a sweep
 *
 * `expires_at` is not registered in `db/expiry.ts` and must never be. A
 * past-deadline hold is released by `expireReservations` in
 * `services/inferenceLedger.service.ts`, which writes the releasing ledger
 * entries and a `usage_refunds` row with a reason. Deleting the row instead
 * would silently release the money with no record that it happened — and would
 * leave `account_balances.reserved_balance` permanently overstated.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import {
  inferenceEnvironmentSchema,
  usageReservationStatusSchema,
} from '@oxyhq/contracts';
import { applicationCredentials } from './applicationCredentials';
import { applications } from './applications';
import {
  currencyCode,
  currencyCodeCheck,
  exactAmount,
  usageUnitColumns,
  usageUnitsNonNegativeCheck,
} from './ledgerColumns';
import { priceVersions } from './priceVersions';
import { users } from './users';

/** `held | settled | released | expired`, from the wire contract's own enum. */
export const USAGE_RESERVATION_STATUSES = usageReservationStatusSchema.options;

/** `development | staging | production` — the credential's environment. */
export const INFERENCE_ENVIRONMENTS = inferenceEnvironmentSchema.options;

/**
 * How often `expireReservations` looks for past-deadline holds.
 *
 * One minute, matching `FOLLOW_EXPIRY_SWEEP_INTERVAL_MS` — this is the only
 * number that decides how long a customer's money stays withheld after the
 * request it was withheld for is provably dead. `expires_at` is the promise
 * ("this hold lapses then"); the interval is how far past that promise the
 * balance can stay depressed, so it belongs well below the shortest deadline an
 * edge would ever set rather than merely below the longest.
 *
 * Nothing about correctness depends on it. A missed tick delays a release; it
 * cannot cause a double one, because `expireReservations` serializes on the
 * account's balance row, re-reads the status under that lock, and keys the
 * refund on the reservation id — see that function's own doc comment.
 */
export const RESERVATION_EXPIRY_SWEEP_INTERVAL_MS = 60 * 1000;

export const usageReservations = pgTable(
  'usage_reservations',
  {
    id: generatedId(),

    /** Caller-supplied. A retry with the same key returns the original hold. */
    idempotencyKey: text().notNull(),

    // ---- attribution (ADR 0007) --------------------------------------------
    /** The financially responsible account. Never the delegated user. */
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'restrict' }),
    applicationCredentialId: text()
      .notNull()
      .references(() => applicationCredentials.id, { onDelete: 'restrict' }),
    /**
     * The end user a first-party service is acting FOR. Attribution only — it
     * never appears in a balance check or as the payer. Deliberately carries no
     * foreign key; see `deferredForeignKeys.ts` for the reason, which is about
     * that user's own right to be erased.
     */
    delegatedUserId: text(),
    /** The edge's correlation key, unchanged from admission to receipt. */
    requestId: text().notNull(),
    environment: text({ enum: INFERENCE_ENVIRONMENTS }).notNull(),

    // ---- the hold ----------------------------------------------------------
    status: text({ enum: USAGE_RESERVATION_STATUSES }).notNull().default('held'),
    reservedAmount: exactAmount().notNull(),
    currency: currencyCode(),
    /**
     * The price version of the most expensive route the policy permits — the
     * one the ceiling was computed from. `RESTRICT`, because a price version
     * that sized a live hold must remain resolvable.
     */
    ceilingPriceVersionId: text()
      .notNull()
      .references(() => priceVersions.id, { onDelete: 'restrict' }),
    /** The ceiling on generated output, when the request set one. */
    maxOutputTokens: bigint({ mode: 'number' }),

    /** Units already determined by the request itself, e.g. input tokens. */
    ...usageUnitColumns(),

    expiresAt: timestamptz().notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('usage_reservations_idempotency_key_key').on(t.idempotencyKey),

    // The expiry pass: held holds whose deadline has passed, oldest first.
    index('usage_reservations_status_expires_at_idx').on(t.status, t.expiresAt),
    // "What is this account currently holding", and the reconciliation query.
    index('usage_reservations_account_id_created_at_idx').on(t.accountId, t.createdAt.desc()),
    // Correlating a data-plane request back to its hold.
    index('usage_reservations_request_id_idx').on(t.requestId),

    check(
      'usage_reservations_status_check',
      sql`${t.status} in (${sql.raw(inList(USAGE_RESERVATION_STATUSES))})`
    ),
    check(
      'usage_reservations_environment_check',
      sql`${t.environment} in (${sql.raw(inList(INFERENCE_ENVIRONMENTS))})`
    ),
    check('usage_reservations_currency_check', currencyCodeCheck(t.currency)),
    // A hold of zero authorises nothing and would let an unpriced request
    // through the balance check as if it had been authorised.
    check('usage_reservations_reserved_amount_check', sql`${t.reservedAmount} > 0`),
    check(
      'usage_reservations_max_output_tokens_check',
      sql`${t.maxOutputTokens} is null or ${t.maxOutputTokens} > 0`
    ),
    check('usage_reservations_request_id_check', sql`length(${t.requestId}) > 0`),
    usageUnitsNonNegativeCheck('usage_reservations_units_check', t),
  ]
);
