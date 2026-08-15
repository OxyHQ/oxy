/**
 * Normalized stream events — what the data plane emits and the Oxy edge
 * forwards as SSE.
 *
 * One discriminated union, seven shapes, all carrying `requestId` and a
 * monotonic `sequence`. `requestId` is on EVERY event rather than only the
 * first because a proxy that re-frames or a client that reconnects would
 * otherwise be holding events it cannot attribute; `sequence` is what makes a
 * redelivered event detectable as a duplicate rather than as new output.
 *
 * The events are versioned INDIVIDUALLY (see `version.ts`): a stream is a long
 * sequence of small messages from a producer that may be redeployed mid-stream,
 * so the alternative — one version for the whole union — would force every
 * event to move whenever any one of them changed.
 *
 * `route_switch` is the customer-visible receipt for an allowed re-route, and
 * its shape carries the invariant: a switch to a DIFFERENT model can only be
 * expressed with `authorizedByPolicy: true`, so an unauthorized substitution is
 * not a thing the contract can say.
 *
 * Decided in: docs/adr/0010-public-api-compatibility.md, docs/adr/0008-catalogue-concept-separation.md.
 */

import { z } from 'zod';
import {
  deploymentIdSchema,
  generationIdSchema,
  inferenceProviderSlugSchema,
  inferenceTimestampSchema,
  modelIdSchema,
  modelReferenceSchema,
  requestIdSchema,
} from './identifiers';
import { inferenceErrorSchema } from './errors';
import { usageQuantitySchema, usageSourceSchema } from './money';

/**
 * The first event of every stream: what was actually resolved.
 *
 * Names the revision-pinned model and the serving provider, so a customer who
 * asked for `<publisher>/<model>` learns which revision answered without having
 * to wait for the receipt. Carries no deployment health, no route id and no
 * upstream cost.
 */
export const inferenceStreamStartEventSchema = z.object({
  /** See `version.ts`: each stream event is a whole message on the wire. */
  schemaVersion: z.literal(1),
  type: z.literal('start'),
  requestId: requestIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  generationId: generationIdSchema.optional(),
  /** Always revision-pinned, even when the request named only the model. */
  resolvedModelReference: modelReferenceSchema,
  servingProvider: inferenceProviderSlugSchema,
  startedAt: inferenceTimestampSchema,
});

/**
 * A chunk of output.
 *
 * `channel` separates visible output from reasoning and refusals, because a
 * client that renders reasoning as answer text is a product bug, not a display
 * preference.
 */
export const inferenceStreamDeltaEventSchema = z.object({
  /** See `version.ts`: each stream event is a whole message on the wire. */
  schemaVersion: z.literal(1),
  type: z.literal('delta'),
  requestId: requestIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  /** Which output of a multi-output response this chunk belongs to. */
  outputIndex: z.number().int().nonnegative().safe(),
  channel: z.enum(['output_text', 'reasoning', 'refusal']),
  text: z.string(),
});

/**
 * A tool call being streamed.
 *
 * `argumentsDelta` accumulates; `complete` marks the call finished so a client
 * knows when the accumulated JSON text is worth parsing.
 */
export const inferenceStreamToolCallEventSchema = z.object({
  /** See `version.ts`: each stream event is a whole message on the wire. */
  schemaVersion: z.literal(1),
  type: z.literal('tool_call'),
  requestId: requestIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  toolCallId: z.string().min(1).max(128),
  /** Present on the first event of a call. */
  name: z.string().min(1).max(128).optional(),
  argumentsDelta: z.string().optional(),
  complete: z.boolean(),
});

/**
 * Metered units for the request so far.
 *
 * Units only — no money. What a customer is charged is the ledger's answer,
 * derived from these units and a price version at settlement; a cost quoted by
 * the data plane would be a second, unauthoritative answer to the same
 * question.
 */
export const inferenceStreamUsageEventSchema = z.object({
  /** See `version.ts`: each stream event is a whole message on the wire. */
  schemaVersion: z.literal(1),
  type: z.literal('usage'),
  requestId: requestIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  units: z.array(usageQuantitySchema).min(1),
  usageSource: usageSourceSchema,
});

/**
 * What kind of re-route happened.
 *
 * `deployment` is same-model failover: the same revision, served somewhere else.
 * `model` is a substitution, and is expressible ONLY with
 * `authorizedByPolicy: true` — the routing policy's `authorizedCrossModel` list
 * is the only thing that can produce one, so "a concrete model was silently
 * replaced" has no representation in this contract.
 */
