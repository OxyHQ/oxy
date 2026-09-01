/**
 * The reserve → settle → refund protocol.
 *
 * Four records, in the order they happen:
 *
 *  1. **Reservation** — before a request enters the data plane, Oxy holds the
 *     MAXIMUM the request could cost (input units + maximum output + the
 *     allowed route's price ceiling). A request whose account cannot cover that
 *     hold is rejected before anything is spent upstream.
 *  2. **Usage report** — the data plane's technical account of what was
 *     consumed. Units and route, never money: the data plane measures, the
 *     control plane prices.
 *  3. **Receipt** — the immutable settlement. Carries the exact units, a COPY
 *     of the prices they were charged at, and the amount booked. It is never
 *     edited afterwards.
 *  4. **Refund/reversal** — an equally immutable entry that releases an unused
 *     hold or reverses a settled charge. Settled history is compensated, never
 *     rewritten, because an invoice a customer already received must remain
 *     reconstructible.
 *
 * Every one of them is keyed by an idempotency key, so a retried call, a
 * redelivered event or a duplicated webhook produces the same record rather than
 * a second charge.
 *
 * Money is an exact decimal string throughout (ADR 0009 — never integer minor
 * units, never a float), and unit counts are carried separately from it (see
 * `money.ts`).
 *
 * Decided in: docs/adr/0009-usage-reservation-and-settlement.md.
 */

import { z } from 'zod';
import { inferenceAttributionSchema } from './attribution';
import {
  deploymentIdSchema,
  generationIdSchema,
  idempotencyKeySchema,
  inferenceProviderSlugSchema,
  inferenceTimestampSchema,
  modelReferenceSchema,
  requestIdSchema,
} from './identifiers';
import {
  currencyCodeSchema,
  exactDecimalSchema,
  usageQuantitySchema,
  usageSourceSchema,
} from './money';
import { priceSnapshotSchema } from './priceVersion';

/* -------------------------------------------------------------------------- */
/*  1. Reservation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Ask the ledger to hold the maximum a request could cost.
 *
 * `maxAmount` is the number the balance check is made against, and it is
 * computed from the three inputs beside it rather than guessed: the units
 * already known (the prompt), the ceiling on units still to come
 * (`maxOutputTokens`), and the most expensive route the policy allows. Sizing a
 * hold from a typical response rather than the worst allowed one is how a
 * balance goes negative on a long generation.
 */
export const usageReservationRequestSchema = z.object({
  /** See `version.ts`: exchanged between the edge and the ledger on its own. */
  schemaVersion: z.literal(1),
  idempotencyKey: idempotencyKeySchema,
  attribution: inferenceAttributionSchema,
  /** Units already determined by the request itself, e.g. input tokens. */
  knownUnits: z.array(usageQuantitySchema).default([]),
  /** The ceiling on generated output, when the request set one. */
  maxOutputTokens: z.number().int().positive().safe().optional(),
  /** The price version of the most expensive route the policy permits. */
  ceilingPriceVersionId: z.string().min(1).max(128),
  maxAmount: exactDecimalSchema,
  currency: currencyCodeSchema,
  expiresInSeconds: z.number().int().positive().max(86400),
});

/** Lifecycle of a hold. Terminal states are `settled`, `released`, `expired`. */
export const usageReservationStatusSchema = z.enum([
  'held',
  'settled',
  'released',
  'expired',
]);

/**
 * A hold placed against an account's balance.
 *
 * Reserved amounts are shown to customers distinctly from settled charges: a
 * reservation is not money spent, and presenting the two as one number makes a
 * balance appear to drop and then recover for every request.
 */
export const usageReservationSchema = z
  .object({
    /** See `version.ts`: read back by the edge and the Console on its own. */
    schemaVersion: z.literal(1),
    reservationId: z.string().min(1).max(128),
    idempotencyKey: idempotencyKeySchema,
    attribution: inferenceAttributionSchema,
    status: usageReservationStatusSchema,
    reservedAmount: exactDecimalSchema,
    currency: currencyCodeSchema,
    ceilingPriceVersionId: z.string().min(1).max(128),
    createdAt: inferenceTimestampSchema,
    expiresAt: inferenceTimestampSchema,
    /** The receipt that consumed this hold. Present exactly when `settled`. */
    settledReceiptId: z.string().min(1).max(128).optional(),
  })
  .superRefine((reservation, ctx) => {
    if (reservation.status === 'settled' && reservation.settledReceiptId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['settledReceiptId'],
        message: 'a settled reservation must name the receipt that settled it',
      });
    }

    if (reservation.status !== 'settled' && reservation.settledReceiptId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['settledReceiptId'],
        message: 'only a settled reservation has a settling receipt',
      });
    }
  });

