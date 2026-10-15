/**
 * Stream events a public client reads. The ones that carry nothing about who
 * served a request are shared with the signed Oxy↔Kaana stream.
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/streamEvents.ts`) by Kaana ADR 0002.
 */

import { z } from 'zod';
import {
  generationIdSchema,
  inferenceTimestampSchema,
  modelReferenceSchema,
  PADDED_BASE64_PATTERN,
  requestIdSchema,
} from './identifiers.js';
import { publicErrorSchema } from './errors.js';
import { usageQuantitySchema, usageSourceSchema } from './money.js';

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
  /**
   * `output_audio_transcript` (contract set 3.2.0) carries the words of spoken
   * output requested with `audioOutput`. It is its own channel for the same
   * reason `reasoning` is: a renderer that shows it as `output_text` presents
   * the transcript of what the customer is hearing as a second, written answer.
   */
  channel: z.enum(['output_text', 'reasoning', 'refusal', 'output_audio_transcript']),
  text: z.string(),
});

/** The encodings an audio output may carry. */
export const inferenceAudioMediaTypeSchema = z.enum([
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/aac',
  'audio/flac',
  'audio/pcm',
]);

/** The most bytes one folded audio output may hold, at the edge and in the SDK. */
export const MAX_INFERENCE_AUDIO_BYTES = 20 * 1024 * 1024;

/** A bounded, independently base64-encoded chunk of one audio output. */
export const inferenceStreamAudioEventSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal('audio'),
  requestId: requestIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  outputIndex: z.number().int().nonnegative().safe(),
  mediaType: inferenceAudioMediaTypeSchema,
  data: z.string().min(4).max(65536).regex(PADDED_BASE64_PATTERN),
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
 * Why generation stopped.
 *
 * `refusal` and `content_filter` are separate members because they are separate
 * events: the MODEL declining to answer is a property of the answer, while a
 * filter is an upstream system removing one. The delta channels already carry
 * that distinction (`channel: 'refusal'` beside the filter's own error code),
 * so collapsing it here would have made the terminal event less specific than
 * the stream that produced it.
 */
export const inferenceFinishReasonSchema = z.enum([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'refusal',
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

/* -------------------------------------------------------------------------- */
/*  The public response stream (`POST /v1/responses` with `stream: true`)      */
/* -------------------------------------------------------------------------- */

/**
 * The first event of a public stream: the request id and the revision that is
 * serving it.
 *
 * Kaana moves a request (retry, failover, the next grant step) only before any
 * output is delivered, so the model named here is the one that produced every
 * event after it; a public stream therefore needs no route-switch event, and it
 * never names a provider or a deployment.
 */
export const responseStreamStartEventSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal('start'),
  requestId: requestIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  generationId: generationIdSchema.optional(),
  /** The revision that is serving the request. */
  model: modelReferenceSchema,
  startedAt: inferenceTimestampSchema,
});

/** What the request consumed, as measured. Units only, never money. */
export const responseStreamUsageEventSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal('usage'),
  requestId: requestIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  units: z.array(usageQuantitySchema).min(1),
  usageSource: usageSourceSchema,
});

/** The terminal failure of a public stream, after which nothing follows. */
export const responseStreamErrorEventSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal('error'),
  requestId: requestIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  error: publicErrorSchema,
});

/** Every event of a public response stream. */
export const responseStreamEventSchema = z.discriminatedUnion('type', [
  responseStreamStartEventSchema,
  inferenceStreamDeltaEventSchema,
  inferenceStreamAudioEventSchema,
  inferenceStreamToolCallEventSchema,
  responseStreamUsageEventSchema,
  responseStreamErrorEventSchema,
  inferenceStreamDoneEventSchema,
]);

export type InferenceAudioMediaType = z.infer<typeof inferenceAudioMediaTypeSchema>;
export type InferenceStreamDeltaEvent = z.infer<typeof inferenceStreamDeltaEventSchema>;
export type InferenceStreamAudioEvent = z.infer<typeof inferenceStreamAudioEventSchema>;
export type InferenceStreamToolCallEvent = z.infer<typeof inferenceStreamToolCallEventSchema>;
export type InferenceFinishReason = z.infer<typeof inferenceFinishReasonSchema>;
export type InferenceStreamDoneEvent = z.infer<typeof inferenceStreamDoneEventSchema>;
export type ResponseStreamStartEvent = z.infer<typeof responseStreamStartEventSchema>;
export type ResponseStreamUsageEvent = z.infer<typeof responseStreamUsageEventSchema>;
export type ResponseStreamErrorEvent = z.infer<typeof responseStreamErrorEventSchema>;
export type ResponseStreamEvent = z.infer<typeof responseStreamEventSchema>;
