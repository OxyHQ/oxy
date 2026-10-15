/**
 * Realtime sessions as a public client speaks them (`GET /v1/realtime`).
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/realtime.ts`) by Kaana ADR 0002.
 */

import { z } from 'zod';
import { realtimeSessionKindSchema, realtimeSessionTransportSchema } from './catalogue.js';
import {
  inferenceTimestampSchema,
  modelReferenceSchema,
  PADDED_BASE64_PATTERN,
  requestIdSchema,
} from './identifiers.js';
import { publicErrorSchema } from './errors.js';
import { requestLabelsSchema, toolChoiceSchema, toolDefinitionSchema } from './messages.js';
import { usageQuantitySchema, usageSourceSchema } from './money.js';
import { inferenceFinishReasonSchema } from './streamEvents.js';

/**
 * The most base64 characters one audio frame may carry: 49 152 bytes of audio,
 * about one second of 24 kHz mono PCM16. Bounded so no frame is large enough to
 * stall a connection, and so a byte cap can be enforced as audio arrives rather
 * than after it has been buffered.
 */
export const MAX_REALTIME_AUDIO_FRAME_BASE64_LENGTH = 65_536;

/** The longest a session may be signed for: one hour. */
export const MAX_REALTIME_SESSION_DURATION_MS = 3_600_000;

/**
 * The most audio a session may be signed for in EACH direction: one hour of
 * 24 kHz mono PCM16 (48 000 bytes per second), the densest format a session
 * carries.
 */
export const MAX_REALTIME_SESSION_AUDIO_BYTES = 172_800_000;

/** The longest a dropped connection may be resumed after: one minute. */
export const MAX_REALTIME_RESUME_WINDOW_MS = 60_000;

/** A client-chosen command identity, unique within one session. */
export const realtimeCommandIdSchema = z.string().min(1).max(128);

/** A conversation item's identity within one session. */
export const realtimeItemIdSchema = z.string().min(1).max(128);

/** A response's identity within one session. */
export const realtimeResponseIdSchema = z.string().min(1).max(128);

/**
 * The audio encodings a session carries, in both directions. Named by what they
 * ARE (sample format, rate) because a realtime stream has no container to say so.
 */
export const realtimeAudioFormatSchema = z.enum(['pcm16_24khz', 'g711_ulaw', 'g711_alaw']);

/** What a session's responses produce. */
export const realtimeOutputModalitySchema = z.enum(['text', 'audio']);

const audioFrameSchema = z
  .string()
  .min(4)
  .max(MAX_REALTIME_AUDIO_FRAME_BASE64_LENGTH)
  .regex(PADDED_BASE64_PATTERN);

const sequenceSchema = z.number().int().nonnegative().safe();

const milliseconds = z.number().int().nonnegative().safe();

/**
 * How the end of a user's turn is detected.
 *
 * `none` means the client commits input audio itself. The two VAD forms name
 * `createResponse` and `interruptResponse` explicitly rather than defaulting
 * them: whether the model answers on its own, and whether new speech cuts it
 * off, are the two behaviours a caller most needs to have chosen, and a default
 * would choose them silently — and differently per provider.
 */
export const realtimeTurnDetectionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z
    .object({
      type: z.literal('server_vad'),
      threshold: z.number().min(0).max(1).optional(),
      prefixPaddingMs: z.number().int().min(0).max(5_000).optional(),
      silenceDurationMs: z.number().int().min(0).max(10_000).optional(),
      createResponse: z.boolean(),
      interruptResponse: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('semantic_vad'),
      eagerness: z.enum(['low', 'medium', 'high', 'auto']),
      createResponse: z.boolean(),
      interruptResponse: z.boolean(),
    })
    .strict(),
]);

/**
 * Transcription of the caller's input audio. Presence enables it; the
 * transcription model is the deployment's own, declared where the deployment
 * is, never chosen by a string here.
 */
export const realtimeInputTranscriptionSchema = z
  .object({
    /** A BCP 47 tag, when the caller knows the language. */
    language: z.string().min(2).max(35).optional(),
    prompt: z.string().max(4_096).optional(),
  })
  .strict();

