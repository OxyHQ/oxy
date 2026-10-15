/**
 * `kaana_grants`, `kaana_grant_steps`, `kaana_grant_admitted_lines` — every
 * grant Oxy signed for a request Kaana serves on `https://kaana.ai/v1`, and
 * what it settles against (Kaana ADR 0002, decisions 3 and 4).
 *
 * ## Why a grant is stored at all
 *
 * The grant travels to Kaana signed and comes back as a settlement that names
 * it by `grantId`, the served step and the measured units — never a price.
 * Oxy prices the settlement with the `priceVersionId` it admitted for the line
 * that served, so that admission has to be durable: a settlement may arrive
 * minutes later on another task, or through the reconciliation feed after a
 * restart. Storing the signed BYTES would not help (they are opaque to a
 * query); storing their digest plus the facts the settlement is checked
 * against does.
 *
 * ## Exactly once
 *
 * One grant settles once: `status` moves `issued → settled` (or `expired`) by a
 * compare-and-set, and `settlement_id` is unique. The ledger's own idempotency
 * key (`inference_metered_usage.idempotency_key`, the reservation's) makes a
 * redelivered settlement a no-op even if this row's update was the write that
 * was lost.
 *
 * ## No content
 *
 * Nothing here is a prompt, an output or a policy value Kaana could not
 * already read off the grant: ids, counts, hashes and prices.
 */

import { sql } from 'drizzle-orm';
import { USAGE_UNITS } from '@oxy.so/contracts';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz } from '@oxy.so/db';
import { applicationCredentials } from './applicationCredentials';
import { applications } from './applications';
import { inferenceMeteredUsage } from './inferenceMeteredUsage';
import { inferenceRoutingPolicyVersions } from './inferenceRoutingPolicyVersions';
import { currencyCodeCheck, exactAmount } from './ledgerColumns';
import { INFERENCE_ENVIRONMENTS, usageReservations } from './usageReservations';
import { users } from './users';

/**
 * `grantOperationSchema` of `@kaana.ai/contracts/internal`, as stored. Held
 * against the contract by `__tests__/kaanaGrants.schema.test.ts`.
 */
export const KAANA_GRANT_OPERATIONS = [
  'responses',
  'chat_completions',
  'embeddings',
  'audio_speech',
  'audio_transcriptions',
  'images_generations',
  'decisions',
  'realtime_session',
] as const;

/** `grantLaneSchema`, as stored. */
export const KAANA_GRANT_LANES = [
  'machine_credential',
  'service_token',
  'product_session',
] as const;

/** `inferenceFundingTierSchema`, as stored. */
export const KAANA_FUNDING_TIERS = ['free', 'credit', 'paid'] as const;

/**
 * `inferenceEconomicTreatmentSchema` of `@kaana.ai/contracts/internal`, as
 * stored: the metered-usage treatments plus `platform_fee_only` (BYOK), which
 * the grant names explicitly where the old edge carried it as a receipt flag.
 */
export const KAANA_GRANT_TREATMENTS = [
  'commercial',
  'internal_metered',
  'platform_fee_only',
] as const;

/** `issued` until a settlement or the reconciler closes it. */
export const KAANA_GRANT_STATUSES = ['issued', 'settled', 'expired'] as const;

/** A step targets a model line or a power level (`grantTargetSchema`). */
export const KAANA_GRANT_TARGET_KINDS = ['model', 'level'] as const;

