/**
 * `POST /v1/chat/completions` — the OpenAI-compatible surface.
 *
 * It speaks the flat OpenAI request and response shapes so an unmodified OpenAI
 * SDK works against `baseURL: 'https://kaana.ai/v1'` with an `oxy_sk_…` key, and
 * it gains NO Kaana-specific request field: a capability with no OpenAI
 * representation lives on `/v1/responses`. `.strict()` everywhere: a stock SDK
 * sending a parameter Kaana does not implement is told so rather than having it
 * silently dropped.
 *
 * Moved from the Oxy edge (`packages/api/src/schemas/inferenceEdge.schemas.ts`)
 * by Kaana ADR 0002. `model` names a model reference or a power level. The
 * stream chunk and the error body are written down here for the first time;
 * the Oxy edge rendered them in code only.
 */

import { z } from 'zod';
import { reasoningEffortSchema } from './catalogue.js';
import { publicErrorCodeSchema } from './errors.js';
import { inferenceContentPartSchema } from './messages.js';
import { modelTargetSchema } from './responses.js';

/** `stop` in the OpenAI dialect: one sequence or a list of them. */
const openAiStopSchema = z.union([
  z.string().min(1).max(256),
  z.array(z.string().min(1).max(256)).max(8),
]);

const openAiToolCallSchema = z
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
  .strict();

/**
 * One OpenAI message. `content` accepts both the string form and the parts
 * array, because both are in wide use and rejecting the string form would fail
 * the stock SDK on its most common call.
 */
export const chatCompletionMessageSchema = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
    content: z
      .union([z.string(), z.array(inferenceContentPartSchema)])
      .nullable()
      .optional(),
    name: z.string().max(128).optional(),
    tool_call_id: z.string().min(1).max(128).optional(),
    tool_calls: z.array(openAiToolCallSchema).optional(),
  })
  .strict();

const openAiToolSchema = z
  .object({
    type: z.literal('function'),
    function: z
      .object({
        name: z.string().min(1).max(128),
        description: z.string().max(2000).optional(),
        parameters: z.record(z.string(), z.unknown()),
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

/**
 * OpenAI's `audio` output parameter for its audio chat models. `aac` is
 * refused (no route could be held to it); `pcm16` is OpenAI's spelling of the
 * contract's `pcm`.
 */
const openAiAudioOutputSchema = z
  .object({
    voice: z.string().min(1).max(64),
    format: z.enum(['wav', 'mp3', 'flac', 'opus', 'pcm16']),
  })
  .strict();

const openAiResponseFormatSchema = z.union([
  z.object({ type: z.enum(['text', 'json_object']) }).strict(),
  z
    .object({
      type: z.literal('json_schema'),
      json_schema: z
        .object({
          name: z.string().min(1).max(128),
          schema: z.record(z.string(), z.unknown()),
          strict: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const chatCompletionsRequestSchema = z
  .object({
    /**
     * A model reference (`publisher/model[@revision]`) or a power level. An
     * OpenAI vendor model name (`gpt-4o`) is neither and does not resolve: it is
     * refused as unknown, never mapped to a publisher.
     */
    model: modelTargetSchema,
    messages: z.array(chatCompletionMessageSchema).min(1),
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
    /** Refused when the resolved model does not advertise the effort. */
    reasoning_effort: reasoningEffortSchema.optional(),
    /** `["text", "audio"]` asks an audio chat model to answer in speech and its transcript. */
    modalities: z
      .array(z.enum(['text', 'audio']))
      .min(1)
      .max(2)
      .optional(),
    /** The voice and format of spoken output. Requires `modalities` to include `audio`. */
    audio: openAiAudioOutputSchema.optional(),
    /**
     * OpenAI's end-user attribution field: the DELEGATED user id, attribution
     * only. `X-Oxy-User-Id` wins when both are present.
     */
    user: z.string().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.max_tokens !== undefined && request.max_completion_tokens !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['max_completion_tokens'],
        message: 'send max_tokens or max_completion_tokens, not both',
      });
    }
    const modalities = request.modalities ?? ['text'];
    if (new Set(modalities).size !== modalities.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['modalities'],
        message: 'each modality is named at most once',
      });
    }
    if (!modalities.includes('text')) {
      ctx.addIssue({
        code: 'custom',
        path: ['modalities'],
        message: 'modalities must include text; spoken output always carries its transcript',
      });
    }
    const spoken = modalities.includes('audio');
    if (spoken && request.audio === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['audio'],
        message: 'modalities including audio require the audio parameter (voice and format)',
      });
    }
    if (!spoken && request.audio !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['modalities'],
        message: 'the audio parameter requires modalities to include audio',
      });
    }
    if (spoken && request.stream === true && request.audio?.format !== 'pcm16') {
      ctx.addIssue({
        code: 'custom',
        path: ['audio', 'format'],
        message: 'streamed audio output is pcm16; the other formats exist only whole',
      });
    }
  });

/** OpenAI's usage block, with the audio members only when audio tokens were metered. */
export const chatCompletionUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    prompt_tokens_details: z
      .object({
        cached_tokens: z.number().int().nonnegative(),
        audio_tokens: z.number().int().nonnegative().optional(),
        cached_tokens_details: z
          .object({ audio_tokens: z.number().int().nonnegative() })
          .strict()
          .optional(),
      })
      .strict(),
    completion_tokens_details: z
      .object({
        reasoning_tokens: z.number().int().nonnegative(),
        audio_tokens: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();

/**
 * The non-streaming body. Every field is one a stock OpenAI client reads,
 * spelled the way it spells it; the request id rides in `Kaana-Request-Id`.
 */
export const chatCompletionSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal('chat.completion'),
    /** Unix seconds, as OpenAI's own field is. */
    created: z.number().int().nonnegative(),
    /** The revision that served the request. */
    model: z.string().min(1),
    choices: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          message: z
            .object({
              role: z.literal('assistant'),
              /** `null` when the answer is spoken: the words are in `audio.transcript`. */
              content: z.string().nullable(),
              /** Spoken output. `expires_at` is `created`: Kaana retains no audio. */
              audio: z
                .object({
                  id: z.string().min(1),
                  data: z.string(),
                  transcript: z.string(),
                  expires_at: z.number().int().nonnegative(),
                })
                .strict()
                .optional(),
              tool_calls: z.array(openAiToolCallSchema).optional(),
            })
            .strict(),
          /**
           * OpenAI's vocabulary, which has neither `cancelled` nor `refusal`:
           * both are reported as `stop` here.
           */
          finish_reason: z.string().min(1),
        })
        .strict(),
    ),
    usage: chatCompletionUsageSchema,
  })
  .strict();

