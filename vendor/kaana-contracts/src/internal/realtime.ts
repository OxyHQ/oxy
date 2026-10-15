/**
 * The signed realtime session request and the server events that name the
 * serving provider and deployment.
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/realtime.ts`) by Kaana ADR 0002.
 */

import { z } from 'zod';
import { realtimeSessionKindSchema, realtimeSessionTransportSchema } from '../public/catalogue.js';
import {
  inferenceTimestampSchema,
  modelReferenceSchema,
  requestIdSchema,
} from '../public/identifiers.js';
import { usageQuantitySchema, usageSourceSchema } from '../public/money.js';
import { routingPolicyReferenceSchema } from '../public/policy.js';
import { inferenceFinishReasonSchema } from '../public/streamEvents.js';
import {
  MAX_REALTIME_RESUME_WINDOW_MS,
  realtimeCommandAcceptedEventSchema,
  realtimeCommandIdSchema,
  realtimeConfigIssues,
  realtimeInputAudioClearedEventSchema,
  realtimeInputAudioCommittedEventSchema,
  realtimeItemAddedEventSchema,
  realtimeItemDeletedEventSchema,
  realtimeItemDoneEventSchema,
  realtimeItemTruncatedEventSchema,
  realtimeOutputAudioDeltaEventSchema,
  realtimeOutputAudioDoneEventSchema,
  realtimeResponseCreatedEventSchema,
  realtimeResponseIdSchema,
  realtimeResponseStatusSchema,
  realtimeSessionCloseReasonSchema,
  realtimeSessionConfigSchema,
  realtimeSessionLimitsSchema,
  realtimeSessionResumedEventSchema,
  realtimeSessionUpdatedEventSchema,
  realtimeSpeechStartedEventSchema,
  realtimeSpeechStoppedEventSchema,
  realtimeTextDeltaEventSchema,
  realtimeToolCallEventSchema,
  realtimeTranscriptDeltaEventSchema,
  realtimeTranscriptDoneEventSchema,
} from '../public/realtime.js';
import { inferenceAttributionSchema } from './attribution.js';
import { inferenceErrorSchema } from './errors.js';
import { deploymentIdSchema, inferenceProviderSlugSchema } from './identifiers.js';
import { authorizedRouteSchema } from './routing.js';

const sequenceSchema = z.number().int().nonnegative().safe();

/**
 * What the edge records about the session CALL. Strict for the reason
 * `clientRequestMetadataSchema` is: this object is where an IP would be added.
 */
export const realtimeClientMetadataSchema = z
  .object({
    /** The public path, e.g. `/v1/realtime`. */
    endpoint: z.string().min(1).max(256),
    clientSessionId: z.string().min(1).max(128).optional(),
    receivedAt: inferenceTimestampSchema,
    labels: z.record(z.string(), z.string().max(256)).optional(),
  })
  .strict();

const modelLineOf = (reference: string): string => {
  const at = reference.indexOf('@');
  return at === -1 ? reference : reference.slice(0, at);
};

/**
 * The signed request that opens a session: the first frame of its connection.
 */
export const realtimeSessionRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    attribution: inferenceAttributionSchema,
    /** The model the caller named, pinned or not. Never a routing profile. */
    modelReference: modelReferenceSchema,
    kind: realtimeSessionKindSchema,
    transport: realtimeSessionTransportSchema,
    config: realtimeSessionConfigSchema,
    limits: realtimeSessionLimitsSchema,
    client: realtimeClientMetadataSchema,
    routingPolicy: routingPolicyReferenceSchema,
    /** In preference order, tried only until one opens. All `same_model`. */
    authorizedRoutes: z.array(authorizedRouteSchema).min(1),
  })
  .superRefine((request, ctx) => {
    const { config } = request;
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });

    if (request.limits.idleTimeoutMs > request.limits.maxDurationMs) {
      issue(['limits', 'idleTimeoutMs'], 'an idle timeout cannot outlast the session');
    }

    for (const found of realtimeConfigIssues(request.kind, config)) {
      issue(['config', ...found.path], found.message);
    }

    // A session is never substituted: the conversation it holds belongs to one
    // model, so every route serves the line the caller named, and a pinned
    // request is served on exactly the revision it pinned.
    const line = modelLineOf(request.modelReference);
    const pinned = request.modelReference.includes('@');
    for (const [index, route] of request.authorizedRoutes.entries()) {
      if (route.substitution !== 'same_model' || modelLineOf(route.modelReference) !== line) {
        issue(['authorizedRoutes', index], 'every route of a session serves the model it named');
      }
      if (pinned && route.modelReference !== request.modelReference) {
        issue(
          ['authorizedRoutes', index, 'modelReference'],
          'a pinned session is served on exactly the revision it pinned',
        );
      }
    }
    const deployments = request.authorizedRoutes.map((route) => route.deploymentId);
    if (new Set(deployments).size !== deployments.length) {
      issue(
        ['authorizedRoutes'],
        'each deployment appears at most once in the authorized route list',
      );
    }
  });

