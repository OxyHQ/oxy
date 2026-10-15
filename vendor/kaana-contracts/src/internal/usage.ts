/**
 * The normalized usage report: what Kaana measured, and the only shape a
 * settlement is written from.
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/usage.ts`) by Kaana ADR 0002.
 * Reservations, receipts and refunds are the ledger and stay in
 * `@oxy.so/contracts`.
 */

import { z } from 'zod';
import { inferenceRequestOutcomeSchema } from '../public/generations.js';
import {
  generationIdSchema,
  inferenceTimestampSchema,
  modelReferenceSchema,
  requestIdSchema,
} from '../public/identifiers.js';
import { usageQuantitySchema, usageSourceSchema } from '../public/money.js';
import { inferenceAttributionSchema } from './attribution.js';
import {
  deploymentIdSchema,
  inferenceFundingTierSchema,
  inferenceProviderSlugSchema,
} from './identifiers.js';

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
 * Kaana's `internal/kaana/executor.go` returns `partial` when units exist and `failed`
 * when they do not — and `cancelled` is reported for a client that stopped
 * before anything was measured. An unconditional minimum would refuse those
 * reports, and a refused report is a request that ran, cost money upstream and
 * can never be settled or refunded.
 */
export const normalizedUsageReportSchema = z
  .object({
    /** See `version.ts`: emitted by the data plane as a whole message. */
    schemaVersion: z.literal(2),
    requestId: requestIdSchema,
    generationId: generationIdSchema.optional(),
    attribution: inferenceAttributionSchema,
    outcome: inferenceRequestOutcomeSchema,
    units: z.array(usageQuantitySchema),
    usageSource: usageSourceSchema,
    resolvedModelReference: modelReferenceSchema,
    servingProvider: inferenceProviderSlugSchema,
    /** Exact Kaana deployment that attempted the request; never inferred from names. */
    deploymentId: deploymentIdSchema,
    /** How many allowed route switches occurred while serving this request. */
    routeSwitches: z.number().int().nonnegative().max(100),
    /**
     * The funding tier of the platform key that served the final attempt, as
     * the data plane states it (ADR 0038). Absent when the key's economics
     * were never stated, when a customer credential served, or when nothing
     * was served. Oxy reads it to account for what the request cost the
     * platform; it is never a key identity and never reaches a customer.
     */
    fundingTier: inferenceFundingTierSchema.optional(),
    startedAt: inferenceTimestampSchema,
    completedAt: inferenceTimestampSchema,
    timeToFirstTokenMs: z.number().int().nonnegative().safe().optional(),
  })
  .superRefine((report, ctx) => {
    // Compared as instants: two spellings of one moment sort differently as text.
    if (Date.parse(report.completedAt) < Date.parse(report.startedAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'a request cannot complete before it started',
      });
    }

    const units = report.units.map((quantity) => quantity.unit);
    if (new Set(units).size !== units.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['units'],
        message: 'each unit is reported once, as a total',
      });
    }

    if (report.outcome === 'completed' && report.units.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['units'],
        message: 'a completed request consumed something; report at least one unit',
      });
    }
  });

export type NormalizedUsageReport = z.infer<typeof normalizedUsageReportSchema>;
