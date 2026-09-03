/**
 * The PUBLIC dialects of the Oxy inference edge, and their normalization into
 * the one internal envelope (issue #972 workstream 4, ADR 0010).
 *
 * Two request shapes reach the edge and exactly one shape leaves it:
 *
 *  - `POST /v1/responses` — Oxy's own, and the preferred endpoint. It is free to
 *    express what the OpenAI schema cannot: a routing-profile target, an exact
 *    revision pin, cost-attribution labels.
 *  - `POST /v1/chat/completions` — the compatibility surface. It speaks the flat
 *    OpenAI request and response shapes so an unmodified OpenAI SDK works, and it
 *    gains NO Oxy-specific request fields. A capability with no OpenAI
 *    representation lives on `/v1/responses`; Oxy-specific response metadata
 *    rides in headers so the body stays parseable by a stock client.
 *
 * ## Why these schemas live in the API and not in `@oxyhq/contracts`
 *
 * `@oxyhq/contracts` is the Oxy↔data-plane contract: shapes two independently
 * deployed services must agree on. These two are neither. They are what a THIRD
 * PARTY's client sends — one of them defined by another vendor — and they are
 * normalized into `inferenceRequestSchema` before anything downstream sees them.
 * Publishing them would be publishing a promise about somebody else's schema.
 *
 * ## `.strict()` on both, and what that costs
 *
 * An unknown field is rejected rather than ignored. For the compatibility
 * surface that is the sharper choice — a stock SDK sending a parameter Oxy does
 * not implement gets told so, rather than having it silently dropped and
 * wondering why `logprobs` had no effect. The maintenance cost is a 400 whenever
 * OpenAI adds a field; the alternative cost is a customer billed for a request
 * that quietly ignored half of what they asked for.
 */

import { z } from 'zod';
import {
  inferenceContentPartSchema,
  inferenceFinishReasonSchema,
  inferenceMessageSchema,
  modelReferenceSchema,
  responseFormatSchema,
  routingProfileIdSchema,
  routingPolicyReferenceSchema,
  routingProfileSlugSchema,
  toolChoiceSchema,
  toolDefinitionSchema,
  usageQuantitySchema,
  type InferenceInput,
  type InferenceMessage,
  type ResponseFormat,
  type RoutingTarget,
  type SamplingParameters,
  type ToolChoice,
  type ToolDefinition,
} from '@oxyhq/contracts';

/* -------------------------------------------------------------------------- */
/*  Shared                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Customer-supplied cost-attribution metadata, echoed on the receipt.
 *
 * Bounded in both directions because it is stored and read back: sixteen keys is
 * a team/feature/environment tag set, not a place to smuggle a payload.
 */
const labelsSchema = z.record(z.string().max(256)).refine(
  (labels) => Object.keys(labels).length <= 16,
  'at most 16 labels may be attached to one request'
);

/** `stop` in the OpenAI dialect: one sequence or a list of them. */
const openAiStopSchema = z.union([
  z.string().min(1).max(256),
  z.array(z.string().min(1).max(256)).max(8),
]);

/* -------------------------------------------------------------------------- */
/*  POST /v1/responses — the preferred endpoint                               */
/* -------------------------------------------------------------------------- */

/** The message-or-text input `/v1/responses` accepts. */
const responsesInputSchema = z.union([
  z.string().min(1),
  z.array(inferenceMessageSchema).min(1),
]);

