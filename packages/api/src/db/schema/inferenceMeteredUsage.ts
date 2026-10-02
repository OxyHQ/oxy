/**
 * `inference_metered_usage` — one durable usage record per admitted inference
 * request, independent of the financial ledger (issue #1526, plan item I09).
 *
 * ## Why a record beside the receipt, not instead of it
 *
 * `usage_receipts` is the FINANCIAL record: it exists only when a hold was
 * settled, and its amount is what a customer was charged. An
 * `internal_metered` request (Alia → Kaana) has no hold and must never have a
 * receipt — and a shadow-metered commercial request has none either — so a
 * report built on receipts alone cannot see their usage or their cost. This
 * table is the usage record for EVERY admitted request, whatever its economic
 * treatment, and links the receipt only when one exists.
 *
 * `inference_usage_events` is best-effort telemetry with a 90-day retention;
 * this row is written on the admission path and is what idempotency and
 * technical capacity are enforced on, so it is not best-effort.
 *
 * ## Idempotency without a hold
 *
 * `idempotency_key` is the edge's ledger key. It is unique across every row
 * that was not refused before execution, so two concurrent requests carrying
 * one key cannot both execute — the property a reservation used to provide
 * only when a reservation was taken.
 *
 * ## Snapshots, not references to mutable facts
 *
 * The economic policy version, the cost centre and the tariff amount are
 * copied at the moment they were decided. A later price change, a re-labelled
 * cost centre or a new policy version never rewrites what an old row says.
 * An unpriced tariff is `tariff_status = 'unpriced'` with a NULL amount —
 * unknown, never zero.
 *
 * ## No provider cost here
 *
 * What the upstream invoiced arrives per ATTEMPT from Kaana's operator feed
 * (`inference_provider_cost_attempts`) and correlates on `request_id`. A failed
 * failover attempt is on Kaana's cost and on no customer receipt, which is
 * exactly why it is not a column on a per-request row.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz } from '@oxy.so/db';
import { INFERENCE_ECONOMIC_TREATMENTS } from '@oxy.so/contracts';
import { applicationCredentials } from './applicationCredentials';
import { applications } from './applications';
import { inferenceRoutingPolicyVersions } from './inferenceRoutingPolicyVersions';
import {
  currencyCodeCheck,
  exactAmount,
  usageUnitColumns,
  usageUnitsNonNegativeCheck,
} from './ledgerColumns';
import { priceVersions } from './priceVersions';
import { INFERENCE_REQUEST_OUTCOMES, USAGE_SOURCE_VALUES, usageReceipts } from './usageReceipts';
import { INFERENCE_ENVIRONMENTS } from './usageReservations';
import { users } from './users';

export const ECONOMIC_TREATMENT_VALUES = INFERENCE_ECONOMIC_TREATMENTS;

/**
 * `admitted` — claimed, possibly executing. `settled` — terminal, usage written.
 * `refused` — refused before anything was forwarded (a commercial reservation
 * the ledger declined); it holds no idempotency key and no capacity.
 */
export const METERED_USAGE_STATUSES = ['admitted', 'settled', 'refused'] as const;

/** Whether the tariff snapshot could be computed from the pinned price version. */
export const TARIFF_STATUSES = ['quoted', 'unpriced'] as const;

