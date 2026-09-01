/**
 * `usage_receipts` + `usage_receipt_unit_prices` — the immutable settlement.
 *
 * ADR 0009's third step, and the record every customer-visible billed amount is
 * read from. **Telemetry is never summed to produce a bill**
 * (`inference_usage_events` carries no money column at all, which is what makes
 * that structural rather than a convention).
 *
 * ## Immutable, by trigger
 *
 * A settled receipt is never updated and never deleted. That is enforced by
 * `LEDGER_IMMUTABILITY_DDL` (`db/schema/ledgerImmutability.ts`), applied by its
 * own migration, because a CHECK constraint sees only the new row and never the
 * old one and therefore cannot express "nothing changed". The absence of an
 * `updated_at` column is the visible half of the same contract.
 *
 * A correction is a compensating record: a `usage_refunds` row for an
 * overcharge, or a supplementary receipt naming `corrects_receipt_id` for an
 * undercharge. Never an edit — a mutated financial record cannot be
 * distinguished from a correct one after the fact.
 *
 * ## The price SNAPSHOT is a copy, not just a reference
 *
 * `price_version_id` says which version priced this receipt;
 * `usage_receipt_unit_prices` COPIES the unit prices that were applied. Both,
 * not either:
 *
 *  - the copy makes the arithmetic on this receipt checkable years later
 *    without depending on any other record still existing, and checkable IN SQL
 *    (`sum(amount * quantity / per)`) rather than by re-implementing the
 *    calculation in application code — a test that re-implements the code under
 *    test measures the re-implementation;
 *  - the reference makes a mistake in the copy VISIBLE, as a disagreement with
 *    the version it names, instead of silently invisible.
 *
 * ## Units
 *
 * Stored as the fixed columns `ledgerColumns.ts` declares, separately from the
 * money they priced into. The contract's `units.min(1)` refinement has no
 * counterpart in the column form (all eleven are always present), and a
 * zero-unit receipt is legitimate: ADR 0009 settles ZERO for an upstream failure
 * that produced nothing. What does need guarding is the other direction, and it
 * has its own CHECK — an amount billed against no metered units at all.
 *
 * ## `usage_source` is load-bearing
 *
 * `provider_reported`, `oxy_measured` and `estimated` are not interchangeable
 * when a charge is disputed. An `estimated` receipt is one the provider returned
 * no usage for, settled from Oxy's own measurement and reconcilable later; an
 * estimate indistinguishable from a reported figure is one nobody can reconcile.
 * The estimation POLICY is the edge's (it measures); this table's job is to
 * record which of the three produced the number, and never to let a
 * reconstruction pass as fact.
 *
 * ## `platform_fee_only`
 *
 * A BYOK request: the upstream provider billed the customer's own account
 * directly and `billed_amount` is Oxy's service fee, not the cost of the tokens.
 * Without the flag the two look identical and a BYOK customer appears to have
 * been charged twice for one request.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz } from '@oxyhq/db';
import {
  inferenceRequestOutcomeSchema,
  usageSourceSchema,
  USAGE_UNITS,
} from '@oxyhq/contracts';
import { applicationCredentials } from './applicationCredentials';
import { applications } from './applications';
import { inferenceRoutingPolicyVersions } from './inferenceRoutingPolicyVersions';
import {
  currencyCode,
  currencyCodeCheck,
  exactAmount,
  totalUsageUnitsExpression,
  usageUnitColumns,
  usageUnitsNonNegativeCheck,
} from './ledgerColumns';
import { INFERENCE_ENVIRONMENTS, usageReservations } from './usageReservations';
import { priceVersions } from './priceVersions';
import { users } from './users';

/** `completed | partial | cancelled | failed`, from the wire contract. */
export const INFERENCE_REQUEST_OUTCOMES = inferenceRequestOutcomeSchema.options;

/** `provider_reported | oxy_measured | estimated`, from the wire contract. */
export const USAGE_SOURCE_VALUES = usageSourceSchema.options;

