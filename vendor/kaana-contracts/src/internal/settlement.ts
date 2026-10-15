/**
 * Settlement: exactly once, from Kaana's measurement (Kaana ADR 0002,
 * decision 3).
 *
 * When a granted request ends — success, error, cancellation or the close of a
 * realtime session — Kaana writes the settlement into a durable outbox in its
 * PostgreSQL, in the same transaction as its provider-cost events, and a worker
 * delivers it to `POST https://api.oxy.so/internal/kaana/v1/settlements`,
 * signed by Kaana under {@link SETTLEMENT_SIGNATURE_DOMAIN}. Oxy settles
 * idempotently on `grantId` and reconciles by reading
 * `GET https://kaana.ai/internal/v1/settlements?cursor=`. Units, never money:
 * Oxy prices with the `priceVersionId` the grant admitted for the line served.
 *
 * New in contract set 4.0.0.
 */

import { z } from 'zod';
import { inferenceTimestampSchema, requestIdSchema } from '../public/identifiers.js';
import { normalizedUsageReportSchema } from './usage.js';

/** The signature domain of a settlement, under Kaana's own settlement key. */
export const SETTLEMENT_SIGNATURE_DOMAIN = 'kaana-oxy-settlement:v1';

/** One granted request's settlement, as the outbox delivers it. */
export const settlementSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** The outbox row; stable across redeliveries. */
    settlementId: z.string().min(1).max(128),
    /** The idempotency key of the settlement: one grant settles once. */
    grantId: z.string().min(1).max(128),
    requestId: requestIdSchema,
    /** The grant's hold, when it had one. */
    reservationId: z.string().min(1).max(128).optional(),
    /** The grant's capacity slot, when it claimed one; settling releases it. */
    meteredUsageId: z.string().min(1).max(128).optional(),
    /** The step that served, by position in the grant. Absent when nothing was served. */
    servedStep: z.number().int().nonnegative().max(7).optional(),
    report: normalizedUsageReportSchema,
    createdAt: inferenceTimestampSchema,
  })
  .strict()
  .superRefine((settlement, ctx) => {
    if (settlement.report.requestId !== settlement.requestId) {
      ctx.addIssue({
        code: 'custom',
        path: ['report', 'requestId'],
        message: 'the report settles this request',
      });
    }
    if (settlement.report.outcome === 'completed' && settlement.servedStep === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['servedStep'],
        message: 'a completed request was served by a step of its grant',
      });
    }
  });

/** Oxy's answer to a delivered settlement. A redelivery is `duplicate`, never a second charge. */
export const settlementAcknowledgementSchema = z
  .object({
    schemaVersion: z.literal(1),
    settlementId: z.string().min(1).max(128),
    status: z.enum(['settled', 'duplicate']),
  })
  .strict();

/** `GET /internal/v1/settlements?cursor=`: what Oxy reconciles against. */
export const settlementPageSchema = z
  .object({
    data: z.array(settlementSchema),
    /** Absent on the last page. */
    nextCursor: z.string().min(1).max(512).optional(),
  })
  .strict();

export type Settlement = z.infer<typeof settlementSchema>;
export type SettlementAcknowledgement = z.infer<typeof settlementAcknowledgementSchema>;
export type SettlementPage = z.infer<typeof settlementPageSchema>;
