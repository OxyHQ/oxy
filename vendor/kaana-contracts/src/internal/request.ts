/**
 * The signed Oxy→Kaana request envelope (versions 1–4).
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/request.ts`) by Kaana ADR 0002.
 */

import { z } from 'zod';
import { inferenceApiFormatSchema, inferenceModalitySchema } from '../public/catalogue.js';
import { decisionInputSchema } from '../public/decisions.js';
import { idempotencyKeySchema, inferenceTimestampSchema } from '../public/identifiers.js';
import {
  inferenceAudioOutputParametersSchema,
  inferenceMessageSchema,
  inferenceReasoningSchema,
  inferenceSpeechParametersSchema,
  responseFormatSchema,
  samplingParametersSchema,
  toolChoiceSchema,
  toolDefinitionSchema,
} from '../public/messages.js';
import { routingPolicyReferenceSchema } from '../public/policy.js';
import { inferenceAttributionSchema } from './attribution.js';
import {
  PRIVATE_AUTO_REQUEST_ENVELOPE_VERSION,
  privateAutoExecutionSchema,
  privateAutoInputSchema,
} from './privateAutoExecution.js';
import { authorizedRouteSchema, routingTargetSchema } from './routing.js';
import { SCOPED_REQUEST_ENVELOPE_VERSION, scopedExecutionSchema } from './scopedExecution.js';

/**
 * The request's input.
 *
 * Three formats, because the modalities genuinely differ: a chat request is a
 * conversation, an embedding request is a string or a batch of strings, and
 * pretending the latter is a one-message conversation loses the batch boundary
 * that both metering and provider translation depend on.
 */
export const inferenceInputSchema = z.discriminatedUnion('format', [
  z.object({ format: z.literal('decisions'), decisions: decisionInputSchema }).strict(),
  z
    .object({
      format: z.literal('messages'),
      messages: z.array(inferenceMessageSchema).min(1),
    })
    .strict(),
  z.object({ format: z.literal('text'), text: z.string() }).strict(),
  z
    .object({
      format: z.literal('text_batch'),
      texts: z.array(z.string()).min(1).max(2048),
    })
    .strict(),
]);

/**
 * What the edge records about the CALL, as opposed to its content.
 *
 * `.strict()` is a privacy control, not tidiness. Oxy never persists a user IP
 * — raw, hashed or geo-derived — and this object is the natural place somebody
 * would add one "for security". Strict means a producer that attaches `ip`,
 * `country`, `userAgent` or `forwardedFor` fails the parse instead of quietly
 * shipping it into the data plane and the telemetry stream behind it.
 *
 * `labels` is customer-supplied cost-attribution metadata (a team name, a
 * feature flag). It is echoed on the receipt, so it must never be used for
 * anything the customer would not want to read back to themselves.
 */
export const clientRequestMetadataSchema = z
  .object({
    /** The public dialect the customer called. The response is rendered in it. */
    apiFormat: inferenceApiFormatSchema,
    /** The public path, e.g. `/v1/responses`. */
    endpoint: z.string().min(1).max(256),
    /** The customer's own correlation id, when they sent one. */
    clientRequestId: z.string().min(1).max(128).optional(),
    receivedAt: inferenceTimestampSchema,
    labels: z.record(z.string(), z.string().max(256)).optional(),
  })
  .strict();

/**
 * The model LINE a reference names, with any pinned revision dropped.
 *
 * Substitution is a question about the line — `anthropic/claude-opus-5` — never
 * about the revision, so the comparisons below have to be made on it. Same split
 * `resolveEdgeRoute` makes on the way in.
 */
const modelLineOf = (reference: string): string => {
  const at = reference.indexOf('@');
  return at === -1 ? reference : reference.slice(0, at);
};

/**
 * The canonical internal request Oxy forwards to the data plane.
 *
 * `target` distinguishes the two questions a caller can ask — "serve THIS
 * model" versus "choose one for me" — structurally. Everything downstream that
 * must not silently substitute a model reads that discriminant rather than
 * inferring intent from a string.
 */