export const usageReceipts = pgTable(
  'usage_receipts',
  {
    id: generatedId(),

    /** Caller-supplied. A retried settle returns the original receipt. */
    idempotencyKey: text().notNull(),

    /**
     * The hold this settled against. Absent for a charge with no reservation —
     * shadow metering before charging is switched on, and a BYOK platform fee
     * whose upstream cost was never held.
     *
     * UNIQUE: one receipt per hold, which is also what makes
     * `usage_reservations` need no `settled_receipt_id` column of its own.
     */
    reservationId: text().references(() => usageReservations.id, { onDelete: 'restrict' }),

    /**
     * A supplementary receipt correcting an earlier one upward — the append-only
     * counterpart of a refund. A SELF-reference, so it carries the explicit
     * `AnyPgColumn` annotation drizzle needs, and
     * `schema/__tests__/inferenceLedger.test.ts` asserts the constraint reached
     * `pg_constraint`: a column-level circular reference has been silently
     * dropped from a generated migration in this repo before.
     */
    correctsReceiptId: text().references((): AnyPgColumn => usageReceipts.id, {
      onDelete: 'restrict',
    }),

    // ---- attribution (ADR 0007) --------------------------------------------
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'restrict' }),
    applicationCredentialId: text()
      .notNull()
      .references(() => applicationCredentials.id, { onDelete: 'restrict' }),
    /** Attribution only, never the payer. No foreign key — see `deferredForeignKeys.ts`. */
    delegatedUserId: text(),
    requestId: text().notNull(),
    /** One generated output within a request, when the data plane allocated one. */
    generationId: text(),
    environment: text({ enum: INFERENCE_ENVIRONMENTS }).notNull(),

    // ---- what happened -----------------------------------------------------
    outcome: text({ enum: INFERENCE_REQUEST_OUTCOMES }).notNull(),
    usageSource: text({ enum: USAGE_SOURCE_VALUES }).notNull(),
    ...usageUnitColumns(),

    /** The route that actually served it, as the customer may be shown it. */
    resolvedModelReference: text().notNull(),
    servingProvider: text().notNull(),

    /**
     * The exact routing policy revision this request executed under (#972
     * workstream 6).
     *
     * A receipt names the amount; this names the CONFIGURATION that chose the
     * route the amount was incurred on. `inference_routing_policy_versions` is
     * append-only, so the reference resolves to the constraints that were in
     * force at settlement rather than to whatever the customer most recently
     * saved — which is the whole reason routing policies are versioned at all.
     *
     * `RESTRICT`: a policy version a charge names cannot be deleted, which is the
     * other half of "immutable once referenced".
     *
     * NULLABLE, and deliberately so for now. The writer that will always have a
     * policy version to supply is the public inference edge (workstream 4), which
     * does not exist yet; every settle path that exists today is a ledger or
     * shadow-metering path that has no request envelope to read one from. Making
     * it NOT NULL now would force those callers to invent a value, and an
     * invented policy reference on a financial record is worse than an absent
     * one. Tightening it belongs with the edge landing — and it can be tightened
     * safely because the column is being added to a table that holds no
     * production rows.
     */
    routingPolicyVersionId: text().references(() => inferenceRoutingPolicyVersions.id, {
      onDelete: 'restrict',
    }),

    // ---- what it cost ------------------------------------------------------
    priceVersionId: text()
      .notNull()
      .references(() => priceVersions.id, { onDelete: 'restrict' }),
    billedAmount: exactAmount().notNull(),
    currency: currencyCode(),
    platformFeeOnly: boolean().notNull().default(false),

    settledAt: timestamptz().notNull(),

    /**
     * No `updated_at`. The absence IS the append-only contract, and
     * `LEDGER_IMMUTABILITY_DDL` is what enforces it against a write that ignores
     * the convention.
     */
    createdAt: createdAt(),
  },
  (t) => [
    unique('usage_receipts_idempotency_key_key').on(t.idempotencyKey),
    unique('usage_receipts_reservation_id_key').on(t.reservationId),

    // The account's spend history, and the invoice period scan.
    index('usage_receipts_account_id_settled_at_idx').on(t.accountId, t.settledAt.desc()),
    // Per-application and per-credential spend, the two Console breakdowns that
    // read money rather than telemetry.
    index('usage_receipts_application_id_settled_at_idx').on(
      t.applicationId,
      t.settledAt.desc()
    ),
    index('usage_receipts_application_credential_id_settled_at_idx').on(
      t.applicationCredentialId,
      t.settledAt.desc()
    ),
    // `GET /v1/generations/:id` and the request-id correlation ADR 0007 requires
    // across the edge, the data plane, the ledger and the customer receipt.
    index('usage_receipts_request_id_idx').on(t.requestId),
    index('usage_receipts_generation_id_idx').on(t.generationId),
    // "Which charges ran under this policy version" — the question a customer
    // asks after changing a policy, and the one an audit of a routing decision
    // starts from. Partial, because the column is nullable while the edge that
    // populates it is still being built.
    index('usage_receipts_routing_policy_version_id_idx')
      .on(t.routingPolicyVersionId)
      .where(sql`${t.routingPolicyVersionId} is not null`),
    // Settlements whose usage the data plane never reported: settled at ZERO with
    // the refund reason `usage_unavailable`, so the customer was not charged and
    // Oxy absorbed the upstream cost. Partial, because they are a small minority
    // of a large table.
    //
    // This was described as "the reconciliation queue: estimated receipts awaiting
    // a provider's real figures", and that was aspirational in a way worth
    // correcting: no ingestion path exists for a provider's retrospective usage,
    // so nothing arrives to reconcile these against and no job drains them. Read
    // by `services/inferenceMetrics.service.ts` (`unmeasuredSettlements` on the
    // staff metrics surface), which uses exactly this shape — same predicate,
    // ranging on the same leading column. A rising count means the data plane is
    // losing usage reports, not that a backlog is building.
    index('usage_receipts_estimated_idx')
      .on(t.settledAt)
      .where(sql`${t.usageSource} = 'estimated'`),

    check(
      'usage_receipts_outcome_check',
      sql`${t.outcome} in (${sql.raw(inList(INFERENCE_REQUEST_OUTCOMES))})`
    ),
    check(
      'usage_receipts_usage_source_check',
      sql`${t.usageSource} in (${sql.raw(inList(USAGE_SOURCE_VALUES))})`
    ),
    check(
      'usage_receipts_environment_check',
      sql`${t.environment} in (${sql.raw(inList(INFERENCE_ENVIRONMENTS))})`
    ),
    check('usage_receipts_currency_check', currencyCodeCheck(t.currency)),
    check('usage_receipts_billed_amount_check', sql`${t.billedAmount} >= 0`),
    usageUnitsNonNegativeCheck('usage_receipts_units_check', t),
    // An amount billed against nothing metered. Zero units and zero money is a
    // legitimate receipt (a failed request that produced no output); zero units
    // and a non-zero charge is a pricing bug, and it is the direction that costs
    // a customer money.
    check(
      'usage_receipts_billed_units_check',
      sql`${t.billedAmount} = 0 or (${totalUsageUnitsExpression(t)}) > 0`
    ),
    check('usage_receipts_request_id_check', sql`length(${t.requestId}) > 0`),
    check(
      'usage_receipts_resolved_model_reference_check',
      sql`length(${t.resolvedModelReference}) > 0`
    ),
    check('usage_receipts_serving_provider_check', sql`length(${t.servingProvider}) > 0`),
    // A receipt cannot correct itself; the correction chain would never
    // terminate.
    check(
      'usage_receipts_corrects_self_check',
      sql`${t.correctsReceiptId} is null or ${t.correctsReceiptId} <> ${t.id}`
    ),
  ]
);

/**
 * The price snapshot a settled receipt keeps — a COPY of the unit prices that
 * were applied, not a view onto `price_version_unit_prices`.
 *
 * `CASCADE` rather than `RESTRICT`, and it is inert either way: the parent is
 * immutable and never deleted, so the action expresses ownership rather than
 * guarding anything.
 */
export const usageReceiptUnitPrices = pgTable(
  'usage_receipt_unit_prices',
  {
    receiptId: text()
      .notNull()
      .references(() => usageReceipts.id, { onDelete: 'cascade' }),
    unit: text({ enum: USAGE_UNITS }).notNull(),
    amount: exactAmount().notNull(),
    per: bigint({ mode: 'number' }).notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.receiptId, t.unit] }),

    check(
      'usage_receipt_unit_prices_unit_check',
      sql`${t.unit} in (${sql.raw(inList(USAGE_UNITS))})`
    ),
    check('usage_receipt_unit_prices_amount_check', sql`${t.amount} >= 0`),
    check('usage_receipt_unit_prices_per_check', sql`${t.per} > 0`),
  ]
);
