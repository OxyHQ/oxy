/**
 * `POST /v1/responses` — Kaana's own dialect, and the preferred endpoint.
 *
 * Moved from the Oxy edge (`packages/api/src/schemas/inferenceEdge.schemas.ts`,
 * `responsesRequestSchema` and `responsesResponseSchema`) by Kaana ADR 0002.
 * Two changes, both from the ADR: `model` names a model reference or a power
 * level and nothing else (Oxy's `routingProfile`/`routingProfileId` were Oxy
 * catalogue identities), and the response names no serving provider.
 */

import { z } from 'zod';
import { powerLevelSchema } from './catalogue.js';
import { generationIdSchema, modelReferenceSchema, requestIdSchema } from './identifiers.js';
import {
  inferenceMessageSchema,
  inferenceReasoningSchema,
  requestLabelsSchema,
  responseFormatSchema,
  toolChoiceSchema,
  toolDefinitionSchema,
} from './messages.js';
import { usageQuantitySchema } from './money.js';
import { routingPolicyReferenceSchema } from './policy.js';
import { inferenceFinishReasonSchema } from './streamEvents.js';

/**
 * What a `model` field may name: a concrete model reference
 * (`publisher/model[@revision]`, served or refused, never substituted) or a
 * power level (`auto`, `instant`, … — no `/`, so the two are decidable from
 * the string alone).
 */
export const modelTargetSchema = z.union([modelReferenceSchema, powerLevelSchema]);

/** The message-or-text input `/v1/responses` accepts. */
const responsesInputSchema = z.union([z.string().min(1), z.array(inferenceMessageSchema).min(1)]);

/**
 * The request. `model` may be absent: the application's routing policy in Oxy
 * Console may name a default target, and the request is refused only when it
 * names none either.
 *
 * `.strict()`: a field Kaana does not implement is refused rather than
 * silently ignored, so nobody is billed for a request that dropped half of
 * what it asked for.
 */
export const responsesRequestSchema = z
  .object({
    model: modelTargetSchema.optional(),
    input: responsesInputSchema,
    maxOutputTokens: z.number().int().positive().safe().optional(),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    topK: z.number().int().positive().safe().optional(),
    frequencyPenalty: z.number().min(-2).max(2).optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
    seed: z.number().int().safe().optional(),
    stopSequences: z.array(z.string().min(1).max(256)).max(8).optional(),
    tools: z.array(toolDefinitionSchema).max(128).optional(),
    toolChoice: toolChoiceSchema.optional(),
    responseFormat: responseFormatSchema.optional(),
    /** Refused when the resolved model does not advertise the effort. */
    reasoning: inferenceReasoningSchema.optional(),
    labels: requestLabelsSchema.optional(),
    /** The caller's own correlation id, echoed on the response. */
    clientRequestId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.toolChoice !== undefined && (request.tools ?? []).length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['toolChoice'],
        message: 'a tool choice requires at least one tool definition',
      });
    }
    const names = (request.tools ?? []).map((tool) => tool.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['tools'],
        message: 'tool names must be unique within one request',
      });
    }
  });

/**
 * The non-streaming body. A streamed request answers with
 * `responseStreamEventSchema` frames instead.
 */
export const responseSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: requestIdSchema,
    /** Absent when no generation id was reported for the request. */
    generationId: generationIdSchema.optional(),
    /** The revision that actually served the request, which may differ from the ask. */
    model: modelReferenceSchema,
    finishReason: inferenceFinishReasonSchema,
    output: z.array(inferenceMessageSchema),
    usage: z.array(usageQuantitySchema),
    /** The customer's own routing-policy revision that served it. */
    routingPolicy: routingPolicyReferenceSchema,
    /** Kaana's own measurement of the request, in whole milliseconds. */
    latencyMs: z.number().int().nonnegative(),
  })
  .strict();

export type ModelTarget = z.infer<typeof modelTargetSchema>;
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
export type Response = z.infer<typeof responseSchema>;
