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
  inferenceMessageSchema,
  modelReferenceSchema,
  responseFormatSchema,
  routingProfileSlugSchema,
  toolChoiceSchema,
  toolDefinitionSchema,
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
     * `model` and `routingProfile` are two optional fields with a refinement
     * forbidding both, rather than the discriminated union the shape deserves.
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
    if (request.model !== undefined && request.routingProfile !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['model'],
        message: 'name at most one of model or routingProfile',
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
  readonly target?: RoutingTarget;
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
  const target: RoutingTarget | undefined =
    request.model !== undefined
      ? { kind: 'model', modelReference: request.model }
      : request.routingProfile !== undefined
        ? { kind: 'routing_profile', routingProfile: request.routingProfile }
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
