/**
 * Kaana's typed decisions result and failure on the signed lane.
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/decisions.ts`) by Kaana ADR 0002.
 */

import { z } from 'zod';
import { type DecisionAnswer, decisionAnswerSchema } from '../public/decisions.js';
import { modelReferenceSchema, requestIdSchema } from '../public/identifiers.js';
import { inferenceErrorSchema } from './errors.js';
import { normalizedUsageReportSchema } from './usage.js';

const resultFields = {
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  model: modelReferenceSchema.refine(
    (model) => model.includes('@'),
    'Decisions require an immutable model revision.',
  ),
  data: z.array(decisionAnswerSchema).min(1).max(255),
};

function uniqueAnswers(result: { data: DecisionAnswer[] }, ctx: z.RefinementCtx): void {
  if (new Set(result.data.map((answer) => answer.id)).size !== result.data.length)
    ctx.addIssue({
      code: 'custom',
      path: ['data'],
      message: 'Answer IDs must be unique.',
    });
}

export const decisionResultSchema = z
  .object({ ...resultFields, usage: normalizedUsageReportSchema })
  .strict()
  .superRefine(uniqueAnswers)
  .superRefine((result, ctx) => {
    if (
      result.usage.requestId !== result.requestId ||
      result.usage.resolvedModelReference !== result.model ||
      result.usage.outcome !== 'completed'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['usage'],
        message: 'Decision usage must describe this completed request and immutable model.',
      });
    }
  });

/**
 * Kaana's typed decisions failure. `usage` is present only when the provider
 * measured something before failing; its absence means nothing was measured,
 * never that the cost was zero. A failure carrying usage did execute.
 */
export const decisionFailureSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: requestIdSchema,
    error: inferenceErrorSchema,
    usage: normalizedUsageReportSchema.optional(),
  })
  .strict()
  .superRefine((failure, ctx) => {
    if (failure.error.requestId !== failure.requestId) {
      ctx.addIssue({
        code: 'custom',
        path: ['error', 'requestId'],
        message: 'The error must answer this request.',
      });
    }
    if (
      failure.usage !== undefined &&
      (failure.usage.requestId !== failure.requestId || failure.usage.outcome === 'completed')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['usage'],
        message: 'Failure usage must describe this request and an incomplete outcome.',
      });
    }
  });

export type DecisionResult = z.infer<typeof decisionResultSchema>;
export type DecisionFailure = z.infer<typeof decisionFailureSchema>;