/** The target of a `translation` session. */
export const realtimeTranslationSchema = z
  .object({
    /** A BCP 47 tag. */
    targetLanguage: z.string().min(2).max(35),
  })
  .strict();

/**
 * A session's full configuration, as signed at open and as echoed back by
 * `session.created` and `session.updated`.
 *
 * `inputAudioFormat` and `turnDetection` are required because every session
 * kind consumes audio and has to know when a turn ends; nothing else is,
 * because each kind needs a different subset — see the refinement on
 * {@link realtimeSessionRequestSchema}.
 */
export const realtimeSessionConfigSchema = z
  .object({
    instructions: z.string().max(32_768).optional(),
    outputModalities: z.array(realtimeOutputModalitySchema).min(1).max(2).optional(),
    voice: z.string().min(1).max(64).optional(),
    inputAudioFormat: realtimeAudioFormatSchema,
    outputAudioFormat: realtimeAudioFormatSchema.optional(),
    turnDetection: realtimeTurnDetectionSchema,
    inputAudioTranscription: realtimeInputTranscriptionSchema.optional(),
    translation: realtimeTranslationSchema.optional(),
    tools: z.array(toolDefinitionSchema).max(128).optional(),
    toolChoice: toolChoiceSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    /** Per response, not per session: the session's ceiling is `limits`. */
    maxOutputTokens: z.number().int().positive().safe().optional(),
  })
  .strict();

/**
 * What `session.update` may change mid-session.
 *
 * The session's kind, its audio formats and its voice are fixed at open —
 * providers refuse to change a voice once it has spoken, and a format change
 * mid-stream would make every buffered frame ambiguous — so they are not fields
 * here, and the strict parse refuses them rather than ignoring them.
 */
export const realtimeSessionConfigUpdateSchema = z
  .object({
    instructions: z.string().max(32_768).optional(),
    outputModalities: z.array(realtimeOutputModalitySchema).min(1).max(2).optional(),
    turnDetection: realtimeTurnDetectionSchema.optional(),
    inputAudioTranscription: realtimeInputTranscriptionSchema.optional(),
    tools: z.array(toolDefinitionSchema).max(128).optional(),
    toolChoice: toolChoiceSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().safe().optional(),
  })
  .strict()
  .superRefine((update, ctx) => {
    if (Object.keys(update).length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'a session update changes at least one field',
      });
    }
  });

/**
 * The ceilings Oxy signed the session for. The data plane enforces each one and
 * closes the session (`limit_exceeded`, `max_duration`, `idle_timeout`) rather
 * than exceeding it: these bound what the session can cost, which is what Oxy's
 * spend reservation was sized against.
 */
export const realtimeSessionLimitsSchema = z
  .object({
    maxDurationMs: z.number().int().min(1_000).max(MAX_REALTIME_SESSION_DURATION_MS),
    idleTimeoutMs: z.number().int().min(1_000).max(MAX_REALTIME_SESSION_DURATION_MS),
    maxInputAudioBytes: z.number().int().positive().max(MAX_REALTIME_SESSION_AUDIO_BYTES),
    maxOutputAudioBytes: z.number().int().positive().max(MAX_REALTIME_SESSION_AUDIO_BYTES),
    maxResponses: z.number().int().positive().max(10_000),
  })
  .strict();

/**
 * One part of a conversation message.
 *
 * `input_audio` carries its audio inline (one bounded frame); `output_audio`
 * never does — spoken output arrives as `output_audio.delta` events, and an
 * item echoing it carries only the format and, once known, the transcript.
 */
export const realtimeContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input_text'), text: z.string().max(1_048_576) }).strict(),
  z
    .object({
      type: z.literal('input_audio'),
      format: realtimeAudioFormatSchema,
      data: audioFrameSchema.optional(),
      transcript: z.string().optional(),
    })
    .strict(),
  z.object({ type: z.literal('output_text'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('output_audio'),
      format: realtimeAudioFormatSchema,
      transcript: z.string().optional(),
    })
    .strict(),
]);

const INPUT_PARTS = new Set(['input_text', 'input_audio']);

/**
 * One item of the conversation a session holds.
 *
 * `itemId` is optional on an item a client CREATES (the server assigns one) and
 * is always stated by the server on the events that carry an item.
 */