const inferenceRequestObjectSchema = z.object({
  /** See `version.ts`: this is the Oxy→data-plane request envelope. */
  schemaVersion: z.literal(2),
  /** Recognized so v2 refuses rather than silently stripping a restriction. */
  scopedExecution: scopedExecutionSchema.optional(),
  attribution: inferenceAttributionSchema,
  target: routingTargetSchema,
  modality: inferenceModalitySchema,
  input: inferenceInputSchema,
  stream: z.boolean(),
  maxOutputTokens: z.number().int().positive().safe().optional(),
  sampling: samplingParametersSchema,
  /** Absent means the route's own default reasoning behaviour. */
  reasoning: inferenceReasoningSchema.optional(),
  speech: inferenceSpeechParametersSchema.optional(),
  /** Spoken output from a conversational model. Contract set 3.2.0. */
  audioOutput: inferenceAudioOutputParametersSchema.optional(),
  tools: z.array(toolDefinitionSchema).default([]),
  toolChoice: toolChoiceSchema.optional(),
  responseFormat: responseFormatSchema.optional(),
  client: clientRequestMetadataSchema,
  /** Present when the operation is safe to deduplicate on retry. */
  idempotencyKey: idempotencyKeySchema.optional(),
  /** The exact policy revision this request is served under. */
  routingPolicy: routingPolicyReferenceSchema,
  /**
   * The routes the control plane has already authorized for this request, in
   * PREFERENCE ORDER. The first entry is the primary route Oxy resolved; the
   * data plane fails over by taking the next one.
   *
   * This is what closes the gap ADR 0010's amendment left open. That amendment
   * assigns the data plane "failover within the destinations the policy
   * authorized" — and the envelope named no destinations, so a data plane could
   * only fail over by re-deriving the customer's policy from values it does not
   * have. Enumerating the survivors instead means a route switch outside the
   * policy is impossible BY CONSTRUCTION rather than by two enforcement engines
   * agreeing in two languages.
   *
   * **Absent means no failover is authorized, never "choose freely."** It is
   * the state every envelope built before this field existed is in, and the
   * behaviour a data plane that reads no list must already have: resolve the
   * `target` and serve it or fail. Permission is granted by an ENTRY, so its
   * absence can only ever narrow, and there is no reading of an absent list
   * that widens what may be served.
   *
   * An EMPTY list is refused rather than treated as that state. `[]` would say
   * "no route is authorized at all", which contradicts an envelope that was
   * built to be served, and it is exactly the "permission granted, destination
   * unnamed" shape `authorizedRouteSchema` exists to make unrepresentable.
   *
   * No price rides here. Oxy sized the hold against the most expensive route
   * the policy permits (`usageReservationRequestSchema.ceilingPriceVersionId`),
   * and every entry is one that policy permitted, so no failover among them can
   * exceed it. A per-route price would also be a second authority for ranking,
   * beside the order this list already carries.
   */
  authorizedRoutes: z.array(authorizedRouteSchema).min(1).optional(),
});