export const responsesRequestSchema = z
  .object({
    /**
     * `model`, `routingProfile`, and `routingProfileId` are optional fields with
     * a refinement allowing at most one, rather than the discriminated union
     * the shape deserves.
     * An intersection of `.strict()` objects is what a union would need here,
     * and zod parses BOTH sides of an intersection against the whole payload —
     * so every ordinary field (`input`, `stream`, …) would be an unknown key on
     * the target half and the request would never parse. The refinement below
     * restores the exclusivity the union would have carried, and
     * `normalizeResponsesRequest` re-establishes the real discriminated
     * `routingTargetSchema` immediately.
     *
     * NEITHER is also valid: the application's routing policy may carry a
     * `defaultTarget`, which is the whole point of "per-application default
     * model or routing profile". The edge resolves it and refuses only when
     * there is no policy default either.
     */
    model: modelReferenceSchema.optional(),
    routingProfile: routingProfileSlugSchema.optional(),
    /** Exact opaque database identity; never trimmed, normalized, or resolved by slug. */
    routingProfileId: routingProfileIdSchema.optional(),
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
    labels: labelsSchema.optional(),
    /** The caller's own correlation id, echoed on the response. */
    clientRequestId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    const targetFields = [request.model, request.routingProfile, request.routingProfileId].filter(
      (value) => value !== undefined
    );
    if (targetFields.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['model'],
        message: 'name at most one of model, routingProfile, or routingProfileId',
      });
    }
  });

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

/* -------------------------------------------------------------------------- */
/*  POST /v1/chat/completions — the compatibility surface                     */
/* -------------------------------------------------------------------------- */

/**
 * One OpenAI message.
 *
 * `content` accepts both the string form and the parts array, because both are
 * in wide use by real clients and rejecting the string form would fail the stock
 * SDK on its most common call.
 */
const openAiMessageSchema = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(inferenceContentPartSchema)]).nullable().optional(),
    name: z.string().max(128).optional(),
    tool_call_id: z.string().min(1).max(128).optional(),
    tool_calls: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            type: z.literal('function'),
            function: z
              .object({
                name: z.string().min(1).max(128),
                arguments: z.string(),
              })
              .strict(),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