export const realtimeConversationItemSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('message'),
        itemId: realtimeItemIdSchema.optional(),
        role: z.enum(['system', 'user', 'assistant']),
        content: z.array(realtimeContentPartSchema).min(1).max(64),
      })
      .strict(),
    z
      .object({
        type: z.literal('function_call'),
        itemId: realtimeItemIdSchema.optional(),
        callId: z.string().min(1).max(128),
        name: z.string().min(1).max(128),
        arguments: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal('function_call_output'),
        itemId: realtimeItemIdSchema.optional(),
        callId: z.string().min(1).max(128),
        output: z.string().max(1_048_576),
      })
      .strict(),
  ])
  .superRefine((item, ctx) => {
    if (item.type !== 'message') return;
    for (const [index, part] of item.content.entries()) {
      const isInput = INPUT_PARTS.has(part.type);
      // A user or system turn is input; an assistant turn is output. A part on
      // the wrong side is one every provider would silently ignore.
      if (item.role === 'assistant' ? isInput : !isInput) {
        ctx.addIssue({
          code: 'custom',
          path: ['content', index, 'type'],
          message: `a ${item.role} message cannot carry ${part.type}`,
        });
      }
      if (item.role === 'system' && part.type !== 'input_text') {
        ctx.addIssue({
          code: 'custom',
          path: ['content', index, 'type'],
          message: 'a system message is text',
        });
      }
    }
  });

/** Per-response overrides for `response.create`. Absent fields keep the session's. */
export const realtimeResponseParametersSchema = z
  .object({
    instructions: z.string().max(32_768).optional(),
    outputModalities: z.array(realtimeOutputModalitySchema).min(1).max(2).optional(),
    maxOutputTokens: z.number().int().positive().safe().optional(),
    toolChoice: toolChoiceSchema.optional(),
  })
  .strict();

const commandBase = {
  /** See `version.ts`: each command is a whole message on the wire. */
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  commandId: realtimeCommandIdSchema,
};

export const realtimeSessionUpdateCommandSchema = z.object({
  ...commandBase,
  type: z.literal('session.update'),
  config: realtimeSessionConfigUpdateSchema,
});

export const realtimeItemCreateCommandSchema = z.object({
  ...commandBase,
  type: z.literal('conversation.item.create'),
  /** Insert after this item; absent appends. */
  previousItemId: realtimeItemIdSchema.optional(),
  item: realtimeConversationItemSchema,
});

export const realtimeItemDeleteCommandSchema = z.object({
  ...commandBase,
  type: z.literal('conversation.item.delete'),
  itemId: realtimeItemIdSchema,
});

/**
 * Cut an assistant's audio item at the point the listener actually heard, after
 * an interruption, so the conversation the model remembers is the one that was
 * spoken rather than the one that was generated.
 */
export const realtimeItemTruncateCommandSchema = z.object({
  ...commandBase,
  type: z.literal('conversation.item.truncate'),
  itemId: realtimeItemIdSchema,
  contentIndex: z.number().int().nonnegative().safe(),
  audioEndMs: milliseconds,
});

export const realtimeInputAudioAppendCommandSchema = z.object({
  ...commandBase,
  type: z.literal('input_audio.append'),
  /** One bounded frame in the session's `inputAudioFormat`. */
  data: audioFrameSchema,
});

export const realtimeInputAudioCommitCommandSchema = z.object({
  ...commandBase,
  type: z.literal('input_audio.commit'),
});

export const realtimeInputAudioClearCommandSchema = z.object({
  ...commandBase,
  type: z.literal('input_audio.clear'),
});

export const realtimeResponseCreateCommandSchema = z.object({
  ...commandBase,
  type: z.literal('response.create'),
  response: realtimeResponseParametersSchema.optional(),
});

export const realtimeResponseCancelCommandSchema = z.object({
  ...commandBase,
  type: z.literal('response.cancel'),
  /** Absent cancels the response in progress, if any. */
  responseId: realtimeResponseIdSchema.optional(),
});

/**
 * The first frame of a reconnection: replay every event after `afterSequence`.
 * `-1` asks for every buffered event from the start.
 */