export const inferenceRouteSwitchDetailSchema = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('deployment'),
      modelReference: modelReferenceSchema,
      toProvider: inferenceProviderSlugSchema,
      toDeploymentId: deploymentIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      scope: z.literal('model'),
      /**
       * The UNPINNED model line the customer asked for (`<publisher>/<model>`,
       * never `@revision`). A request that pinned a revision asked for exactly
       * those weights and is served or refused, never substituted — so for such
       * a request there is no value that satisfies this field, and the event
       * cannot be constructed at all.
       */
      requestedModelId: modelIdSchema,
      fromModelReference: modelReferenceSchema,
      toModelReference: modelReferenceSchema,
      toProvider: inferenceProviderSlugSchema,
      /** Literal `true`: an unauthorized cross-model switch cannot be reported. */
      authorizedByPolicy: z.literal(true),
    })
    .strict(),
]);

/** Why a route changed mid-request. */
export const inferenceRouteSwitchReasonSchema = z.enum([
  'deployment_unavailable',
  'provider_error',
  'provider_timeout',
  'provider_overloaded',
  'rate_limited',
  'capacity',
  'policy_preference',
]);

/**
 * The customer-visible notice that an allowed route switch occurred.
 *
 * Emitted in-stream rather than only recorded on the receipt, because a
 * customer comparing two answers needs to know that the second one came from
 * somewhere else while they are reading it.
 */
export const inferenceStreamRouteSwitchEventSchema = z.object({
  /** See `version.ts`: each stream event is a whole message on the wire. */
  schemaVersion: z.literal(1),
  type: z.literal('route_switch'),
  requestId: requestIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  reason: inferenceRouteSwitchReasonSchema,
  detail: inferenceRouteSwitchDetailSchema,
  occurredAt: inferenceTimestampSchema,
});

/**
 * A terminal error. The stream ends here; no `done` follows, so a client that
 * saw an error never also has to reconcile a success.
 */
export const inferenceStreamErrorEventSchema = z.object({
  /** See `version.ts`: each stream event is a whole message on the wire. */
  schemaVersion: z.literal(1),
  type: z.literal('error'),
  requestId: requestIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  /** Carries its own `schemaVersion`: the same body is returned non-streaming. */
  error: inferenceErrorSchema,
});

/** Why generation stopped. */
export const inferenceFinishReasonSchema = z.enum([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'cancelled',
]);

/**
 * The successful terminal event.
 *
 * `receiptId` is present once settlement has produced one, giving a customer a
 * direct handle on the exact amount charged rather than a telemetry estimate.
 */
export const inferenceStreamDoneEventSchema = z.object({
  /** See `version.ts`: each stream event is a whole message on the wire. */
  schemaVersion: z.literal(1),
  type: z.literal('done'),
  requestId: requestIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  generationId: generationIdSchema.optional(),
  finishReason: inferenceFinishReasonSchema,
  receiptId: z.string().min(1).max(128).optional(),
  completedAt: inferenceTimestampSchema,
});

/**
 * Every event a normalized stream can carry.
 *
 * Discriminated on `type`, so a consumer that meets an unknown event fails at
 * the parse instead of falling into a default branch that treats it as output.
 */
export const inferenceStreamEventSchema = z.discriminatedUnion('type', [
  inferenceStreamStartEventSchema,
  inferenceStreamDeltaEventSchema,
  inferenceStreamToolCallEventSchema,
  inferenceStreamUsageEventSchema,
  inferenceStreamRouteSwitchEventSchema,
  inferenceStreamErrorEventSchema,
  inferenceStreamDoneEventSchema,
]);

export type InferenceStreamStartEvent = z.infer<typeof inferenceStreamStartEventSchema>;
export type InferenceStreamDeltaEvent = z.infer<typeof inferenceStreamDeltaEventSchema>;
export type InferenceStreamToolCallEvent = z.infer<typeof inferenceStreamToolCallEventSchema>;
export type InferenceStreamUsageEvent = z.infer<typeof inferenceStreamUsageEventSchema>;
export type InferenceRouteSwitchDetail = z.infer<typeof inferenceRouteSwitchDetailSchema>;
export type InferenceRouteSwitchReason = z.infer<typeof inferenceRouteSwitchReasonSchema>;
export type InferenceStreamRouteSwitchEvent = z.infer<
  typeof inferenceStreamRouteSwitchEventSchema
>;
export type InferenceStreamErrorEvent = z.infer<typeof inferenceStreamErrorEventSchema>;
export type InferenceFinishReason = z.infer<typeof inferenceFinishReasonSchema>;
export type InferenceStreamDoneEvent = z.infer<typeof inferenceStreamDoneEventSchema>;
export type InferenceStreamEvent = z.infer<typeof inferenceStreamEventSchema>;