const openAiToolSchema = z
  .object({
    type: z.literal('function'),
    function: z
      .object({
        name: z.string().min(1).max(128),
        description: z.string().max(2000).optional(),
        parameters: z.record(z.unknown()),
        strict: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

const openAiToolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z
    .object({
      type: z.literal('function'),
      function: z.object({ name: z.string().min(1).max(128) }).strict(),
    })
    .strict(),
]);

const openAiResponseFormatSchema = z.union([
  z.object({ type: z.enum(['text', 'json_object']) }).strict(),
  z
    .object({
      type: z.literal('json_schema'),
      json_schema: z
        .object({
          name: z.string().min(1).max(128),
          schema: z.record(z.unknown()),
          strict: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const chatCompletionsRequestSchema = z
  .object({
    /**
     * The canonical Oxy model reference. An OpenAI vendor model name
     * (`gpt-4o`) is not one and does not resolve — the catalogue's identifiers
     * are `<publisher>/<model>`, and accepting a bare vendor name would mean
     * Oxy guessing which publisher a customer meant.
     */
    model: modelReferenceSchema,
    messages: z.array(openAiMessageSchema).min(1),
    max_tokens: z.number().int().positive().safe().optional(),
    max_completion_tokens: z.number().int().positive().safe().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    seed: z.number().int().safe().optional(),
    stop: openAiStopSchema.optional(),
    stream: z.boolean().optional(),
    tools: z.array(openAiToolSchema).max(128).optional(),
    tool_choice: openAiToolChoiceSchema.optional(),
    response_format: openAiResponseFormatSchema.optional(),
    /**
     * OpenAI's end-user attribution field. Carried into the envelope as the
     * DELEGATED user id — attribution only. It never changes which account is
     * charged, and `X-Oxy-User-Id` wins when both are present, because the
     * header is the ecosystem's own delegation channel.
     */
    user: z.string().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.max_tokens !== undefined && request.max_completion_tokens !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['max_completion_tokens'],
        message: 'send max_tokens or max_completion_tokens, not both',
      });
    }
  });

export type ChatCompletionsRequest = z.infer<typeof chatCompletionsRequestSchema>;

/* -------------------------------------------------------------------------- */
/*  GET /v1/generations/:id — the customer's receipt                          */
/* -------------------------------------------------------------------------- */

/**
 * The settled receipt as a customer reads it back.
 *
 * Deliberately NOT `usageReceiptSchema` from `@oxyhq/contracts`, even though the
 * two describe the same settlement. That schema embeds
 * `inferenceAttributionSchema`, which carries the AUTHENTICATED PRINCIPAL —
 * including its effective inference scopes. A stored receipt does not keep
 * those, and it should not: scopes are a fact about a live credential at the
 * moment of a request, not about a charge. Reusing the schema would mean
 * emitting `inferenceScopes: []` on every receipt, which reads as "this caller
 * held no scopes" and is false.
 *
 * So the receipt keeps every field it genuinely stores — including the price
 * SNAPSHOT, so the arithmetic is checkable without the price version still
 * existing — and states its attribution as the three ids the row actually holds.
 */
/* -------------------------------------------------------------------------- */
/*  Later modalities — speech and images                                      */
/* -------------------------------------------------------------------------- */

/**
 * `POST /v1/audio/speech` — text to audio, in the shape a stock OpenAI client
 * sends.
 *
 * ## Only a `characters`-priced route can serve this, and that is enforced by
 * ## arithmetic rather than by a check
 *
 * The ceiling is `input.length` — EXACT, declared, and the unit every real TTS
 * provider actually bills. What this endpoint deliberately does NOT compute is
 * `audio_output_milliseconds`: output duration is characters ÷ speaking rate, and
 * `modelCapabilitiesSchema` declares no speaking rate, so a duration figure would
 * be a guess dressed as a bound. A route priced in duration therefore fails to
 * quote (`quoteUnits` refuses a unit the ceiling omits) and is refused as
 * `no_route_available`. That refusal is the existing code path, not a new branch.
 *
 * `speed` and `voice` are accepted and forwarded because a provider needs them.
 * Neither participates in the ceiling, which is exactly why the ceiling stays
 * sound: `characters` does not vary with either.
 */
export const speechRequestSchema = z
  .object({
    model: modelReferenceSchema,
    /**
     * The text to speak. Bounded so the ceiling cannot be driven arbitrarily high
     * by one request; the edge's own `MAX_REQUEST_BYTES` is the outer bound and
     * this is the per-field one.
     */
    input: z.string().min(1).max(100_000),
    voice: z.string().min(1).max(64),
    response_format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).optional(),
    speed: z.number().min(0.25).max(4).optional(),
    user: z.string().min(1).max(64).optional(),
  })
  .strict();

export type SpeechRequest = z.infer<typeof speechRequestSchema>;

/**
 * `POST /v1/images/generations` — text to image.
 *
 * ## One route per size/quality class, and why that is a catalogue decision
 *
 * The ceiling is `images` = `n`, exact and declared. The open question is not the
 * count but the PRICE: `unitPriceSchema` prices a *unit*, not a
 * `(unit, size, quality)` tuple, so one `images` price per version would make a
 * 1024×1024 standard image and a 1792×1024 HD image cost the same — false for
 * every real provider, by roughly 4x.
 *
 * The resolution needs no contract change, because a price version is scoped to
 * `(modelReference, provider)`: each size/quality class is its own model
 * reference in the catalogue. The route then resolves per class and the ceiling
 * stays exact. The alternative — one route holding at the most expensive class it
 * permits — over-holds AND needs a route field naming the permitted classes,
 * which would be a contracts change.
 *
 * So `size` and `quality` are accepted and forwarded, and they do NOT widen the
 * hold. If a deployment publishes one route serving several classes, that is a
 * catalogue error rather than a ceiling error, and it is recorded here because it
 * is invisible from the endpoint.
 */
export const imageGenerationsRequestSchema = z
  .object({
    model: modelReferenceSchema,
    prompt: z.string().min(1).max(32_000),
    /** OpenAI caps this at 10. Exact, declared, and the whole ceiling. */
    n: z.number().int().min(1).max(10).optional(),
    size: z.string().min(1).max(32).optional(),
    quality: z.string().min(1).max(32).optional(),
    style: z.string().min(1).max(32).optional(),
    response_format: z.enum(['url', 'b64_json']).optional(),
    user: z.string().min(1).max(64).optional(),
  })
  .strict();

export type ImageGenerationsRequest = z.infer<typeof imageGenerationsRequestSchema>;

export const generationReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: z.string().min(1),
    requestId: z.string().min(1),
    generationId: z.string().min(1).optional(),
    applicationId: z.string().min(1),
    credentialId: z.string().min(1),
    /** Attribution only. Never the billing identity (ADR 0007). */
    delegatedUserId: z.string().min(1).optional(),
    environment: z.enum(['development', 'staging', 'production']),
    outcome: z.enum(['completed', 'partial', 'cancelled', 'failed']),
    usageSource: z.enum(['provider_reported', 'oxy_measured', 'estimated']),
    units: z.array(z.object({ unit: z.string(), quantity: z.number().int().nonnegative() })),
    resolvedModelReference: z.string().min(1),
    servingProvider: z.string().min(1),
    priceSnapshot: z.object({
      priceVersionId: z.string().min(1),
      currency: z.string().regex(/^[A-Z]{3}$/),
      unitPrices: z.array(
        z.object({
          unit: z.string(),
          amount: z.string(),
          per: z.number().int().positive(),
          currency: z.string().regex(/^[A-Z]{3}$/),
        })
      ),
    }),
    billedAmount: z.string(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    /** A BYOK request: `billedAmount` is Oxy's fee, not the cost of the tokens. */
    platformFeeOnly: z.boolean(),
    settledAt: z.string().datetime(),
  })
  .strict();

export type GenerationReceipt = z.infer<typeof generationReceiptSchema>;

/** `GET /v1/generations/{id}` — the receipt in the platform's read envelope. */
export const generationReceiptResponseSchema = z
  .object({ data: generationReceiptSchema })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Responses — what each dialect sends back                                  */
/* -------------------------------------------------------------------------- */

/**
 * The SUCCESS bodies of the edge, written down.
 *
 * Until these existed, every operation the OpenAPI generator produced carried
 * `responses: { '200': { description: 'Success' } }` and nothing else — so the
 * published contract described `POST /v1/chat/completions` as returning an
 * undescribed 200, and a generated client typed the return `Any`. A caller could
 * not learn from the contract that a completion comes back in `choices[0].message`.
 *
 * ## Bound to the handlers by the TYPE SYSTEM, not by these comments
 *
 * `routes/inferenceEdge.ts` annotates each body it passes to `res.json` with the
 * matching `z.infer<typeof …>`, so a handler that adds, drops or retypes a field
 * fails `tsc` — which `api-build` already runs. A schema beside a handler that
 * merely resembles it is a claim nobody checks; this one is checked by the
 * compiler. The `@response` tag above each route carries the identifier across to
 * the document.
 *
 * ## Streaming is deliberately NOT described
 *
 * `stream: true` on either dialect answers `text/event-stream` with a frame
 * sequence, and no mainstream OpenAPI generator models an SSE stream usefully —
 * the honest options are an undescribed `text/event-stream` or a fiction. Each
 * schema below describes the NON-STREAMING body only, which is the one a
 * generated client can actually parse. `inferenceStreamEventSchema` in
 * `@oxyhq/contracts` remains the authority on the frames themselves.
 */

/**
 * `POST /v1/responses` — Oxy's own dialect.
 *
 * `.strict()` for the same reason the requests are: a field appearing here that
 * the schema does not name is a change to a published response, and it should
 * fail this package's own tests rather than reach a customer's parser.
 */
export const responsesResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().min(1),
    /** Absent when the data plane reported no generation id for the request. */
    generationId: z.string().min(1).optional(),
    /** The revision that actually served this request, which may differ from the ask. */
    model: z.string().min(1),
    servingProvider: z.string().min(1),
    finishReason: inferenceFinishReasonSchema,
    output: z.array(inferenceMessageSchema),
    usage: z.array(usageQuantitySchema),
    routingPolicy: routingPolicyReferenceSchema,
    /**
     * Oxy's own measurement of this request, in whole milliseconds. Not the round
     * trip a caller measures — see the route's own comment. A streamed request
     * reports none, and a streamed request does not use this schema.
     */
    latencyMs: z.number().int().nonnegative(),
  })
  .strict();

/**
 * `POST /v1/chat/completions` — the OpenAI-compatible dialect.
 *
 * Every field is one a stock OpenAI client reads, spelled the way it spells it.
 * Nothing Oxy-specific appears in the body: the request id, the resolved model,
 * the routing policy and the true finish reason ride in headers, which is the
 * rule that keeps this surface compatible rather than merely similar.
 */
export const chatCompletionResponseSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal('chat.completion'),
    /** Unix seconds, as OpenAI's own field is. */
    created: z.number().int().nonnegative(),
    model: z.string().min(1),
    choices: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          message: z
            .object({
              role: z.literal('assistant'),
              content: z.string(),
              tool_calls: z
                .array(
                  z
                    .object({
                      id: z.string().min(1),
                      type: z.literal('function'),
                      function: z
                        .object({ name: z.string().min(1), arguments: z.string() })
                        .strict(),
                    })
                    .strict()
                )
                .optional(),
            })
            .strict(),
          /**
           * OpenAI's enum, which has neither a `cancelled` nor a `refusal` member.
           * Both are reported as `stop` here and truthfully in
           * `X-Oxy-Finish-Reason` — see `openAiFinishReason`.
           */
          finish_reason: z.string().min(1),
        })
        .strict()
    ),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative(),
        prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative() }).strict(),
        completion_tokens_details: z
          .object({ reasoning_tokens: z.number().int().nonnegative() })
          .strict(),
      })
      .strict(),
  })
  .strict();