/**
 * One `data:` frame of a streamed completion, terminated by `data: [DONE]`.
 *
 * Reasoning deltas are not carried (the chunk has no field for them and
 * `delta.content` would render private reasoning as the answer), and neither
 * is any route information: a public stream names no provider. Usage rides on
 * a chunk with `choices: []`, which a stock client skips.
 */
export const chatCompletionChunkSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal('chat.completion.chunk'),
    created: z.number().int().nonnegative(),
    model: z.string().min(1),
    choices: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          delta: z
            .object({
              role: z.literal('assistant').optional(),
              content: z.string().optional(),
              refusal: z.string().optional(),
              audio: z
                .object({
                  id: z.string().min(1),
                  data: z.string().optional(),
                  transcript: z.string().optional(),
                  expires_at: z.number().int().nonnegative().optional(),
                })
                .strict()
                .optional(),
              tool_calls: z
                .array(
                  z
                    .object({
                      index: z.number().int().nonnegative(),
                      id: z.string().min(1).optional(),
                      type: z.literal('function').optional(),
                      function: z
                        .object({ name: z.string().optional(), arguments: z.string().optional() })
                        .strict(),
                    })
                    .strict(),
                )
                .optional(),
            })
            .strict(),
          finish_reason: z.string().min(1).nullable(),
        })
        .strict(),
    ),
    usage: chatCompletionUsageSchema.optional(),
  })
  .strict();

/**
 * The error body in the OpenAI idiom: the body of a refusal before the first
 * byte, and a `data:` frame when a stream fails after it. `code` is the public
 * vocabulary.
 */
export const chatCompletionErrorSchema = z
  .object({
    error: z
      .object({
        message: z.string().min(1),
        type: z.string().min(1),
        param: z.string().nullable(),
        code: publicErrorCodeSchema,
      })
      .strict(),
  })
  .strict();

export type ChatCompletionMessage = z.infer<typeof chatCompletionMessageSchema>;
export type ChatCompletionsRequest = z.infer<typeof chatCompletionsRequestSchema>;
export type ChatCompletionUsage = z.infer<typeof chatCompletionUsageSchema>;
export type ChatCompletion = z.infer<typeof chatCompletionSchema>;
export type ChatCompletionChunk = z.infer<typeof chatCompletionChunkSchema>;
export type ChatCompletionError = z.infer<typeof chatCompletionErrorSchema>;