/* -------------------------------------------------------------------------- */
/*  2. Usage report (data plane → Oxy)                                        */
/* -------------------------------------------------------------------------- */

/** How a request ended, from the data plane's point of view. */
export const inferenceRequestOutcomeSchema = z.enum([
  'completed',
  'partial',
  'cancelled',
  'failed',
]);

/**
 * The data plane's technical account of one request, and the ONLY shape a
 * settlement is written from.
 *
 * `inferenceStreamUsageEventSchema` is not a narrower version of this one that
 * could be widened into it — see that event's own comment. Its units are exact
 * and settleable; the record around them is not inferable, so an edge settling
 * from a stream event supplies the outcome itself and never promotes the event.
 *
 * No money and no price: the data plane measures units and names the route it
 * used, and the control plane decides what that costs. Keeping the two apart is
 * what allows a price to be corrected after the fact without re-running or
 * re-measuring anything.
 *
 * `usageSource` is load-bearing when a provider returns no usage at all: the
 * report still arrives, marked `estimated`, so settlement can apply the
 * estimation policy knowingly instead of treating a reconstruction as fact.
 *
 * `units` is a PARTITION of what the request consumed, not a set of totals with
 * details hanging off them — see `USAGE_UNITS` in `money.ts`. Reporting a provider's
 * nested `prompt_tokens`/`completion_tokens` verbatim charges the cached and
 * reasoning tokens twice, so subtracting the children out is part of what
 * "normalized" means in this shape's name.
 *
 * **A `completed` report carries at least one unit, and the other outcomes need
 * not.** `completed` is the one outcome that asserts the customer received the
 * whole answer, so "delivered in full, consumed nothing measurable" is a
 * contradiction — and it is one that BILLS NOTHING: settlement prices every
 * reported unit and sums, so an empty list is a free request produced by a
 * provider that simply omitted its usage block. The refinement makes that shape
 * unparseable, and the policy behind it is refuse-and-release: the report is
 * rejected and the hold is released, never estimated and charged.
 *
 * The three other outcomes legitimately carry none, which is why the rule is
 * conditional rather than a `.min(1)` on the field. In the reference data plane
 * `failed` is DERIVED from having no units — `outcomeFor` in
 * `internal/kaana/executor.go` returns `partial` when units exist and `failed`
 * when they do not — and `cancelled` is reported for a client that stopped
 * before anything was measured. An unconditional minimum would refuse those
 * reports, and a refused report is a request that ran, cost money upstream and
 * can never be settled or refunded.
 */
export const normalizedUsageReportSchema = z
  .object({
    /** See `version.ts`: emitted by the data plane as a whole message. */
    schemaVersion: z.literal(1),
    requestId: requestIdSchema,
    generationId: generationIdSchema.optional(),
    attribution: inferenceAttributionSchema,
    outcome: inferenceRequestOutcomeSchema,
    units: z.array(usageQuantitySchema),
    usageSource: usageSourceSchema,
    resolvedModelReference: modelReferenceSchema,
    servingProvider: inferenceProviderSlugSchema,
    deploymentId: deploymentIdSchema.optional(),
    /** How many allowed route switches occurred while serving this request. */
    routeSwitches: z.number().int().nonnegative().max(100),
    startedAt: inferenceTimestampSchema,
    completedAt: inferenceTimestampSchema,
    timeToFirstTokenMs: z.number().int().nonnegative().safe().optional(),
  })
  .superRefine((report, ctx) => {
    // Compared as instants: two spellings of one moment sort differently as text.
    if (Date.parse(report.completedAt) < Date.parse(report.startedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completedAt'],
        message: 'a request cannot complete before it started',
      });
    }

    const units = report.units.map((quantity) => quantity.unit);
    if (new Set(units).size !== units.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['units'],
        message: 'each unit is reported once, as a total',
      });
    }

    if (report.outcome === 'completed' && report.units.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['units'],
        message: 'a completed request consumed something; report at least one unit',
      });
    }
  });

/* -------------------------------------------------------------------------- */
/*  3. Receipt (settlement)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The immutable record of what a request was actually charged.
 *
 * `priceSnapshot` is a COPY of the unit prices applied, not just the id of the
 * price version they came from, so the arithmetic on this receipt can be
 * checked years later without depending on any other record still existing.
 *
 * `platformFeeOnly` marks a BYOK request: the upstream provider billed the
 * customer's own account directly, and `billedAmount` is Oxy's service fee
 * rather than the cost of the tokens. Without the flag, the two look identical
 * and a BYOK customer appears to have been charged twice for one request.
 */
