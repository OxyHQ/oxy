/**
 * `inference_provider_cost_attempts` — what each upstream attempt cost Kaana,
 * read from Kaana's signed operator feed (issue #1526, plan item I09).
 *
 * Kaana records every platform-funded upstream attempt as one
 * `provider_cost_events` row keyed by `(request_id, attempt_index)` and serves
 * them oldest first on `POST /internal/v1/provider-telemetry/attempts`
 * (Kaana `docs/cost.md`). This table is Oxy's copy, keyed the same way, so a
 * page read twice — a retry, two API tasks racing, a cursor that did not
 * advance — inserts nothing the second time.
 *
 * ## A replay that DIFFERS is not an update
 *
 * `facts_digest` is the SHA-256 of the canonical attempt facts. A redelivered
 * attempt with the same key and a different digest is refused and logged,
 * never overwritten: Kaana itself fails closed on that case, and a cost that
 * silently changed after it was read is a reconciliation nobody could trust.
 *
 * ## Unknown is not zero
 *
 * `cost_source = 'unknown'` carries no amount and no currency (CHECK), so a
 * `sum()` cannot fold an unpriced attempt in as free traffic. Reports count
 * those rows beside the sum instead.
 *
 * ## Units are columns, not a document
 *
 * Kaana's units are a closed set (`USAGE_UNITS`), so each is its own `bigint`
 * column — the same {@link usageUnitColumns} every ledger table carries —
 * rather than a `jsonb` list that could hold anything (ADR 0016: Oxy persists
 * no payload, and an open-shaped column is where one would land). A unit the
 * reader does not know refuses the page instead of being stored. Kaana omits
 * units for attempts recorded before it measured them; `units_measured =
 * false` says so, and its columns are all zero by CHECK, so "not measured" can
 * never be read back as a measured zero.
 *
 * ## Failed attempts are here on purpose
 *
 * A failover attempt that produced nothing for the customer is on no receipt
 * and is still invoiced by the provider. `served = false` keeps it, so the
 * cost of a request that failed over is the sum of all its attempts.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';
import { createdAt, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { PROVIDER_COST_SOURCES } from '@oxy.so/contracts';
import {
  currencyCodeCheck,
  exactAmount,
  totalUsageUnitsExpression,
  usageUnitColumns,
  usageUnitsNonNegativeCheck,
} from './ledgerColumns';

export const PROVIDER_COST_SOURCE_VALUES = PROVIDER_COST_SOURCES;

export const inferenceProviderCostAttempts = pgTable(
  'inference_provider_cost_attempts',
  {
    /** Oxy's request id, carried in the signed envelope and echoed by Kaana. */
    requestId: text().notNull(),
    attemptIndex: integer().notNull(),

    provider: text().notNull(),
    /** Kaana's opaque key handle. Never a secret, never a label. */
    keyId: text().notNull(),
    keyClass: text().notNull(),
    deploymentId: text().notNull(),
    modelReference: text().notNull(),

    costSource: text({ enum: PROVIDER_COST_SOURCE_VALUES }).notNull(),
    /** Exact, from Kaana's integer 1e-12 units. NULL exactly when the source is `unknown`. */
    costAmount: exactAmount(),
    costCurrency: text(),
    rateCardVersionId: text(),
    costComplete: boolean().notNull(),
    served: boolean().notNull(),
    occurredAt: timestamptz().notNull(),
    /** False when Kaana never measured this attempt's units; its unit columns are then all zero. */
    unitsMeasured: boolean().notNull(),
    ...usageUnitColumns(),
    /** `succeeded` | `cancelled` | `failed`, or NULL for an attempt measured before Kaana recorded it. */
    outcome: text(),
    failureCode: text(),
    latencyMs: integer(),

    /** Kaana's opaque feed position for this attempt. */
    feedPosition: text().notNull(),
    factsDigest: text().notNull(),
    ingestedAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'inference_provider_cost_attempts_pkey', columns: [t.requestId, t.attemptIndex] }),
    index('inference_provider_cost_attempts_occurred_idx').on(t.occurredAt),
    check('inference_provider_cost_attempts_index_check', sql`${t.attemptIndex} >= 0`),
    check(
      'inference_provider_cost_attempts_source_check',
      sql`${t.costSource} in (${sql.raw(inList(PROVIDER_COST_SOURCE_VALUES))})`
    ),
    // Known source ⇔ amount and currency present. `unknown` can never be summed.
    check(
      'inference_provider_cost_attempts_amount_check',
      sql`(${t.costSource} <> 'unknown') = (${t.costAmount} is not null and ${t.costCurrency} is not null)
        and (${t.costSource} <> 'unknown' or (${t.costAmount} is null and ${t.costCurrency} is null))`
    ),
    check(
      'inference_provider_cost_attempts_currency_check',
      sql`${t.costCurrency} is null or ${currencyCodeCheck(t.costCurrency)}`
    ),
    usageUnitsNonNegativeCheck('inference_provider_cost_attempts_units_check', t),
    // Unmeasured is not a measured zero: an unmeasured attempt carries no quantity.
    check(
      'inference_provider_cost_attempts_unmeasured_check',
      sql`${t.unitsMeasured} or (${totalUsageUnitsExpression(t)}) = 0`
    ),
    check(
      'inference_provider_cost_attempts_latency_check',
      sql`${t.latencyMs} is null or ${t.latencyMs} >= 0`
    ),
  ]
);

/**
 * Where each operator feed was last read up to. One row per feed; the cursor
 * is Kaana's opaque token and is advanced compare-and-set, so two API tasks
 * reading the same page cannot move it backwards.
 */
export const inferenceProviderCostFeedCursors = pgTable('inference_provider_cost_feed_cursors', {
  feed: text().primaryKey(),
  cursor: text(),
  updatedAt: updatedAt(),
});

export type InferenceProviderCostAttemptRow = typeof inferenceProviderCostAttempts.$inferSelect;