export const realtimeSessionResumeCommandSchema = z.object({
  ...commandBase,
  type: z.literal('session.resume'),
  afterSequence: z.number().int().min(-1).safe(),
});

export const realtimeSessionCloseCommandSchema = z.object({
  ...commandBase,
  type: z.literal('session.close'),
});

/** Every command a client can send. */
export const realtimeClientCommandSchema = z.discriminatedUnion('type', [
  realtimeSessionUpdateCommandSchema,
  realtimeItemCreateCommandSchema,
  realtimeItemDeleteCommandSchema,
  realtimeItemTruncateCommandSchema,
  realtimeInputAudioAppendCommandSchema,
  realtimeInputAudioCommitCommandSchema,
  realtimeInputAudioClearCommandSchema,
  realtimeResponseCreateCommandSchema,
  realtimeResponseCancelCommandSchema,
  realtimeSessionResumeCommandSchema,
  realtimeSessionCloseCommandSchema,
]);

const eventBase = {
  /** See `version.ts`: each event is a whole message on the wire. */
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  /** One monotonic sequence per session, from 0; what makes a replay detectable. */
  sequence: sequenceSchema,
  /** The command this event answers, when it answers one. */
  commandId: realtimeCommandIdSchema.optional(),
};

export const realtimeSessionUpdatedEventSchema = z.object({
  ...eventBase,
  type: z.literal('session.updated'),
  config: realtimeSessionConfigSchema,
});

export const realtimeSessionResumedEventSchema = z.object({
  ...eventBase,
  type: z.literal('session.resumed'),
  afterSequence: z.number().int().min(-1).safe(),
});

/** Sent before a command is applied. `duplicate` means it was not applied again. */
export const realtimeCommandAcceptedEventSchema = z.object({
  ...eventBase,
  type: z.literal('command.accepted'),
  commandId: realtimeCommandIdSchema,
  duplicate: z.boolean(),
});

export const realtimeItemAddedEventSchema = z.object({
  ...eventBase,
  type: z.literal('conversation.item.added'),
  itemId: realtimeItemIdSchema,
  previousItemId: realtimeItemIdSchema.optional(),
  item: realtimeConversationItemSchema,
});

export const realtimeItemDoneEventSchema = z.object({
  ...eventBase,
  type: z.literal('conversation.item.done'),
  itemId: realtimeItemIdSchema,
  item: realtimeConversationItemSchema,
});

export const realtimeItemDeletedEventSchema = z.object({
  ...eventBase,
  type: z.literal('conversation.item.deleted'),
  itemId: realtimeItemIdSchema,
});

export const realtimeItemTruncatedEventSchema = z.object({
  ...eventBase,
  type: z.literal('conversation.item.truncated'),
  itemId: realtimeItemIdSchema,
  contentIndex: z.number().int().nonnegative().safe(),
  audioEndMs: milliseconds,
});

/**
 * Voice activity began. With `interruptResponse`, a response in progress is
 * cancelled by it: this event is the interruption, and the client should stop
 * playback and truncate what was not heard.
 */
export const realtimeSpeechStartedEventSchema = z.object({
  ...eventBase,
  type: z.literal('input_audio.speech_started'),
  itemId: realtimeItemIdSchema,
  audioStartMs: milliseconds,
});

export const realtimeSpeechStoppedEventSchema = z.object({
  ...eventBase,
  type: z.literal('input_audio.speech_stopped'),
  itemId: realtimeItemIdSchema,
  audioEndMs: milliseconds,
});

export const realtimeInputAudioCommittedEventSchema = z.object({
  ...eventBase,
  type: z.literal('input_audio.committed'),
  itemId: realtimeItemIdSchema,
  previousItemId: realtimeItemIdSchema.optional(),
});

export const realtimeInputAudioClearedEventSchema = z.object({
  ...eventBase,
  type: z.literal('input_audio.cleared'),
});

export const realtimeResponseCreatedEventSchema = z.object({
  ...eventBase,
  type: z.literal('response.created'),
  responseId: realtimeResponseIdSchema,
});