/**
 * `POST /v1/images/generations` — OpenAI's images shape.
 *
 * A union per element rather than two optional fields: the endpoint returns a URL
 * or inline base64 and never both, and two optionals would publish a body where
 * neither is present as valid.
 */
export const imageGenerationsResponseSchema = z
  .object({
    created: z.number().int().nonnegative(),
    data: z.array(
      z.union([
        z.object({ url: z.string().min(1) }).strict(),
        z.object({ b64_json: z.string().min(1) }).strict(),
      ])
    ),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Normalization — both dialects into one shape                              */
/* -------------------------------------------------------------------------- */

/**
 * The request as the edge carries it, after the dialect has been read off.
 *
 * Everything downstream — limits, routing, reservation, the envelope — is
 * written against this and never against either public schema, so the two
 * dialects cannot drift into two admission paths.
 */
/**
 * Which endpoint's arithmetic applies to this request.
 *
 * A DISCRIMINATED UNION and not a string, because each arm carries the counts its
 * own ceiling is computed from, and because a total `switch` is what forces a new
 * endpoint to declare a bound. `ceilingForOperation` switches on `kind` with no
 * default arm, so adding a member fails `tsc` until somebody writes down what the
 * request can consume — which is the one thing that must never be guessed, since
 * an under-sized hold is how a balance goes negative.
 *
 * Every count here is derived from the request BODY, never from a header or a
 * byte length: `Content-Length` bounds bytes, and no modality on this list is
 * priced in bytes.
 */
export type EdgeOperation =
  /** Text in, text out. `input_tokens` bounded by characters, `output_tokens` by the cap. */
  | { readonly kind: 'completion' }
  /**
   * `POST /v1/embeddings`. `embeddings` is EXACT — the caller says how many inputs
   * they sent — and `input_tokens` is character-bounded, or exact when the caller
   * pre-tokenized.
   */
  | { readonly kind: 'embeddings'; readonly embeddings: number }
  /**
   * `POST /v1/rerank`. `input_tokens` bounded by `chars(query) + Σ chars(documents)`.
   * No output-token arm: a rerank returns indices and scores, not generated text.
   */
  | { readonly kind: 'rerank' }
  /**
   * `POST /v1/audio/speech`. `characters` is EXACT (`input.length`). Deliberately
   * carries NO `audio_output_milliseconds`: duration is characters ÷ speaking rate,
   * and no route field declares a speaking rate, so any duration figure would be a
   * guess. A duration-priced route therefore fails to quote and is refused, which
   * is the intended outcome rather than an oversight.
   */
  | { readonly kind: 'speech'; readonly characters: number }
  /**
   * `POST /v1/images/generations`. `images` is EXACT (`n`). Assumes one route per
   * size/quality class, because a price version prices a UNIT and not a
   * `(unit, size, quality)` tuple.
   */
  | { readonly kind: 'images'; readonly images: number };

export interface NormalizedEdgeRequest {
  /** Which endpoint's ceiling arithmetic applies. */
  readonly operation: EdgeOperation;
  /** Absent when the caller named none and the routing policy's default applies. */
  readonly target?: EdgeRoutingTarget;
  readonly input: InferenceInput;
  readonly stream: boolean;
  readonly maxOutputTokens?: number;
  readonly sampling: SamplingParameters;
  readonly tools: ToolDefinition[];
  readonly toolChoice?: ToolChoice;
  readonly responseFormat?: ResponseFormat;
  readonly labels?: Record<string, string>;
  readonly clientRequestId?: string;
  /** OpenAI's `user`, when the compatibility surface carried one. */
  readonly delegatedUserId?: string;
}

/**
 * A public edge target before admission resolves an exact routing-profile PK.
 *
 * The legacy slug arm deliberately stays local to Oxy's public dialect. Oxy
 * resolves it to one exact catalogue PK before building the signed envelope;
 * Kaana therefore never receives or interprets a slug.
 */
export type EdgeRoutingTarget =
  | RoutingTarget
  | { readonly kind: 'routing_profile_legacy'; readonly routingProfile: string };

/** Drop the keys whose value is `undefined`, so `.strict()` schemas accept. */
function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** A plain string becomes one user message with one text part. */
function textAsMessages(text: string): InferenceMessage[] {
  return [{ role: 'user', content: [{ type: 'text', text }] }];
}

export function normalizeResponsesRequest(request: ResponsesRequest): NormalizedEdgeRequest {
  const messages =
    typeof request.input === 'string' ? textAsMessages(request.input) : request.input;

  // The refinement guarantees at most one is present. Neither leaves `target`
  // absent, which is the edge's signal to use the routing policy's default.
  const target: EdgeRoutingTarget | undefined =
    request.model !== undefined
      ? { kind: 'model', modelReference: request.model }
      : request.routingProfile !== undefined
        ? { kind: 'routing_profile_legacy', routingProfile: request.routingProfile }
        : request.routingProfileId !== undefined
          ? { kind: 'routing_profile_id', routingProfileId: request.routingProfileId }
        : undefined;

  return defined({
    operation: { kind: 'completion' as const },
    target,
    input: { format: 'messages' as const, messages },
    stream: request.stream ?? false,
    maxOutputTokens: request.maxOutputTokens,
    sampling: defined({
      temperature: request.temperature,
      topP: request.topP,
      topK: request.topK,
      frequencyPenalty: request.frequencyPenalty,
      presencePenalty: request.presencePenalty,
      seed: request.seed,
      stopSequences: request.stopSequences,
    }),
    tools: request.tools ?? [],
    toolChoice: request.toolChoice,
    responseFormat: request.responseFormat,
    labels: request.labels,
    clientRequestId: request.clientRequestId,
  });
}

/**
 * The OpenAI dialect, read into the normalized shape.
 *
 * The one lossy direction is deliberate: a `null` content on an assistant
 * message that carries tool calls becomes an empty parts array, because the
 * normalized message shape has no null content and an assistant turn that only
 * calls a tool is a real, common message.
 */
export function normalizeChatCompletionsRequest(
  request: ChatCompletionsRequest
): NormalizedEdgeRequest {
  const messages: InferenceMessage[] = request.messages.map((message) =>
    defined({
      role: message.role,
      content:
        message.content === undefined || message.content === null
          ? []
          : typeof message.content === 'string'
            ? [{ type: 'text' as const, text: message.content }]
            : message.content,
      name: message.name,
      toolCallId: message.tool_call_id,
      toolCalls: message.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
    })
  );

  const stopSequences =
    request.stop === undefined
      ? undefined
      : typeof request.stop === 'string'
        ? [request.stop]
        : request.stop;

  return defined({
    operation: { kind: 'completion' as const },
    target: { kind: 'model' as const, modelReference: request.model },
    input: { format: 'messages' as const, messages },
    stream: request.stream ?? false,
    maxOutputTokens: request.max_completion_tokens ?? request.max_tokens,
    sampling: defined({
      temperature: request.temperature,
      topP: request.top_p,
      frequencyPenalty: request.frequency_penalty,
      presencePenalty: request.presence_penalty,
      seed: request.seed,
      stopSequences,
    }),
    tools:
      request.tools?.map((tool) =>
        defined({
          type: 'function' as const,
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
          strict: tool.function.strict,
        })
      ) ?? [],
    toolChoice: normalizeOpenAiToolChoice(request.tool_choice),
    responseFormat: normalizeOpenAiResponseFormat(request.response_format),
    delegatedUserId: request.user,
  });
}

function normalizeOpenAiToolChoice(
  choice: ChatCompletionsRequest['tool_choice']
): ToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (typeof choice === 'string') return choice;
  return { type: 'function', name: choice.function.name };
}

function normalizeOpenAiResponseFormat(
  format: ChatCompletionsRequest['response_format']
): ResponseFormat | undefined {
  if (format === undefined) return undefined;
  if (format.type === 'json_schema') {
    return {
      type: 'json_schema',
      name: format.json_schema.name,
      schema: format.json_schema.schema,
      strict: format.json_schema.strict ?? false,
    };
  }
  return { type: format.type };
}

/**
 * `POST /v1/audio/speech`, read into the normalized shape.
 *
 * `characters` is `input.length` — the count taken from the SAME string that goes
 * into the envelope, in one expression, so the figure the hold is sized from and
 * the text the provider bills for cannot diverge. Reading the count from anywhere
 * else (a header, a re-parse, a trimmed copy) is how a ceiling stops bounding the
 * thing it names.
 */
export function normalizeSpeechRequest(request: SpeechRequest): NormalizedEdgeRequest {
  return defined({
    operation: { kind: 'speech' as const, characters: request.input.length },
    target: { kind: 'model' as const, modelReference: request.model },
    input: { format: 'text' as const, text: request.input },
    stream: false,
    sampling: {},
    tools: [],
    delegatedUserId: request.user,
  });
}

/**
 * `POST /v1/images/generations`, read into the normalized shape.
 *
 * `images` is `n ?? 1` — OpenAI's own default. Exact rather than a bound, because
 * the caller declared it and the provider cannot return more than it was asked
 * for. The prompt still contributes `input_tokens` on the usual character
 * argument, so a long prompt is held for even though the image count dominates.
 */
export function normalizeImageGenerationsRequest(
  request: ImageGenerationsRequest
): NormalizedEdgeRequest {
  return defined({
    operation: { kind: 'images' as const, images: request.n ?? 1 },
    target: { kind: 'model' as const, modelReference: request.model },
    input: { format: 'text' as const, text: request.prompt },
    stream: false,
    sampling: {},
    tools: [],
    delegatedUserId: request.user,
  });
}
