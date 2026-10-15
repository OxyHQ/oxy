/**
 * Messages, content parts, tools and generation controls shared by every
 * public request and by the signed envelope.
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/request.ts`) by Kaana ADR 0002.
 */

import { z } from 'zod';
import { reasoningEffortSchema } from './catalogue.js';

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

/**
 * One part of a message's content. A message is always a list of parts.
 *
 * ## `refusal` is a member and `reasoning` is not, and the asymmetry is the point
 *
 * A model that DECLINES says why, and those words are meant for the customer:
 * they are the difference between "rephrase this" and "stop asking". Before this
 * member existed there was nowhere in an {@link InferenceMessage} to put them, so
 * a non-streaming fold kept `finishReason: 'refusal'` and dropped the sentence —
 * the customer learned they were refused and not why, while a streaming caller of
 * the same request got the whole explanation on the `refusal` delta channel.
 *
 * Reasoning is the opposite case and stays absent. It is the model's private
 * working, and a `text` part is where somebody would put it — which renders
 * private reasoning to the customer AS the answer, the product bug the delta
 * channels exist to prevent. An opaque per-block reasoning blob crossing this
 * boundary needs a home nobody has chosen yet, and inventing one here would
 * choose it by accident.
 *
 * Both public dialects can carry a refusal, which is what separates the two
 * cases at the boundary as well as in principle: `refusal` is OpenAI's OWN field
 * in both of its shapes (`delta.refusal` streaming, `message.refusal`
 * non-streaming), while reasoning has no OpenAI field at all — the
 * `reasoning_content`/`reasoning` spellings an OpenAI-compatible provider emits
 * are provider extensions. So carrying the refusal costs no dialect its
 * standard-client parseability, and carrying reasoning would.
 *
 * The part is a MEMBER rather than a field because a refusal need not have text:
 * an Anthropic `stop_reason: "refusal"` maps to the finish reason and separates
 * no words from the answer, while an OpenAI-compatible `refusal` does. A required
 * field would force the first provider to invent a sentence.
 */
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
  /**
   * A model's explanation for declining. Its own part, never a `text` one, so no
   * renderer can present a refusal as the answer that was asked for.
   */
  z.object({ type: z.literal('refusal'), text: z.string() }).strict(),
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
        code: 'custom',
        path: ['toolCallId'],
        message: 'a tool message must name the tool call it answers',
      });
    }

    if (message.role !== 'tool' && message.toolCallId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['toolCallId'],
        message: 'only a tool message answers a tool call',
      });
    }

    if (message.role !== 'assistant' && message.toolCalls !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['toolCalls'],
        message: 'only an assistant message makes tool calls',
      });
    }

    // Same rule as `toolCalls`, for the same reason: only the assistant can
    // decline, so a refusal on any other role is a part every provider would
    // silently ignore — and one a renderer might not.
    if (message.role !== 'assistant') {
      for (const [index, part] of message.content.entries()) {
        if (part.type === 'refusal') {
          ctx.addIssue({
            code: 'custom',
            path: ['content', index, 'type'],
            message: 'only an assistant message carries a refusal',
          });
        }
      }
    }
  });

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
    parameters: z.record(z.string(), z.unknown()),
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
      schema: z.record(z.string(), z.unknown()),
      strict: z.boolean(),
    })
    .strict(),
]);

/**
 * The caller's reasoning control. Strict, like every leaf: a provider-specific
 * knob (`budget_tokens`, `summary`) is refused rather than silently dropped.
 *
 * Oxy forwards it only after checking the resolved model advertises the effort
 * in its catalogue `reasoningEfforts`; Kaana translates it per provider.
 */
export const inferenceReasoningSchema = z.object({ effort: reasoningEffortSchema }).strict();

/** Parameters for text-to-speech, preserved in the signed request. */
export const inferenceSpeechParametersSchema = z
  .object({
    voice: z.string().min(1).max(64),
    responseFormat: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']),
    speed: z.number().min(0.25).max(4).optional(),
  })
  .strict();

/**
 * Spoken output from a CONVERSATIONAL model (contract set 3.2.0) — an audio chat
 * model answering in its own voice, as opposed to `speech`, which reads given
 * text aloud. Presence is the request: a chat request carrying this asks for
 * the answer as audio AND its transcript, which is the only combination the
 * audio chat models produce (OpenAI's `modalities: ["text", "audio"]`).
 *
 * The audio streams as `audio` events and the words as `delta` events on the
 * `output_audio_transcript` channel — never as `output_text`, because a
 * transcript of speech the customer is already hearing is not a second answer.
 * `pcm` is the only format an audio chat model can STREAM; the refinement on the
 * envelope holds that rather than leaving a provider to refuse it mid-flight.
 */
export const inferenceAudioOutputParametersSchema = z
  .object({
    voice: z.string().min(1).max(64),
    format: z.enum(['wav', 'mp3', 'flac', 'opus', 'pcm']),
  })
  .strict();

/**
 * Customer-supplied cost-attribution labels, echoed on the generation record.
 *
 * Bounded in both directions because they are stored and read back: sixteen
 * keys is a team/feature/environment tag set, not a place to smuggle a payload.
 *
 * Moved from the Oxy edge (`packages/api/src/schemas/inferenceEdge.schemas.ts`).
 */
export const requestLabelsSchema = z
  .record(z.string(), z.string().max(256))
  .refine(
    (labels) => Object.keys(labels).length <= 16,
    'at most 16 labels may be attached to one request',
  );

export type InferenceSpeechParameters = z.infer<typeof inferenceSpeechParametersSchema>;
export type InferenceAudioOutputParameters = z.infer<typeof inferenceAudioOutputParametersSchema>;
export type InferenceContentSource = z.infer<typeof inferenceContentSourceSchema>;
export type InferenceContentPart = z.infer<typeof inferenceContentPartSchema>;
export type InferenceToolCall = z.infer<typeof inferenceToolCallSchema>;
export type InferenceMessageRole = z.infer<typeof inferenceMessageRoleSchema>;
export type InferenceMessage = z.infer<typeof inferenceMessageSchema>;
export type SamplingParameters = z.infer<typeof samplingParametersSchema>;
export type InferenceReasoning = z.infer<typeof inferenceReasoningSchema>;
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
export type ToolChoice = z.infer<typeof toolChoiceSchema>;
export type ResponseFormat = z.infer<typeof responseFormatSchema>;
export type RequestLabels = z.infer<typeof requestLabelsSchema>;
