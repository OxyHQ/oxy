/**
 * Generation records: the receipt a client reads back with
 * `GET /v1/generations/{id}` or `GET /v1/generations?idempotency_key=`.
 *
 * Kaana serves the record and Oxy supplies the amount (Kaana ADR 0002,
 * decision 7): Kaana measured the units, Oxy priced and settled them. Two
 * kinds, discriminated on `kind`, because a commercial request and an
 * internally metered one are different facts — one was charged, the other was
 * deliberately not — and a single shape with optional money would let a
 * reader mistake the second for a free request.
 *
 * Derived from the Oxy edge's `generationReceiptSchema` and
 * `meteredGenerationSchema` (`@oxy.so/contracts` 4.12.0) without the serving
 * provider: no public record names a provider, a key or a deployment.
 */

import { z } from 'zod';
import {
  delegatedUserIdSchema,
  generationIdSchema,
  inferenceEnvironmentSchema,
  inferenceTimestampSchema,
  modelReferenceSchema,
  oxyApplicationIdSchema,
  oxyCredentialIdSchema,
  requestIdSchema,
} from './identifiers.js';
import { requestLabelsSchema } from './messages.js';
import {
  currencyCodeSchema,
  exactDecimalSchema,
  priceSnapshotSchema,
  usageQuantitySchema,
  usageSourceSchema,
} from './money.js';

/**
 * How a request ended.
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/usage.ts`).
 */
export const inferenceRequestOutcomeSchema = z.enum([
  'completed',
  'partial',
  'cancelled',
  'failed',
]);

const recordFields = {
  /** A whole message on the wire, so it is versioned. */
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  generationId: generationIdSchema.optional(),
  applicationId: oxyApplicationIdSchema,
  credentialId: oxyCredentialIdSchema,
  /** Attribution only. Never the billing identity. */
  delegatedUserId: delegatedUserIdSchema.optional(),
  environment: inferenceEnvironmentSchema,
  outcome: inferenceRequestOutcomeSchema,
  usageSource: usageSourceSchema,
  units: z.array(usageQuantitySchema),
  /** The revision that actually served the request. */
  model: modelReferenceSchema,
  /** The caller's cost-attribution labels, echoed back. */
  labels: requestLabelsSchema.optional(),
  settledAt: inferenceTimestampSchema,
};

const uniqueUnits = (units: readonly { unit: string }[], ctx: z.RefinementCtx): void => {
  const names = units.map((quantity) => quantity.unit);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: 'custom', path: ['units'], message: 'each unit is settled once' });
  }
};

/**
 * A commercial request: priced and charged.
 *
 * `priceSnapshot` is a COPY of the unit prices applied, so the arithmetic is
 * checkable without the price version still existing. `platformFeeOnly` marks
 * a BYOK request: the provider billed the customer's own account and
 * `billedAmount` is Oxy's fee, not the cost of the tokens.
 */
export const chargedGenerationRecordSchema = z
  .object({
    ...recordFields,
    kind: z.literal('charge'),
    receiptId: z.string().min(1).max(128),
    priceSnapshot: priceSnapshotSchema,
    billedAmount: exactDecimalSchema,
    currency: currencyCodeSchema,
    platformFeeOnly: z.boolean(),
  })
  .strict()
  .superRefine((record, ctx) => {
    uniqueUnits(record.units, ctx);
    if (record.currency !== record.priceSnapshot.currency) {
      ctx.addIssue({
        code: 'custom',
        path: ['priceSnapshot', 'currency'],
        message: 'a record is settled in the currency it was priced in',
      });
    }
  });

/**
 * An internally metered request: measured and recorded, never charged. The
 * tariff is what the published price list WOULD have charged, which is not a
 * cost and not a charge.
 */
export const meteredGenerationRecordSchema = z
  .object({
    ...recordFields,
    kind: z.literal('metered_usage'),
    meteredUsageId: z.string().min(1).max(128),
    /** The request this one ran inside, for a child such as an Auto classification. */
    parentRequestId: requestIdSchema.optional(),
    tariff: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('quoted'),
          amount: exactDecimalSchema,
          currency: currencyCodeSchema,
          priceVersionId: z.string().min(1).max(128),
        })
        .strict(),
      z
        .object({
          status: z.literal('unpriced'),
          priceVersionId: z.string().min(1).max(128).nullable(),
        })
        .strict(),
    ]),
    customerCharge: z.object({ status: z.literal('not_charged') }).strict(),
  })
  .strict()
  .superRefine((record, ctx) => uniqueUnits(record.units, ctx));

/** `GET /v1/generations/{id}` and `GET /v1/generations?idempotency_key=`. */
export const generationRecordSchema = z.discriminatedUnion('kind', [
  chargedGenerationRecordSchema,
  meteredGenerationRecordSchema,
]);

export type InferenceRequestOutcome = z.infer<typeof inferenceRequestOutcomeSchema>;
export type ChargedGenerationRecord = z.infer<typeof chargedGenerationRecordSchema>;
export type MeteredGenerationRecord = z.infer<typeof meteredGenerationRecordSchema>;
export type GenerationRecord = z.infer<typeof generationRecordSchema>;