/** One bounded frame of spoken output, in the session's `outputAudioFormat`. */
export const realtimeOutputAudioDeltaEventSchema = z.object({
  ...eventBase,
  type: z.literal('output_audio.delta'),
  responseId: realtimeResponseIdSchema,
  itemId: realtimeItemIdSchema,
  contentIndex: z.number().int().nonnegative().safe(),
  format: realtimeAudioFormatSchema,
  data: audioFrameSchema,
});

export const realtimeOutputAudioDoneEventSchema = z.object({
  ...eventBase,
  type: z.literal('output_audio.done'),
  responseId: realtimeResponseIdSchema,
  itemId: realtimeItemIdSchema,
  contentIndex: z.number().int().nonnegative().safe(),
});

/**
 * Which audio a transcript describes: the caller's (`input_audio`) or the
 * model's own speech (`output_audio`). Neither is answer text.
 */
export const realtimeTranscriptSourceSchema = z.enum(['input_audio', 'output_audio']);

export const realtimeTranscriptDeltaEventSchema = z.object({
  ...eventBase,
  type: z.literal('transcript.delta'),
  source: realtimeTranscriptSourceSchema,
  itemId: realtimeItemIdSchema,
  contentIndex: z.number().int().nonnegative().safe(),
  /** Present for `output_audio`: the response whose speech this is. */
  responseId: realtimeResponseIdSchema.optional(),
  text: z.string(),
});

export const realtimeTranscriptDoneEventSchema = z.object({
  ...eventBase,
  type: z.literal('transcript.done'),
  source: realtimeTranscriptSourceSchema,
  itemId: realtimeItemIdSchema,
  contentIndex: z.number().int().nonnegative().safe(),
  responseId: realtimeResponseIdSchema.optional(),
  transcript: z.string(),
});

/** Written output of a response (`outputModalities` including `text`). */
export const realtimeTextDeltaEventSchema = z.object({
  ...eventBase,
  type: z.literal('text.delta'),
  responseId: realtimeResponseIdSchema,
  itemId: realtimeItemIdSchema,
  contentIndex: z.number().int().nonnegative().safe(),
  text: z.string(),
});

/** A tool call being streamed; same accumulation rules as the one-shot event. */
export const realtimeToolCallEventSchema = z.object({
  ...eventBase,
  type: z.literal('tool_call'),
  responseId: realtimeResponseIdSchema,
  itemId: realtimeItemIdSchema,
  toolCallId: z.string().min(1).max(128),
  name: z.string().min(1).max(128).optional(),
  argumentsDelta: z.string().optional(),
  complete: z.boolean(),
});

/** How a response ended. */
export const realtimeResponseStatusSchema = z.enum([
  'completed',
  'cancelled',
  'incomplete',
  'failed',
]);

/** Why a session ended. */
export const realtimeSessionCloseReasonSchema = z.enum([
  'client_closed',
  'max_duration',
  'idle_timeout',
  'limit_exceeded',
  'resume_expired',
  'upstream_closed',
  'upstream_error',
  'no_route_available',
  'server_shutdown',
]);

/* -------------------------------------------------------------------------- */
/*  Configuration rules shared by the public open frame and the signed request */
/* -------------------------------------------------------------------------- */

/** One configuration a session kind cannot honour, with its path inside `config`. */
export interface RealtimeConfigIssue {
  readonly path: (string | number)[];
  readonly message: string;
}

/**
 * What a session kind requires of its configuration. Each kind needs a
 * different subset of the config, so these rules are cross-field and live
 * here once: the public `session.open` frame and the signed session request
 * apply the same ones, and a session a client may open is one Kaana may run.
 */