export const usageReceiptSchema = z
  .object({
    /** See `version.ts`: returned to customers by `GET /v1/generations/:id`. */
    schemaVersion: z.literal(1),
    receiptId: z.string().min(1).max(128),
    /** The hold this settled against. Absent for a charge with no reservation. */
    reservationId: z.string().min(1).max(128).optional(),
    idempotencyKey: idempotencyKeySchema,
    attribution: inferenceAttributionSchema,
    outcome: inferenceRequestOutcomeSchema,
    units: z.array(usageQuantitySchema).min(1),
    usageSource: usageSourceSchema,
    priceSnapshot: priceSnapshotSchema,
    billedAmount: exactDecimalSchema,
    currency: currencyCodeSchema,
    platformFeeOnly: z.boolean(),
    resolvedModelReference: modelReferenceSchema,
    servingProvider: inferenceProviderSlugSchema,
    settledAt: inferenceTimestampSchema,
  })
  .superRefine((receipt, ctx) => {
    if (receipt.currency !== receipt.priceSnapshot.currency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['priceSnapshot', 'currency'],
        message: 'a receipt must be settled in the currency it was priced in',
      });
    }

    const units = receipt.units.map((quantity) => quantity.unit);
    if (new Set(units).size !== units.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['units'],
        message: 'each unit is settled once, as a total',
      });
    }
  });

/* -------------------------------------------------------------------------- */
/*  4. Refund / reversal                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a reversal acts on: an unused hold, or a settled charge.
 *
 * A discriminated union, so "release the rest of the hold" and "give back money
 * already booked" can never be confused for one another — they hit different
 * ledger accounts and only the second one is visible on an invoice.
 */
export const usageRefundSubjectSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('reservation'), reservationId: z.string().min(1).max(128) })
    .strict(),
  z.object({ kind: z.literal('receipt'), receiptId: z.string().min(1).max(128) }).strict(),
]);

/** Why money was given back or a hold was released. */
export const usageRefundReasonSchema = z.enum([
  'unused_reservation',
  'client_cancelled',
  'upstream_failure',
  'partial_stream',
  'usage_unavailable',
  'billing_correction',
  'duplicate_charge',
]);

/** Reasons that can only ever act on a settled charge. */
const RECEIPT_ONLY_REFUND_REASONS: ReadonlySet<string> = new Set([
  'billing_correction',
  'duplicate_charge',
]);

/**
 * An immutable reversal entry.
 *
 * `amount` is non-negative like every other amount in this contract: the
 * direction is carried by the record being a refund, not by a sign that a
 * consumer could read the wrong way round. Idempotent by key, so a retried
 * refund releases the same money once.
 */
export const usageRefundSchema = z
  .object({
    /** See `version.ts`: a ledger record read back on its own. */
    schemaVersion: z.literal(1),
    refundId: z.string().min(1).max(128),
    idempotencyKey: idempotencyKeySchema,
    attribution: inferenceAttributionSchema,
    subject: usageRefundSubjectSchema,
    reason: usageRefundReasonSchema,
    amount: exactDecimalSchema,
    currency: currencyCodeSchema,
    createdAt: inferenceTimestampSchema,
  })
  .superRefine((refund, ctx) => {
    if (refund.reason === 'unused_reservation' && refund.subject.kind !== 'reservation') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'an unused reservation is released against the reservation, not a receipt',
      });
    }

    if (RECEIPT_ONLY_REFUND_REASONS.has(refund.reason) && refund.subject.kind !== 'receipt') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: `${refund.reason} reverses a settled charge, so it acts on a receipt`,
      });
    }
  });

export type UsageReservationRequest = z.infer<typeof usageReservationRequestSchema>;
export type UsageReservationStatus = z.infer<typeof usageReservationStatusSchema>;
export type UsageReservation = z.infer<typeof usageReservationSchema>;
export type InferenceRequestOutcome = z.infer<typeof inferenceRequestOutcomeSchema>;
export type NormalizedUsageReport = z.infer<typeof normalizedUsageReportSchema>;
export type UsageReceipt = z.infer<typeof usageReceiptSchema>;
export type UsageRefundSubject = z.infer<typeof usageRefundSubjectSchema>;
export type UsageRefundReason = z.infer<typeof usageRefundReasonSchema>;
export type UsageRefund = z.infer<typeof usageRefundSchema>;