export const inferenceRequestSchema = inferenceRequestObjectSchema.superRefine((request, ctx) => {
  if (request.scopedExecution !== undefined)
    ctx.addIssue({
      code: 'custom',
      path: ['scopedExecution'],
      message: 'Scoped execution requires envelope v3.',
    });
  if (request.input.format === 'decisions' || request.client.apiFormat === 'decisions') {
    const exactModel =
      request.target.kind === 'model' && request.target.modelReference.includes('@');
    const foreignRoute = request.authorizedRoutes?.some(
      (route) =>
        request.target.kind !== 'model' ||
        route.modelReference !== request.target.modelReference ||
        route.substitution !== 'same_model',
    );
    if (
      request.input.format !== 'decisions' ||
      request.client.apiFormat !== 'decisions' ||
      request.modality !== 'text' ||
      request.stream ||
      !exactModel ||
      foreignRoute ||
      request.maxOutputTokens !== undefined ||
      Object.keys(request.sampling).length > 0 ||
      request.tools.length > 0 ||
      request.toolChoice !== undefined ||
      request.responseFormat !== undefined ||
      request.reasoning !== undefined ||
      request.speech !== undefined ||
      request.audioOutput !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['input'],
        message:
          'Decisions require exact-model typed nonstreaming input without generation controls or model substitution.',
      });
    }
  }
  const isSpeech = request.client.apiFormat === 'audio_speech';
  // Contract set 4.0.0 (Kaana ADR 0002, decision 8): speech may stream. Each
  // adapter still refuses in `Translate` what its provider cannot stream.
  if (
    isSpeech &&
    request.speech !== undefined &&
    (request.modality !== 'audio' || request.input.format !== 'text')
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['speech'],
      message: 'speech requires audio modality, text input and parameters',
    });
  }
  if (!isSpeech && request.speech !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['speech'],
      message: 'speech parameters require the audio_speech API format',
    });
  }
  if (request.audioOutput !== undefined) {
    if (request.client.apiFormat !== 'chat_completions') {
      ctx.addIssue({
        code: 'custom',
        path: ['audioOutput'],
        message:
          'spoken output from a conversational model requires the chat_completions API format',
      });
    }
    if (request.modality !== 'audio' || request.input.format !== 'messages') {
      ctx.addIssue({
        code: 'custom',
        path: ['audioOutput'],
        message: 'spoken output requires audio modality and a messages input',
      });
    }
    if (request.stream && request.audioOutput.format !== 'pcm') {
      ctx.addIssue({
        code: 'custom',
        path: ['audioOutput', 'format'],
        message: 'streamed spoken output is pcm; the other formats exist only whole',
      });
    }
  }
  if (request.toolChoice !== undefined && request.tools.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['toolChoice'],
      message: 'a tool choice requires at least one tool definition',
    });
  }

  const toolNames = request.tools.map((tool) => tool.name);
  if (new Set(toolNames).size !== toolNames.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['tools'],
      message: 'tool names must be unique within one request',
    });
  }

  const routes = request.authorizedRoutes;
  // The emptiness is RE-CHECKED rather than assumed away by `.min(1)`. A
  // failed `.min()` marks the parse dirty rather than aborting it, so zod runs
  // this refinement with the empty array still in hand; `[]` is already
  // refused above, and reading `routes[0]` here would throw instead.
  if (routes === undefined || routes.length === 0) return;

  const primary = routes[0];

  // The primary is not a substitution for itself, and every `substitution`
  // value is read RELATIVE to it. A list whose first entry claims to be a
  // cross-model substitute names no original to have substituted for.
  if (primary.substitution !== 'same_model') {
    ctx.addIssue({
      code: 'custom',
      path: ['authorizedRoutes', 0, 'substitution'],
      message: 'the first authorized route is the primary and cannot be a substitution',
    });
  }

  const primaryLine = modelLineOf(primary.modelReference);

  // A request that named a concrete model is served or refused, never
  // substituted, and one that PINNED a revision is served on exactly those
  // weights. Both checks are on the primary, because a primary that already
  // drifted makes every entry after it a substitution nobody labelled.
  if (request.target.kind === 'model') {
    const targetReference = request.target.modelReference;
    const targetIsPinned = targetReference.includes('@');

    if (targetIsPinned && primary.modelReference !== targetReference) {
      ctx.addIssue({
        code: 'custom',
        path: ['authorizedRoutes', 0, 'modelReference'],
        message: 'a pinned request is served on exactly the revision it pinned',
      });
    }

    if (!targetIsPinned && primaryLine !== targetReference) {
      ctx.addIssue({
        code: 'custom',
        path: ['authorizedRoutes', 0, 'modelReference'],
        message: 'the primary authorized route must serve the model the request named',
      });
    }

    if (targetIsPinned) {
      for (const [index, route] of routes.entries()) {
        if (route.substitution === 'cross_model') {
          ctx.addIssue({
            code: 'custom',
            path: ['authorizedRoutes', index, 'substitution'],
            message: 'a request that pinned a revision authorizes no cross-model substitute',
          });
        }
      }
    }
  }

  for (const [index, route] of routes.entries()) {
    const line = modelLineOf(route.modelReference);

    // A mislabelled entry is the whole failure mode: `same_model` on a
    // different model line is a substitution wearing the label that needs no
    // authorization, and `cross_model` on the same line claims an
    // authorization the customer never had to give.
    if (route.substitution === 'same_model' && line !== primaryLine) {
      ctx.addIssue({
        code: 'custom',
        path: ['authorizedRoutes', index, 'substitution'],
        message: `route ${index} serves ${line}, not ${primaryLine}, so it is a cross-model substitute`,
      });
    }

    if (route.substitution === 'cross_model' && line === primaryLine) {
      ctx.addIssue({
        code: 'custom',
        path: ['authorizedRoutes', index, 'substitution'],
        message: `route ${index} serves ${primaryLine}, so it is same-model failover`,
      });
    }
  }

  // Failing over to the deployment that just failed is not failover. The
  // duplicate would also make `routeSwitches` count a switch that changed
  // nothing.
  const deployments = routes.map((route) => route.deploymentId);
  if (new Set(deployments).size !== deployments.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['authorizedRoutes'],
      message: 'each deployment appears at most once in the authorized route list',
    });
  }
});

