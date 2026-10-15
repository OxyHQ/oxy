/**
 * The signed Oxy↔Kaana stream: the public events plus the ones that name the
 * serving provider and deployment.
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/streamEvents.ts`) by Kaana ADR 0002.
 */

import { z } from 'zod';
import {
  generationIdSchema,
  inferenceTimestampSchema,
  modelIdSchema,
  modelReferenceSchema,
  requestIdSchema,
} from '../public/identifiers.js';
import { usageQuantitySchema, usageSourceSchema } from '../public/money.js';
import {
  inferenceStreamAudioEventSchema,
  inferenceStreamDeltaEventSchema,
  inferenceStreamDoneEventSchema,
  inferenceStreamToolCallEventSchema,
} from '../public/streamEvents.js';
import { inferenceErrorSchema } from './errors.js';
import { deploymentIdSchema, inferenceProviderSlugSchema } from './identifiers.js';

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
 * Metered units for the request so far.
 *
 * Units only — no money. What a customer is charged is the ledger's answer,
 * derived from these units and a price version at settlement; a cost quoted by
 * the data plane would be a second, unauthoritative answer to the same
 * question.
 *
 * ## This event is MEASUREMENT EVIDENCE, never a settleable record
 *
 * `normalizedUsageReportSchema` is the only shape a settlement is written from,
 * and this event is deliberately NOT a subset of it that could be widened into
 * one. It carries units and a source; a report additionally carries the
 * attribution block, the outcome, the resolved route, the route-switch count and
 * the two timestamps. Every one of those is knowable only by one END of the
 * request rather than by the frame: the outcome only by the edge, which is the
 * only party that knows whether the CLIENT cancelled, and the route record only
 * by the data plane.
 *
 * So the event is not widened, and that is a decision rather than an omission.
 * Adding the route record and the attribution block here would repeat both on
 * EVERY usage frame of every stream, and each repetition is one more place two
 * frames of one stream could disagree about which route served it — a second
 * source of truth per frame, for fields no consumer of a progress signal reads.
 *
 * **What the edge may do with it, and what it may not.** The units are exact and
 * may be settled; the record around them may not be inferred. When no terminal
 * report arrives — the ordinary case for a client disconnect, since the report
 * frame can no longer be delivered to a connection that is gone — the edge
 * settles the units from the last such event and takes the OUTCOME from itself,
 * never from the event. Its outcome is then `cancelled`, `partial` or `failed`;
 * it is never `completed`, because nothing here can witness that the customer
 * received the whole answer. Zero units marked `estimated` is the arm for no
 * evidence at ALL, not for a disconnect that reported some.
 */
export const inferenceStreamUsageEventSchema = z.object({
  /** See `version.ts`: each stream event is a whole message on the wire. */
  schemaVersion: z.literal(2),
  type: z.literal('usage'),
  requestId: requestIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  /** Exact deployment whose metering produced these partial units. */
  deploymentId: deploymentIdSchema,
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

/**
 * Every event a normalized stream can carry.
 *
 * Discriminated on `type`, so a consumer that meets an unknown event fails at
 * the parse instead of falling into a default branch that treats it as output.
 */
export const inferenceStreamEventSchema = z.discriminatedUnion('type', [
  inferenceStreamStartEventSchema,
  inferenceStreamDeltaEventSchema,
  inferenceStreamAudioEventSchema,
  inferenceStreamToolCallEventSchema,
  inferenceStreamUsageEventSchema,
  inferenceStreamRouteSwitchEventSchema,
  inferenceStreamErrorEventSchema,
  inferenceStreamDoneEventSchema,
]);

export type InferenceStreamStartEvent = z.infer<typeof inferenceStreamStartEventSchema>;
export type InferenceStreamUsageEvent = z.infer<typeof inferenceStreamUsageEventSchema>;
export type InferenceRouteSwitchDetail = z.infer<typeof inferenceRouteSwitchDetailSchema>;
export type InferenceRouteSwitchReason = z.infer<typeof inferenceRouteSwitchReasonSchema>;
export type InferenceStreamRouteSwitchEvent = z.infer<typeof inferenceStreamRouteSwitchEventSchema>;
export type InferenceStreamErrorEvent = z.infer<typeof inferenceStreamErrorEventSchema>;
export type InferenceStreamEvent = z.infer<typeof inferenceStreamEventSchema>;
