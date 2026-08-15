/**
 * The normalized inference request — the canonical internal envelope Oxy's
 * public edge forwards to the data plane.
 *
 * The public surface speaks several dialects (`/v1/responses`,
 * `/v1/chat/completions`, embeddings, images, audio). Exactly one of them is
 * normalized here, at the edge, so that routing, metering, policy enforcement
 * and settlement are written once against one shape instead of once per dialect.
 * `client.apiFormat` records which dialect the customer used, because the
 * response has to be rendered back in it.
 *
 * What the envelope carries that a provider request does not: the resolved
 * attribution block (who pays, which application, which credential, which
 * delegated user), the exact routing policy reference and the customer's
 * idempotency key. Those are the fields that make a request billable and
 * explainable, and they are resolved BEFORE the request enters the data plane.
 *
 * Decided in: docs/adr/0010-public-api-compatibility.md.
 */

import { z } from 'zod';
import { inferenceAttributionSchema } from './attribution';
import { inferenceModalitySchema } from './catalogue';
import { idempotencyKeySchema, inferenceTimestampSchema } from './identifiers';
import { routingPolicyReferenceSchema, routingTargetSchema } from './routingPolicy';

/* -------------------------------------------------------------------------- */
/*  Input                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where binary or remote content comes from.
 *
 * `url` is fetched by the data plane; `inline` carries base64 the customer sent
 * with the request. Both are transient: neither is persisted by default, and
 * neither appears in a receipt, a log line or a telemetry event.
 */
export const inferenceContentSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      kind: z.literal('inline'),
      mediaType: z.string().min(1).max(255),
      data: z.string().min(1),
    })
    .strict(),
]);

/** One part of a message's content. A message is always a list of parts. */
export const inferenceContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('image'),
      source: inferenceContentSourceSchema,
      /** Provider-independent hint; providers that ignore it are unaffected. */
      detail: z.enum(['auto', 'low', 'high']).optional(),
    })
    .strict(),
  z.object({ type: z.literal('audio'), source: inferenceContentSourceSchema }).strict(),
  z
    .object({
      type: z.literal('file'),
      source: inferenceContentSourceSchema,
      filename: z.string().max(255).optional(),
    })
    .strict(),
]);

/**
 * A tool call an assistant made, in the normalized form.
 *
 * `arguments` is the JSON TEXT the model emitted, not a parsed object: models
 * emit invalid JSON often enough that parsing it here would turn a recoverable
 * model mistake into a rejected message.
 */
export const inferenceToolCallSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    arguments: z.string(),
  })
  .strict();

export const inferenceMessageRoleSchema = z.enum([
  'system',
  'developer',
  'user',
  'assistant',
  'tool',
]);

/**
 * One normalized message.
 *
 * The role-specific fields are refined rather than modelled as a discriminated
 * union so the shape stays the one a caller recognises from the OpenAI-style
 * dialects; the refinement is what stops `toolCallId` from riding on a user
 * message, where every provider would silently ignore it.
 */
export const inferenceMessageSchema = z
  .object({
    role: inferenceMessageRoleSchema,
    content: z.array(inferenceContentPartSchema),
    /** Participant name, where the dialect supports naming participants. */
    name: z.string().max(128).optional(),
    /** The tool call this message answers. Required on, and only on, `tool`. */
    toolCallId: z.string().min(1).max(128).optional(),
    /** Tool calls the assistant made. Only on `assistant`. */
    toolCalls: z.array(inferenceToolCallSchema).optional(),
  })
  .strict()
  .superRefine((message, ctx) => {
    if (message.role === 'tool' && message.toolCallId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolCallId'],
        message: 'a tool message must name the tool call it answers',
      });
    }

    if (message.role !== 'tool' && message.toolCallId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolCallId'],
        message: 'only a tool message answers a tool call',
      });
    }

    if (message.role !== 'assistant' && message.toolCalls !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolCalls'],
        message: 'only an assistant message makes tool calls',
      });
    }
  });

/**
 * The request's input.
 *
 * Three formats, because the modalities genuinely differ: a chat request is a
 * conversation, an embedding request is a string or a batch of strings, and
 * pretending the latter is a one-message conversation loses the batch boundary
 * that both metering and provider translation depend on.
 */
