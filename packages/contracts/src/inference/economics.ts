/**
 * Economic treatment and durable usage/cost reporting for inference
 * (issue #1526, plan item I09).
 *
 * ## Two treatments, decided by the server
 *
 *  - `commercial` — the default for every caller. Reserve → settle → refund
 *    (ADR 0009), when this deployment charges at all.
 *  - `internal_metered` — a product relationship Oxy itself configured and
 *    versioned (e.g. Alia consuming Kaana through the Oxy edge). No hold, no
 *    receipt, no promotional grant, no `platform_revenue` entry and no transfer
 *    between products; usage and cost are still recorded durably, and scopes,
 *    revocation, technical capacity, model eligibility, privacy and
 *    idempotency all still apply.
 *
 * The treatment is derived from the AUTHENTICATED application, its environment
 * and lane, against a versioned policy. Nothing a caller sends — body, header,
 * bot kind, agent id, delegated user — can select it, so neither value is ever
 * accepted on a request shape.
 *
 * ## Four numbers that never merge
 *
 * A usage report separates what was consumed (units), what the upstream
 * invoiced (`providerCost`, from Kaana's operator feed), what the published
 * tariff would have charged (`tariff`) and what a customer was actually charged
 * (`customerCharge`, from settled receipts only). A tariff is not a cost, and an
 * UNKNOWN cost is reported as unknown — counted, never summed as zero.
 */

import { z } from 'zod';
import { costCenterSchema } from './entitlement';
import { currencyCodeSchema, exactDecimalSchema } from './money';

/** How a request is treated economically. The first entry is the default. */
export const INFERENCE_ECONOMIC_TREATMENTS = ['commercial', 'internal_metered'] as const;

export const inferenceEconomicTreatmentSchema = z.enum(INFERENCE_ECONOMIC_TREATMENTS);

/**
 * Where an upstream attempt's cost came from, exactly as Kaana's operator feed
 * states it: an exact provider billing fact, a versioned rate-card estimate, or
 * nothing known. `unknown` carries no amount, so it cannot be summed as free.
 */
export const PROVIDER_COST_SOURCES = ['provider_reported', 'rate_card', 'unknown'] as const;

export const providerCostSourceSchema = z.enum(PROVIDER_COST_SOURCES);

const nonNegativeCount = z.number().int().nonnegative().safe();

/** One amount family, with the rows it could not include counted beside it. */
const knownAmountSchema = z
  .object({
    /** Sum of the rows whose amount is known, in `currency`. */
    amount: exactDecimalSchema,
    /** Rows (requests or attempts) whose amount is known. */
    knownCount: nonNegativeCount,
    /** Rows that exist and have NO amount. Never folded into `amount` as zero. */
    unknownCount: nonNegativeCount,
  })
  .strict();

/**
 * What one cost centre consumed over a window under one economic treatment.
 *
 * `customerCharge` is always zero with zero receipts for `internal_metered`:
 * those requests have no receipt by construction, and saying so is the point.
 */
export const costCenterUsageSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** `null` for usage booked to an account with no cost centre above it. */
    costCenter: costCenterSchema.nullable(),
    treatment: inferenceEconomicTreatmentSchema,
    currency: currencyCodeSchema,
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    /** Requests settled in the window (completed, failed, cancelled or partial). */
    requestCount: nonNegativeCount,
    /** Requests admitted and not yet settled when the report was read. */
    inFlightCount: nonNegativeCount,
    /** Metered units, by unit name, summed over the settled requests. */
    units: z.record(z.string(), nonNegativeCount),
    /** The published tariff at each request's pinned price version. Not a cost. */
    tariff: knownAmountSchema,
    /** What upstream providers invoiced, per attempt, failed failovers included. */
    providerCost: knownAmountSchema,
    /**
     * What customers were actually charged, from settled receipts only. A
     * request with no receipt was not charged — an internal one by
     * construction, a shadow-metered one because charging is off.
     */
    customerCharge: z
      .object({ amount: exactDecimalSchema, receiptCount: nonNegativeCount })
      .strict(),
  })
  .strict();

export type InferenceEconomicTreatment = z.infer<typeof inferenceEconomicTreatmentSchema>;
export type ProviderCostSource = z.infer<typeof providerCostSourceSchema>;
export type CostCenterUsage = z.infer<typeof costCenterUsageSchema>;