export function realtimeConfigIssues(
  kind: z.infer<typeof realtimeSessionKindSchema>,
  config: z.infer<typeof realtimeSessionConfigSchema>,
): RealtimeConfigIssue[] {
  const issues: RealtimeConfigIssue[] = [];
  const found = (path: (string | number)[], message: string) => issues.push({ path, message });

  const producesAudio = config.outputModalities?.includes('audio') === true;
  const hasTools = config.tools !== undefined && config.tools.length > 0;
  switch (kind) {
    case 'conversation':
      if (config.outputModalities === undefined) {
        found(['outputModalities'], 'a conversation names what its responses produce');
      }
      if (producesAudio && (config.voice === undefined || config.outputAudioFormat === undefined)) {
        found([], 'spoken responses need a voice and an output audio format');
      }
      if (config.translation !== undefined) {
        found(['translation'], 'only a translation session translates');
      }
      break;
    case 'transcription':
      if (config.inputAudioTranscription === undefined) {
        found(['inputAudioTranscription'], 'a transcription session transcribes its input');
      }
      for (const field of [
        'outputModalities',
        'voice',
        'outputAudioFormat',
        'translation',
        'tools',
        'toolChoice',
        'maxOutputTokens',
      ] as const) {
        if (config[field] !== undefined) {
          found([field], 'a transcription session never responds');
        }
      }
      if (
        config.turnDetection.type !== 'none' &&
        (config.turnDetection.createResponse || config.turnDetection.interruptResponse)
      ) {
        found(['turnDetection'], 'a transcription session has no response to create or interrupt');
      }
      break;
    case 'translation':
      if (config.translation === undefined || config.outputAudioFormat === undefined) {
        found([], 'a translation session names its target language and output audio format');
      }
      if (config.tools !== undefined || config.toolChoice !== undefined) {
        found(['tools'], 'a translation session calls no tools');
      }
      break;
  }

  if (config.toolChoice !== undefined && !hasTools) {
    found(['toolChoice'], 'a tool choice requires at least one tool definition');
  }
  if (config.tools !== undefined) {
    const names = config.tools.map((tool) => tool.name);
    if (new Set(names).size !== names.length) {
      found(['tools'], 'tool names must be unique within one session');
    }
  }
  if (
    config.outputModalities !== undefined &&
    new Set(config.outputModalities).size !== config.outputModalities.length
  ) {
    found(['outputModalities'], 'each output modality is named at most once');
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*  Opening a session (`GET /v1/realtime`)                                     */
/* -------------------------------------------------------------------------- */

/**
 * The most text `conversation.item.create` commands a session may be opened
 * for: the bound a duration-priced route's hold is sized from.
 */
export const MAX_REALTIME_TEXT_ITEMS = 10_000;

/**
 * The customer's partial limits request: every signed limit, each filled from
 * Kaana's defaults when omitted, plus `maxTextItems`, the most billable text
 * items the session may send (absent, it defaults to `maxResponses`).
 */
export const realtimeOpenLimitsSchema = realtimeSessionLimitsSchema
  .partial()
  .extend({
    maxTextItems: z.number().int().nonnegative().max(MAX_REALTIME_TEXT_ITEMS).optional(),
  })
  .strict();

/**
 * The first frame a client sends on `GET /v1/realtime?model=…` to OPEN a
 * session (a reconnection instead sends `session.resume`). One grant covers the
 * whole session and it is settled exactly once, when the session closes.
 *
 * Moved from the Oxy edge (`realtimeOpenFrameSchema`) by Kaana ADR 0002.
 */
export const realtimeSessionOpenSchema = z
  .object({
    type: z.literal('session.open'),
    kind: realtimeSessionKindSchema,
    /** Absent means `websocket`, the only transport there is. */
    transport: realtimeSessionTransportSchema.optional(),
    config: realtimeSessionConfigSchema,
    limits: realtimeOpenLimitsSchema.optional(),
    /** The caller's own correlation id. */
    clientSessionId: z.string().min(1).max(128).optional(),
    labels: requestLabelsSchema.optional(),
  })
  .strict()
  .superRefine((open, ctx) => {
    for (const found of realtimeConfigIssues(open.kind, open.config)) {
      ctx.addIssue({ code: 'custom', path: ['config', ...found.path], message: found.message });
    }
    const limits = open.limits;
    if (
      limits?.idleTimeoutMs !== undefined &&
      limits.maxDurationMs !== undefined &&
      limits.idleTimeoutMs > limits.maxDurationMs
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['limits', 'idleTimeoutMs'],
        message: 'an idle timeout cannot outlast the session',
      });
    }
  });

/* -------------------------------------------------------------------------- */
/*  Server events a public client reads                                        */
/* -------------------------------------------------------------------------- */

