/**
 * `POST /v1/audio/speech` (with and without streaming) and
 * `POST /v1/audio/transcriptions`.
 *
 * The speech request is moved from the Oxy edge
 * (`packages/api/src/schemas/inferenceEdge.schemas.ts`) by Kaana ADR 0002;
 * streaming speech (decision 8), the voice limits checked before a grant
 * (decision 9) and transcription are new in contract set 4.0.0.
 */

import { z } from 'zod';
import { languageTagSchema, speechFormatSchema, speechMediaType } from './audioFormats.js';
import type { ModelAudioCapabilities } from './catalogue.js';
import { publicErrorSchema } from './errors.js';
import { modelReferenceSchema, PADDED_BASE64_PATTERN, requestIdSchema } from './identifiers.js';
import { usageSchema } from './money.js';

/* -------------------------------------------------------------------------- */
/*  Speech                                                                     */
/* -------------------------------------------------------------------------- */

/** The longest text one speech request may carry, before any model's own limit. */
export const MAX_SPEECH_INPUT_CHARACTERS = 100_000;

/**
 * How a streamed speech response is carried:
 *
 * - `audio` (OpenAI-compatible): `200` with `Transfer-Encoding: chunked` and the
 *   raw bytes. A failure before the first byte is an HTTP status with an error
 *   body; one after it cuts the connection and the generation record keeps the
 *   code.
 * - `sse` (what `@kaana.ai/sdk` uses): {@link speechStreamEventSchema} frames,
 *   so a failure mid-stream arrives typed.
 */
export const speechStreamFormatSchema = z.enum(['audio', 'sse']);

/**
 * The formats speech can be streamed in: `audio/mpeg` and
 * `audio/pcm;rate=24000`, the two containers that can be played as they arrive.
 */
export const STREAMABLE_SPEECH_FORMATS = ['mp3', 'pcm'] as const;

/**
 * The request, in the shape a stock OpenAI client sends.
 *
 * `model` is a concrete model: a voice belongs to a model, so a power level,
 * which may choose any of several, could not be validated against one.
 */
export const speechRequestSchema = z
  .object({
    model: modelReferenceSchema,
    /** Bounded so one request cannot drive the hold arbitrarily high. */
    input: z.string().min(1).max(MAX_SPEECH_INPUT_CHARACTERS),
    voice: z.string().min(1).max(64),
    /** Absent means `mp3`. */
    response_format: speechFormatSchema.optional(),
    /** The contract's outer bound; each model publishes its own range. */
    speed: z.number().min(0.25).max(4).optional(),
    stream: z.boolean().optional(),
    /** Only with `stream: true`. Absent means `audio`. */
    stream_format: speechStreamFormatSchema.optional(),
    /** OpenAI's end-user attribution field: the delegated user id, attribution only. */
    user: z.string().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.stream_format !== undefined && request.stream !== true) {
      ctx.addIssue({
        code: 'custom',
        path: ['stream_format'],
        message: 'stream_format applies only to a streamed request (stream: true)',
      });
    }
    const format = request.response_format ?? 'mp3';
    if (
      request.stream === true &&
      !(STREAMABLE_SPEECH_FORMATS as readonly string[]).includes(format)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['response_format'],
        message: `streamed speech is ${STREAMABLE_SPEECH_FORMATS.join(' or ')}; ${format} exists only whole`,
      });
    }
  });

/** One chunk of audio, in order, as soon as the provider produced it. */
export const speechAudioDeltaEventSchema = z
  .object({
    type: z.literal('speech.audio.delta'),
    /** Standard padded base64 of at most 49 152 bytes of audio. */
    audio: z.string().min(4).max(65_536).regex(PADDED_BASE64_PATTERN),
  })
  .strict();

/** The last event of a successful stream: what served it and what it consumed. */
export const speechAudioDoneEventSchema = z
  .object({
    type: z.literal('speech.audio.done'),
    requestId: requestIdSchema,
    /** The revision that actually served the request. */
    model: modelReferenceSchema,
    usage: usageSchema,
  })
  .strict();

/** The terminal failure of a stream, after which nothing follows. */
export const speechStreamErrorEventSchema = z
  .object({
    type: z.literal('error'),
    error: publicErrorSchema,
  })
  .strict();

/**
 * The frames of `stream_format: 'sse'`. The media type is not repeated: it is
 * a function of the request's `response_format` ({@link speechMediaType}).
 */
export const speechStreamEventSchema = z.discriminatedUnion('type', [
  speechAudioDeltaEventSchema,
  speechAudioDoneEventSchema,
  speechStreamErrorEventSchema,
]);