export const inferenceInputSchema = z.discriminatedUnion('format', [
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

/* -------------------------------------------------------------------------- */
/*  Generation controls                                                       */
/* -------------------------------------------------------------------------- */

/** Sampling parameters, all optional: absent means the route's own default. */
export const samplingParametersSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    topK: z.number().int().positive().safe().optional(),
    frequencyPenalty: z.number().min(-2).max(2).optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
    /** A seed makes a request reproducible on providers that honour one. */
    seed: z.number().int().safe().optional(),
    stopSequences: z.array(z.string().min(1).max(256)).max(8).optional(),
  })
  .strict();

/**
 * A tool the model may call. `parameters` is a JSON Schema document, carried
 * as an opaque object: validating the customer's JSON Schema against a meta
 * schema here would reject documents providers accept.
 */
export const toolDefinitionSchema = z
  .object({
    type: z.literal('function'),
    name: z.string().min(1).max(128),
    description: z.string().max(2000).optional(),
    parameters: z.record(z.unknown()),
    /** Ask the provider to enforce the schema, where it supports enforcement. */
    strict: z.boolean().optional(),
  })
  .strict();

/** Whether, and which, tool the model must call. */
export const toolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({ type: z.literal('function'), name: z.string().min(1).max(128) }).strict(),
]);

/** Structured-output request: free text, any JSON object, or a named schema. */
export const responseFormatSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }).strict(),
  z.object({ type: z.literal('json_object') }).strict(),
  z
    .object({
      type: z.literal('json_schema'),
      name: z.string().min(1).max(128),
      schema: z.record(z.unknown()),
      strict: z.boolean(),
    })
    .strict(),
]);

/* -------------------------------------------------------------------------- */
/*  Client metadata                                                           */
/* -------------------------------------------------------------------------- */

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
    apiFormat: z.enum([
      'responses',
      'chat_completions',
      'embeddings',
      'images_generations',
      'audio_transcriptions',
      'audio_speech',
      'rerank',
      'batches',
    ]),
    /** The public path, e.g. `/v1/responses`. */
    endpoint: z.string().min(1).max(256),
    /** The customer's own correlation id, when they sent one. */
    clientRequestId: z.string().min(1).max(128).optional(),
    receivedAt: inferenceTimestampSchema,
    labels: z.record(z.string().max(256)).optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  The envelope                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The canonical internal request Oxy forwards to the data plane.
 *
 * `target` distinguishes the two questions a caller can ask — "serve THIS
 * model" versus "choose one for me" — structurally. Everything downstream that
 * must not silently substitute a model reads that discriminant rather than
 * inferring intent from a string.
 */
export const inferenceRequestSchema = z
  .object({
    /** See `version.ts`: this is the Oxy→data-plane request envelope. */
    schemaVersion: z.literal(1),
    attribution: inferenceAttributionSchema,
    target: routingTargetSchema,
    modality: inferenceModalitySchema,
    input: inferenceInputSchema,
    stream: z.boolean(),
    maxOutputTokens: z.number().int().positive().safe().optional(),
    sampling: samplingParametersSchema,
    tools: z.array(toolDefinitionSchema).default([]),
    toolChoice: toolChoiceSchema.optional(),
    responseFormat: responseFormatSchema.optional(),
    client: clientRequestMetadataSchema,
    /** Present when the operation is safe to deduplicate on retry. */
    idempotencyKey: idempotencyKeySchema.optional(),
    /** The exact policy revision this request is served under. */
    routingPolicy: routingPolicyReferenceSchema,
  })
  .superRefine((request, ctx) => {
    if (request.toolChoice !== undefined && request.tools.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolChoice'],
        message: 'a tool choice requires at least one tool definition',
      });
    }

    const toolNames = request.tools.map((tool) => tool.name);
    if (new Set(toolNames).size !== toolNames.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tools'],
        message: 'tool names must be unique within one request',
      });
    }
  });

export type InferenceContentSource = z.infer<typeof inferenceContentSourceSchema>;
export type InferenceContentPart = z.infer<typeof inferenceContentPartSchema>;
export type InferenceToolCall = z.infer<typeof inferenceToolCallSchema>;
export type InferenceMessageRole = z.infer<typeof inferenceMessageRoleSchema>;
export type InferenceMessage = z.infer<typeof inferenceMessageSchema>;
export type InferenceInput = z.infer<typeof inferenceInputSchema>;
export type SamplingParameters = z.infer<typeof samplingParametersSchema>;
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
export type ToolChoice = z.infer<typeof toolChoiceSchema>;
export type ResponseFormat = z.infer<typeof responseFormatSchema>;
export type ClientRequestMetadata = z.infer<typeof clientRequestMetadataSchema>;
export type InferenceRequest = z.infer<typeof inferenceRequestSchema>;