/**
 * The session opened: the revision-pinned model, fixed for the rest of the
 * session, and the effective configuration and limits. The signed lane's
 * `realtimeSessionCreatedEventSchema` also names the provider and deployment;
 * a public client is never told either.
 */
export const realtimePublicSessionCreatedEventSchema = z.object({
  ...eventBase,
  type: z.literal('session.created'),
  /** The revision serving the session. */
  model: modelReferenceSchema,
  kind: realtimeSessionKindSchema,
  config: realtimeSessionConfigSchema,
  limits: realtimeSessionLimitsSchema,
  resumeWindowMs: z.number().int().nonnegative().max(MAX_REALTIME_RESUME_WINDOW_MS),
  startedAt: inferenceTimestampSchema,
  expiresAt: inferenceTimestampSchema,
});

/** A response ended, with the units it consumed. */
export const realtimePublicResponseDoneEventSchema = z.object({
  ...eventBase,
  type: z.literal('response.done'),
  responseId: realtimeResponseIdSchema,
  status: realtimeResponseStatusSchema,
  finishReason: inferenceFinishReasonSchema.optional(),
  units: z.array(usageQuantitySchema),
  usageSource: usageSourceSchema,
});

/**
 * An error in the public vocabulary. `fatal: false` refuses one command and
 * the session continues; `fatal: true` is followed by `session.closed`.
 */
export const realtimePublicErrorEventSchema = z.object({
  ...eventBase,
  type: z.literal('error'),
  fatal: z.boolean(),
  error: publicErrorSchema,
});

/** The terminal event, with the session's total units. */
export const realtimePublicSessionClosedEventSchema = z.object({
  ...eventBase,
  type: z.literal('session.closed'),
  reason: realtimeSessionCloseReasonSchema,
  units: z.array(usageQuantitySchema),
  usageSource: usageSourceSchema,
  closedAt: inferenceTimestampSchema,
});

/** Every event a public session can emit. */
export const realtimePublicServerEventSchema = z
  .discriminatedUnion('type', [
    realtimePublicSessionCreatedEventSchema,
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
    realtimePublicResponseDoneEventSchema,
    realtimePublicErrorEventSchema,
    realtimePublicSessionClosedEventSchema,
  ])
  .superRefine((event, ctx) => {
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

export type RealtimeAudioFormat = z.infer<typeof realtimeAudioFormatSchema>;
export type RealtimeOutputModality = z.infer<typeof realtimeOutputModalitySchema>;
export type RealtimeTurnDetection = z.infer<typeof realtimeTurnDetectionSchema>;
export type RealtimeInputTranscription = z.infer<typeof realtimeInputTranscriptionSchema>;
export type RealtimeTranslation = z.infer<typeof realtimeTranslationSchema>;
export type RealtimeSessionConfig = z.infer<typeof realtimeSessionConfigSchema>;
export type RealtimeSessionConfigUpdate = z.infer<typeof realtimeSessionConfigUpdateSchema>;
export type RealtimeSessionLimits = z.infer<typeof realtimeSessionLimitsSchema>;
export type RealtimeContentPart = z.infer<typeof realtimeContentPartSchema>;
export type RealtimeConversationItem = z.infer<typeof realtimeConversationItemSchema>;
export type RealtimeResponseParameters = z.infer<typeof realtimeResponseParametersSchema>;
export type RealtimeClientCommand = z.infer<typeof realtimeClientCommandSchema>;
export type RealtimeTranscriptSource = z.infer<typeof realtimeTranscriptSourceSchema>;
export type RealtimeResponseStatus = z.infer<typeof realtimeResponseStatusSchema>;
export type RealtimeSessionCloseReason = z.infer<typeof realtimeSessionCloseReasonSchema>;
export type RealtimeOpenLimits = z.infer<typeof realtimeOpenLimitsSchema>;
export type RealtimeSessionOpen = z.infer<typeof realtimeSessionOpenSchema>;
/** What a public client sends after `session.open`: the commands. */
export type RealtimeClientEvent = RealtimeClientCommand;
export type RealtimeServerEvent = z.infer<typeof realtimePublicServerEventSchema>;