/** Explicit restrictive generation: old v2 receivers reject this version whole. */
export const scopedInferenceRequestSchema = inferenceRequestObjectSchema
  .extend({
    schemaVersion: z.literal(SCOPED_REQUEST_ENVELOPE_VERSION),
    scopedExecution: scopedExecutionSchema,
  })
  .superRefine((request, ctx) => {
    const { scopedExecution: scope, ...base } = request;
    const legacy = inferenceRequestSchema.safeParse({ ...base, schemaVersion: 2 });
    if (!legacy.success)
      for (const issue of legacy.error.issues)
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    const principal = request.attribution.principal;
    const route = request.authorizedRoutes?.[0];
    if (
      request.input.format !== 'decisions' ||
      request.client.apiFormat !== 'decisions' ||
      scope.requestId !== request.attribution.requestId ||
      scope.idempotencyKey !== request.idempotencyKey ||
      scope.principal.accountId !== principal.billing.accountId ||
      scope.principal.applicationId !== principal.applicationId ||
      scope.principal.credentialId !== principal.credentialId ||
      scope.principal.environment !== principal.environment ||
      scope.policy.routingPolicyId !== request.routingPolicy.routingPolicyId ||
      scope.policy.policyVersion !== request.routingPolicy.policyVersion ||
      request.authorizedRoutes?.length !== 1 ||
      route?.customerProviderCredential !== undefined ||
      route?.deploymentId !== scope.deploymentId ||
      route?.provider !== scope.provider ||
      route?.modelReference !== scope.modelReference ||
      request.target.kind !== 'model' ||
      request.target.modelReference !== scope.modelReference
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['scopedExecution'],
        message:
          'Scoped execution must restrict the exact attributed decisions request and one platform route.',
      });
    }
  });

/** Private repeated Auto is independently negotiated, never a v3 fixture renewal. */
export const privateAutoInferenceRequestSchema = inferenceRequestObjectSchema
  .omit({ scopedExecution: true })
  .extend({
    schemaVersion: z.literal(PRIVATE_AUTO_REQUEST_ENVELOPE_VERSION),
    privateAutoExecution: privateAutoExecutionSchema,
  })
  .strict()
  .superRefine((request, ctx) => {
    const { privateAutoExecution: permit, ...base } = request;
    const legacy = inferenceRequestSchema.safeParse({ ...base, schemaVersion: 2 });
    if (!legacy.success)
      for (const issue of legacy.error.issues)
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    const input = privateAutoInputSchema.safeParse(request.input);
    if (!input.success)
      for (const issue of input.error.issues)
        ctx.addIssue({ code: 'custom', path: ['input', ...issue.path], message: issue.message });
    const principal = request.attribution.principal;
    const route = request.authorizedRoutes?.[0];
    if (
      request.attribution.userId !== undefined ||
      request.client.apiFormat !== 'decisions' ||
      permit.requestId !== request.attribution.requestId ||
      permit.operationId !== request.idempotencyKey ||
      permit.principal.accountId !== principal.billing.accountId ||
      permit.principal.applicationId !== principal.applicationId ||
      permit.principal.credentialId !== principal.credentialId ||
      permit.principal.environment !== principal.environment ||
      !principal.inferenceScopes.includes('inference:invoke') ||
      request.client.endpoint !== '/internal/auto-classification' ||
      permit.policy.routingPolicyId !== request.routingPolicy.routingPolicyId ||
      permit.policy.policyVersion !== request.routingPolicy.policyVersion ||
      request.authorizedRoutes?.length !== 1 ||
      route?.customerProviderCredential !== undefined ||
      route?.deploymentId !== permit.deploymentId ||
      route?.provider !== permit.provider ||
      route?.modelReference !== permit.modelReference ||
      request.target.kind !== 'model' ||
      request.target.modelReference !== permit.modelReference ||
      route.regions.length !== permit.regions.length ||
      route.regions.some((region) => !permit.regions.includes(region)) ||
      Date.parse(permit.runtimeExpiresAt) <= Date.parse(request.client.receivedAt) ||
      Date.parse(permit.runtimeExpiresAt) > Date.parse(request.client.receivedAt) + 1000
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['privateAutoExecution'],
        message: 'Private Auto must bind one exact attributed decisions child and platform route.',
      });
    }
  });

export type ScopedInferenceRequest = z.infer<typeof scopedInferenceRequestSchema>;
export type PrivateAutoInferenceRequest = z.infer<typeof privateAutoInferenceRequestSchema>;
export type InferenceInput = z.infer<typeof inferenceInputSchema>;
export type ClientRequestMetadata = z.infer<typeof clientRequestMetadataSchema>;
export type InferenceRequest = z.infer<typeof inferenceRequestSchema>;