export const inferenceMeteredUsage = pgTable(
  'inference_metered_usage',
  {
    id: generatedId(),

    requestId: text().notNull(),
    /** Authenticated Auto classifier lineage; never supplied by a public request. */
    parentRequestId: text(),
    /** The edge's ledger key. Unique among rows that were not refused. */
    idempotencyKey: text().notNull(),

    economicTreatment: text({ enum: ECONOMIC_TREATMENT_VALUES }).notNull(),
    /** `INFERENCE_ECONOMIC_POLICY_VERSION` at admission. */
    economicPolicyVersion: text().notNull(),
    /** The configured relationship an `internal_metered` row was admitted under. */
    economicRelationshipId: text(),

    // ---- attribution (ADR 0007), as the edge authenticated it ---------------
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'restrict' }),
    applicationCredentialId: text()
      .notNull()
      .references(() => applicationCredentials.id, { onDelete: 'restrict' }),
    /** Attribution only, never the payer and never the treatment. */
    delegatedUserId: text(),
    environment: text({ enum: INFERENCE_ENVIRONMENTS }).notNull(),
    /**
     * The nearest active cost centre above the application's owner account at
     * admission, snapshotted. `RESTRICT` like every billing-family reference.
     */
    costCenterAccountId: text().references(() => users.id, { onDelete: 'restrict' }),
    endpoint: text().notNull(),

    // ---- what was admitted --------------------------------------------------
    requestedModelReference: text().notNull(),
    admittedModelReference: text().notNull(),
    admittedProvider: text().notNull(),
    admittedDeploymentId: text().notNull(),
    routingPolicyVersionId: text().references(() => inferenceRoutingPolicyVersions.id, {
      onDelete: 'restrict',
    }),
    /** The most expensive authorized route's quote: what a hold WOULD have been. */
    ceilingAmount: exactAmount(),
    ceilingCurrency: text(),

    /** Final authorization after Auto requalification; the initial admission stays immutable. */
    finalAuthorizedModelReference: text(),
    finalAuthorizedProvider: text(),
    finalAuthorizedDeploymentId: text(),
    finalAuthorizedCeilingAmount: exactAmount(),
    finalAuthorizedCeilingCurrency: text(),

    status: text({ enum: METERED_USAGE_STATUSES }).notNull().default('admitted'),
    /** The in-flight deadline capacity counts against; a hold's TTL, without a hold. */
    expiresAt: timestamptz().notNull(),

    // ---- what happened (written once, at settlement) ------------------------
    outcome: text({ enum: INFERENCE_REQUEST_OUTCOMES }),
    usageSource: text({ enum: USAGE_SOURCE_VALUES }),
    ...usageUnitColumns(),
    resolvedModelReference: text(),
    servingProvider: text(),
    generationId: text(),
    settledPriceVersionId: text().references(() => priceVersions.id, { onDelete: 'restrict' }),
    tariffStatus: text({ enum: TARIFF_STATUSES }),
    tariffAmount: exactAmount(),
    tariffCurrency: text(),
    /** The receipt, when — and only when — a customer was actually charged. */
    usageReceiptId: text().references(() => usageReceipts.id, { onDelete: 'restrict' }),

    createdAt: createdAt(),
    settledAt: timestamptz(),
  },
  (t) => [
    uniqueIndex('inference_metered_usage_request_key').on(t.requestId),
    // One execution per key. Refused rows are excluded so a key whose request
    // was refused before forwarding stays usable, exactly as with a reservation.
    uniqueIndex('inference_metered_usage_idempotency_key')
      .on(t.idempotencyKey)
      .where(sql`${t.status} <> 'refused'`),
    // Capacity: in-flight and per-day counts for one application + environment.
    index('inference_metered_usage_capacity_idx').on(
      t.applicationId,
      t.environment,
      t.status,
      t.createdAt
    ),
    index('inference_metered_usage_settled_idx').on(t.settledAt),
    index('inference_metered_usage_parent_idx').on(t.parentRequestId),
    check('inference_metered_usage_parent_check',
      sql`${t.parentRequestId} is null or (${t.parentRequestId} <> ${t.requestId} and length(${t.parentRequestId}) > 0)`),
    check('inference_metered_usage_final_authorization_check',
      sql`(${t.finalAuthorizedModelReference} is null and ${t.finalAuthorizedProvider} is null
        and ${t.finalAuthorizedDeploymentId} is null and ${t.finalAuthorizedCeilingAmount} is null
        and ${t.finalAuthorizedCeilingCurrency} is null) or
        (${t.finalAuthorizedModelReference} is not null and ${t.finalAuthorizedProvider} is not null
        and ${t.finalAuthorizedDeploymentId} is not null
        and (${t.finalAuthorizedCeilingAmount} is null) = (${t.finalAuthorizedCeilingCurrency} is null)
        and (${t.finalAuthorizedCeilingCurrency} is null or ${currencyCodeCheck(t.finalAuthorizedCeilingCurrency)}))`),

    check(
      'inference_metered_usage_treatment_check',
      sql`${t.economicTreatment} in (${sql.raw(inList(ECONOMIC_TREATMENT_VALUES))})`
    ),
    check(
      'inference_metered_usage_status_check',
      sql`${t.status} in (${sql.raw(inList(METERED_USAGE_STATUSES))})`
    ),
    check(
      'inference_metered_usage_environment_check',
      sql`${t.environment} in (${sql.raw(inList(INFERENCE_ENVIRONMENTS))})`
    ),
    check(
      'inference_metered_usage_outcome_check',
      sql`${t.outcome} is null or ${t.outcome} in (${sql.raw(inList(INFERENCE_REQUEST_OUTCOMES))})`
    ),
    check(
      'inference_metered_usage_usage_source_check',
      sql`${t.usageSource} is null or ${t.usageSource} in (${sql.raw(inList(USAGE_SOURCE_VALUES))})`
    ),
    check(
      'inference_metered_usage_tariff_status_check',
      sql`${t.tariffStatus} is null or ${t.tariffStatus} in (${sql.raw(inList(TARIFF_STATUSES))})`
    ),
    // An internal relationship is named exactly when the row is internal.
    check(
      'inference_metered_usage_relationship_check',
      sql`(${t.economicTreatment} = 'internal_metered') = (${t.economicRelationshipId} is not null)`
    ),
    // An internal request has no receipt, ever: it was never charged.
    check(
      'inference_metered_usage_internal_uncharged_check',
      sql`${t.economicTreatment} <> 'internal_metered' or ${t.usageReceiptId} is null`
    ),
    // Settled ⇔ outcome, source and settlement time are all present.
    check(
      'inference_metered_usage_settled_check',
      sql`(${t.status} = 'settled') = (${t.outcome} is not null and ${t.usageSource} is not null and ${t.settledAt} is not null)`
    ),
    // A quoted tariff has an amount and currency; an unpriced one has neither.
    check(
      'inference_metered_usage_tariff_check',
      sql`(${t.tariffStatus} = 'quoted') = (${t.tariffAmount} is not null and ${t.tariffCurrency} is not null)
        and (${t.tariffStatus} is not null or (${t.tariffAmount} is null and ${t.tariffCurrency} is null))`
    ),
    check(
      'inference_metered_usage_tariff_currency_check',
      sql`${t.tariffCurrency} is null or ${currencyCodeCheck(t.tariffCurrency)}`
    ),
    check(
      'inference_metered_usage_ceiling_currency_check',
      sql`(${t.ceilingAmount} is null) = (${t.ceilingCurrency} is null)
        and (${t.ceilingCurrency} is null or ${currencyCodeCheck(t.ceilingCurrency)})`
    ),
    usageUnitsNonNegativeCheck('inference_metered_usage_units_check', t),
  ]
);

export type InferenceMeteredUsageRow = typeof inferenceMeteredUsage.$inferSelect;