const eventBase = {
  /** See `version.ts`: each event is a whole message on the wire. */
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  /** One monotonic sequence per session, from 0; what makes a replay detectable. */
  sequence: sequenceSchema,
  /** The command this event answers, when it answers one. */
  commandId: realtimeCommandIdSchema.optional(),
};

/**
 * The session opened. Names the revision-pinned model, the serving provider and
 * the exact deployment — fixed for the rest of the session — and the effective
 * configuration and limits. `deploymentId` is for settlement: like the usage
 * event's, it is not rendered to the customer.
 */
export const realtimeSessionCreatedEventSchema = z.object({
  ...eventBase,
  type: z.literal('session.created'),
  resolvedModelReference: modelReferenceSchema,
  servingProvider: inferenceProviderSlugSchema,
  deploymentId: deploymentIdSchema,
  kind: realtimeSessionKindSchema,
  config: realtimeSessionConfigSchema,
  limits: realtimeSessionLimitsSchema,
  resumeWindowMs: z.number().int().nonnegative().max(MAX_REALTIME_RESUME_WINDOW_MS),
  startedAt: inferenceTimestampSchema,
  expiresAt: inferenceTimestampSchema,
});

/**
 * A response ended, with the units it consumed — measurement evidence, as on
 * the one-shot usage event. A cancelled or failed response still consumed what
 * it consumed, so its units are reported too.
 */
export const realtimeResponseDoneEventSchema = z.object({
  ...eventBase,
  type: z.literal('response.done'),
  responseId: realtimeResponseIdSchema,
  status: realtimeResponseStatusSchema,
  finishReason: inferenceFinishReasonSchema.optional(),
  deploymentId: deploymentIdSchema,
  units: z.array(usageQuantitySchema),
  usageSource: usageSourceSchema,
});

/**
 * An error. `fatal: false` refuses one command and the session continues;
 * `fatal: true` is followed by `session.closed` and nothing else.
 */
export const realtimeErrorEventSchema = z.object({
  ...eventBase,
  type: z.literal('error'),
  fatal: z.boolean(),
  error: inferenceErrorSchema,
});

/**
 * The terminal event. Carries the session's total units; `deploymentId` is
 * absent only when no route ever opened, in which case nothing was consumed.
 */
export const realtimeSessionClosedEventSchema = z.object({
  ...eventBase,
  type: z.literal('session.closed'),
  reason: realtimeSessionCloseReasonSchema,
  deploymentId: deploymentIdSchema.optional(),
  units: z.array(usageQuantitySchema),
  usageSource: usageSourceSchema,
  closedAt: inferenceTimestampSchema,
});

/** Every event a session can emit. */
export const realtimeServerEventSchema = z
  .discriminatedUnion('type', [
    realtimeSessionCreatedEventSchema,
    realtimeSessionUpdatedEventSchema,
    realtimeSessionResumedEventSchema,
    realtimeCommandAcceptedEventSchema,
    realtimeItemAddedEventSchema,
    realtimeItemDoneEventSchema,
    realtimeItemDeletedEventSchema,
    realtimeItemTruncatedEventSchema,
    realtimeSpeechStartedEventSchema,
    realtimeSpeechStoppedEventSchema,
    realtimeInputAudioCommittedEventSchema,
    realtimeInputAudioClearedEventSchema,
    realtimeResponseCreatedEventSchema,
    realtimeOutputAudioDeltaEventSchema,
    realtimeOutputAudioDoneEventSchema,
    realtimeTranscriptDeltaEventSchema,
    realtimeTranscriptDoneEventSchema,
    realtimeTextDeltaEventSchema,
    realtimeToolCallEventSchema,
    realtimeResponseDoneEventSchema,
    realtimeErrorEventSchema,
    realtimeSessionClosedEventSchema,
  ])
  .superRefine((event, ctx) => {
    // Each unit is reported once, as a total — the rule every usage record in
    // this contract holds. Checked on the union because a discriminated union's
    // options must stay plain objects.
    if (event.type !== 'response.done' && event.type !== 'session.closed') return;
    const units = event.units.map((quantity) => quantity.unit);
    if (new Set(units).size !== units.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['units'],
        message: 'each unit is reported at most once',
      });
    }
  });

export type RealtimeClientMetadata = z.infer<typeof realtimeClientMetadataSchema>;
export type RealtimeSessionRequest = z.infer<typeof realtimeSessionRequestSchema>;
export type RealtimeServerEvent = z.infer<typeof realtimeServerEventSchema>;