/** Why a speech request cannot be served by a model, before anything is held. */
export interface SpeechRequestIssue {
  /** The request field at fault, as `invalid_request.param` names it. */
  readonly param: 'input' | 'voice' | 'response_format' | 'speed';
  readonly message: string;
}

/**
 * Check a speech request against the model's published audio capabilities
 * (Kaana ADR 0002, decision 9). Kaana's handler refuses the request with
 * `invalid_request` and the first issue's `param` BEFORE asking Oxy for a
 * grant, so a `speed` of 1.5 for a model that publishes 0.7–1.2 holds no money;
 * a client may run the same check first.
 *
 * Returns every issue, in field order; an empty list means the model accepts
 * the request. Characters are counted in UTF-16 code units, as `length` does.
 */
export function checkSpeechRequest(
  request: z.infer<typeof speechRequestSchema>,
  audio: ModelAudioCapabilities,
): SpeechRequestIssue[] {
  const issues: SpeechRequestIssue[] = [];
  if (audio.maxInputCharacters !== undefined && request.input.length > audio.maxInputCharacters) {
    issues.push({
      param: 'input',
      message: `input is ${request.input.length} characters; this model reads at most ${audio.maxInputCharacters}`,
    });
  }
  if (!audio.voices.some((voice) => voice.id === request.voice)) {
    issues.push({ param: 'voice', message: `this model has no voice ${request.voice}` });
  }
  const format = request.response_format ?? 'mp3';
  if (!audio.audioFormats.output.includes(speechMediaType(format))) {
    issues.push({ param: 'response_format', message: `this model does not produce ${format}` });
  }
  if (request.speed !== undefined) {
    if (audio.speed === undefined) {
      issues.push({ param: 'speed', message: 'this model accepts no speed control' });
    } else if (request.speed < audio.speed.min || request.speed > audio.speed.max) {
      issues.push({
        param: 'speed',
        message: `speed must be between ${audio.speed.min} and ${audio.speed.max} for this model`,
      });
    }
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/*  Transcription                                                              */
/* -------------------------------------------------------------------------- */

/** The largest audio file one transcription request may upload: 20 MiB. */
export const MAX_TRANSCRIPTION_FILE_BYTES = 20 * 1024 * 1024;

/**
 * The text fields of the `multipart/form-data` request. The audio itself is the
 * `file` part, at most {@link MAX_TRANSCRIPTION_FILE_BYTES}, whose content type
 * is one of `audioInputMediaTypeSchema`; it is binary and so is not a Zod shape.
 * Synchronous: the transcription is the response.
 */
export const transcriptionRequestSchema = z
  .object({
    model: modelReferenceSchema,
    /** The spoken language, when known; validated against the model's `audio.languages`. */
    language: languageTagSchema.optional(),
    /** Vocabulary or context that helps the model; never an instruction. */
    prompt: z.string().max(4096).optional(),
    /** Absent means `none`. */
    timestamps: z.enum(['none', 'segment', 'word']).optional(),
  })
  .strict();

const timedSpanFields = {
  startMs: z.number().int().nonnegative().safe(),
  endMs: z.number().int().nonnegative().safe(),
};

/** The response. Segments or words are present only when the request asked for them. */
export const transcriptionSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: requestIdSchema,
    /** The revision that actually served the request. */
    model: modelReferenceSchema,
    text: z.string(),
    /** The language the model heard, when it reports one. */
    language: languageTagSchema.optional(),
    durationMs: z.number().int().nonnegative().safe().optional(),
    segments: z.array(z.object({ ...timedSpanFields, text: z.string() }).strict()).optional(),
    words: z.array(z.object({ ...timedSpanFields, word: z.string() }).strict()).optional(),
    usage: usageSchema,
  })
  .strict()
  .superRefine((transcription, ctx) => {
    for (const field of ['segments', 'words'] as const) {
      for (const [index, span] of (transcription[field] ?? []).entries()) {
        if (span.endMs < span.startMs) {
          ctx.addIssue({
            code: 'custom',
            path: [field, index, 'endMs'],
            message: 'a span cannot end before it starts',
          });
        }
      }
    }
  });

export type SpeechStreamFormat = z.infer<typeof speechStreamFormatSchema>;
export type SpeechRequest = z.infer<typeof speechRequestSchema>;
export type SpeechAudioDeltaEvent = z.infer<typeof speechAudioDeltaEventSchema>;
export type SpeechAudioDoneEvent = z.infer<typeof speechAudioDoneEventSchema>;
export type SpeechStreamErrorEvent = z.infer<typeof speechStreamErrorEventSchema>;
export type SpeechStreamEvent = z.infer<typeof speechStreamEventSchema>;
export type TranscriptionRequestFields = z.infer<typeof transcriptionRequestSchema>;
export type Transcription = z.infer<typeof transcriptionSchema>;