export const kaanaGrants = pgTable(
  'kaana_grants',
  {
    /** The `grantId` Kaana settles by. */
    id: generatedId(),
    /** Kaana's `Kaana-Request-Id`; one grant per request. */
    requestId: text().notNull(),
    operation: text({ enum: KAANA_GRANT_OPERATIONS }).notNull(),
    /** The public path Kaana served, e.g. `/v1/responses`. */
    endpoint: text().notNull(),
    lane: text({ enum: KAANA_GRANT_LANES }).notNull(),

    /** The unresolved billing principal the grant names: the application's owner. */
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'restrict' }),
    applicationCredentialId: text()
      .notNull()
      .references(() => applicationCredentials.id, { onDelete: 'restrict' }),
    /** Attribution only, never the payer. */
    delegatedUserId: text(),
    environment: text({ enum: INFERENCE_ENVIRONMENTS }).notNull(),

    economicTreatment: text({ enum: KAANA_GRANT_TREATMENTS }).notNull(),
    economicPolicyVersion: text().notNull(),
    economicRelationshipId: text(),

    /** The durable usage row (and capacity slot) the grant claimed. */
    meteredUsageId: text()
      .notNull()
      .references(() => inferenceMeteredUsage.id, { onDelete: 'restrict' }),
    /** The hold; absent for `internal_metered`, which holds nothing. */
    reservationId: text().references(() => usageReservations.id, { onDelete: 'restrict' }),
    /**
     * The dearest admitted line's quote: what the hold was sized at. Absent only
     * for an `internal_metered` grant whose operation has no sound ceiling from
     * its facts (a realtime session: the authorization carries no duration).
     */
    ceilingAmount: exactAmount(),
    ceilingCurrency: text(),
    routingPolicyVersionId: text().references(() => inferenceRoutingPolicyVersions.id, {
      onDelete: 'restrict',
    }),

    /** Lowercase hex SHA-256 of the normalized request body the grant is bound to. */
    bodySha256: text().notNull(),
    /** Lowercase hex SHA-256 of the exact signed grant bytes. */
    grantSha256: text().notNull(),
    /** The Oxy edge key that signed it (`KAANA_EDGE_SIGNING_KEY_ID`). */
    signingKeyId: text().notNull(),
    issuedAt: timestamptz().notNull(),
    /** Kaana may START executing until then: `issuedAt` + 60 s. */
    executeBy: timestamptz().notNull(),
    /** When the hold and the capacity slot lapse if nothing settles. */
    expiresAt: timestamptz().notNull(),

    status: text({ enum: KAANA_GRANT_STATUSES }).notNull().default('issued'),
    /** Kaana's outbox row id; unique, so a second settlement id for one grant is visible. */
    settlementId: text(),
    settledAt: timestamptz(),
    /** The step that served, by position; absent when nothing was served. */
    servedStep: smallint(),
    /** Kaana served a model line the grant did not admit (`policy_violation`). */
    servedOutsideGrant: boolean(),
    /** The funding tier Kaana reports having spent (`usage.fundingTier`). */
    servedFundingTier: text({ enum: KAANA_FUNDING_TIERS }),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('kaana_grants_request_key').on(t.requestId),
    uniqueIndex('kaana_grants_metered_usage_key').on(t.meteredUsageId),
    uniqueIndex('kaana_grants_reservation_key').on(t.reservationId),
    uniqueIndex('kaana_grants_settlement_key').on(t.settlementId),
    index('kaana_grants_open_idx').on(t.status, t.expiresAt),
    check(
      'kaana_grants_operation_check',
      sql`${t.operation} in (${sql.raw(inList(KAANA_GRANT_OPERATIONS))})`,
    ),
    check('kaana_grants_lane_check', sql`${t.lane} in (${sql.raw(inList(KAANA_GRANT_LANES))})`),
    check(
      'kaana_grants_environment_check',
      sql`${t.environment} in (${sql.raw(inList(INFERENCE_ENVIRONMENTS))})`,
    ),
    check(
      'kaana_grants_treatment_check',
      sql`${t.economicTreatment} in (${sql.raw(inList(KAANA_GRANT_TREATMENTS))})`,
    ),
    check(
      'kaana_grants_status_check',
      sql`${t.status} in (${sql.raw(inList(KAANA_GRANT_STATUSES))})`,
    ),
    check(
      'kaana_grants_funding_tier_check',
      sql`${t.servedFundingTier} is null or ${t.servedFundingTier} in (${sql.raw(inList(KAANA_FUNDING_TIERS))})`,
    ),
    check(
      'kaana_grants_ceiling_check',
      sql`(${t.ceilingAmount} is null) = (${t.ceilingCurrency} is null)
        and (${t.ceilingCurrency} is null or ${currencyCodeCheck(t.ceilingCurrency)})
        and (${t.reservationId} is null or ${t.ceilingAmount} is not null)`,
    ),
    check(
      'kaana_grants_hashes_check',
      sql`${t.bodySha256} ~ '^[0-9a-f]{64}$' and ${t.grantSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'kaana_grants_window_check',
      sql`${t.executeBy} > ${t.issuedAt} and ${t.executeBy} <= ${t.issuedAt} + interval '60 seconds'
        and ${t.expiresAt} >= ${t.executeBy}`,
    ),
    // `internal_metered` holds nothing; every charged treatment carries its hold.
    check(
      'kaana_grants_reservation_check',
      sql`(${t.economicTreatment} = 'internal_metered') = (${t.reservationId} is null)`,
    ),
    // A settled grant names its settlement; an open one names none.
    check(
      'kaana_grants_settlement_check',
      sql`(${t.status} = 'settled') = (${t.settlementId} is not null and ${t.settledAt} is not null)
        and (${t.status} = 'settled' or (${t.servedStep} is null and ${t.servedOutsideGrant} is null
          and ${t.servedFundingTier} is null))`,
    ),
    check(
      'kaana_grants_served_step_check',
      sql`${t.servedStep} is null or ${t.servedStep} between 0 and 7`,
    ),
  ],
);

/** One step of a grant, in the order Kaana tries them. */
export const kaanaGrantSteps = pgTable(
  'kaana_grant_steps',
  {
    grantId: text()
      .notNull()
      .references(() => kaanaGrants.id, { onDelete: 'cascade' }),
    stepIndex: smallint().notNull(),
    targetKind: text({ enum: KAANA_GRANT_TARGET_KINDS }).notNull(),
    /** A model line (`publisher/model`, `@revision` when pinned) or a power level. */
    target: text().notNull(),
    /** The dearest tier Kaana may spend under this step; absent means no ceiling. */
    maxFundingTier: text({ enum: KAANA_FUNDING_TIERS }),
    maxPriceAmount: exactAmount(),
    maxPriceCurrency: text(),
  },
  (t) => [
    primaryKey({ columns: [t.grantId, t.stepIndex] }),
    check('kaana_grant_steps_index_check', sql`${t.stepIndex} between 0 and 7`),
    check(
      'kaana_grant_steps_target_kind_check',
      sql`${t.targetKind} in (${sql.raw(inList(KAANA_GRANT_TARGET_KINDS))})`,
    ),
    check(
      'kaana_grant_steps_funding_tier_check',
      sql`${t.maxFundingTier} is null or ${t.maxFundingTier} in (${sql.raw(inList(KAANA_FUNDING_TIERS))})`,
    ),
    check(
      'kaana_grant_steps_price_check',
      sql`(${t.maxPriceAmount} is null) = (${t.maxPriceCurrency} is null)
        and (${t.maxPriceCurrency} is null or ${currencyCodeCheck(t.maxPriceCurrency)})`,
    ),
  ],
);

/** A model line a step admits, at the price a settlement of it is billed at. */
export const kaanaGrantAdmittedLines = pgTable(
  'kaana_grant_admitted_lines',
  {
    grantId: text().notNull(),
    stepIndex: smallint().notNull(),
    /** `publisher/model`, never a revision: Kaana serves the line's current one. */
    modelLine: text().notNull(),
    /**
     * Kaana's `priceVersionId` for the line's declared list price
     * (`declaredCatalogue`, contract set 4.3.0). A label, not a key: Oxy owns no
     * table that resolves it. The list itself is {@link kaanaGrantLineUnitPrices}.
     */
    priceVersionId: text().notNull(),
    currency: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.grantId, t.stepIndex, t.modelLine] }),
    foreignKey({
      name: 'kaana_grant_admitted_lines_step_fk',
      columns: [t.grantId, t.stepIndex],
      foreignColumns: [kaanaGrantSteps.grantId, kaanaGrantSteps.stepIndex],
    }).onDelete('cascade'),
    index('kaana_grant_admitted_lines_price_idx').on(t.priceVersionId),
    check('kaana_grant_admitted_lines_currency_check', currencyCodeCheck(t.currency)),
  ],
);

/**
 * The unit prices of an admitted line, COPIED from Kaana's declared catalogue
 * when the grant was signed.
 *
 * This is the grant's own evidence, not a catalogue: the settlement of the
 * grant is rated at exactly these entries, whatever Kaana has declared since,
 * and never at a row of Oxy's `price_versions`. It is the same discipline as
 * `usage_receipt_unit_prices` — what a charge is computed from is copied onto
 * the record that charges it. A line with no entry for a unit it is settled in
 * is a settlement Oxy rejects (`unpriced_unit`); a unit is never free by
 * absence.
 */
export const kaanaGrantLineUnitPrices = pgTable(
  'kaana_grant_line_unit_prices',
  {
    grantId: text().notNull(),
    stepIndex: smallint().notNull(),
    modelLine: text().notNull(),
    unit: text({ enum: USAGE_UNITS }).notNull(),
    /** Price for `per` units of `unit`, in the line's currency. */
    amount: exactAmount().notNull(),
    per: bigint({ mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.grantId, t.stepIndex, t.modelLine, t.unit] }),
    foreignKey({
      name: 'kaana_grant_line_unit_prices_line_fk',
      columns: [t.grantId, t.stepIndex, t.modelLine],
      foreignColumns: [
        kaanaGrantAdmittedLines.grantId,
        kaanaGrantAdmittedLines.stepIndex,
        kaanaGrantAdmittedLines.modelLine,
      ],
    }).onDelete('cascade'),
    check('kaana_grant_line_unit_prices_amount_check', sql`${t.amount} >= 0`),
    check('kaana_grant_line_unit_prices_per_check', sql`${t.per} > 0`),
  ],
);

export type KaanaGrantRow = typeof kaanaGrants.$inferSelect;
