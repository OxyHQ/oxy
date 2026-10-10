/**
 * Realtime sessions — the one inference family that is not a request.
 *
 * Everything else in this contract is one-shot: an envelope goes in, a stream of
 * events comes out, one terminal event ends it. A realtime session (OpenAI's
 * Realtime and Live families, and any provider like them) is a long-lived,
 * two-way conversation over a WebSocket: the client keeps appending audio,
 * editing the conversation and asking for responses, and the server keeps
 * answering, detecting speech, transcribing and being interrupted, for up to an
 * hour. Forcing that through {@link inferenceRequestSchema} would make the
 * request envelope mean two things, so it is its own family: a signed session
 * request, a closed set of client COMMANDS and a closed set of server EVENTS.
 *
 * ## Identity, metering and settlement
 *
 * A session IS one request for attribution, metering and settlement:
 * `attribution.requestId` names it, every command and event carries that
 * `requestId`, and the session settles exactly once, through one
 * `normalizedUsageReportSchema` for that request id, delivered by the transport
 * after `session.closed` exactly as a one-shot stream delivers its report.
 * `response.done` and `session.closed` carry units as MEASUREMENT EVIDENCE, the
 * same standing `inferenceStreamUsageEventSchema` has: settleable units, never a
 * settleable record. No upstream cost appears anywhere in this module.
 *
 * ## Routing
 *
 * A session names a model, never a routing profile, and is never substituted:
 * every authorized route is `same_model`. The data plane may try the routes in
 * order until one OPENS; once `session.created` has been sent the deployment is
 * fixed for the session's life. There is no mid-session failover, because the
 * conversation state lives upstream and a second provider does not have it.
 *
 * ## Framing
 *
 * Every WebSocket frame is ONE JSON text message: a command from the client, an
 * event from the server. Binary frames are refused. Audio travels only as
 * padded base64 inside `input_audio.append`, an `input_audio` content part or
 * `output_audio.delta`, each bounded by {@link MAX_REALTIME_AUDIO_FRAME_BASE64_LENGTH}
 * characters (48 KiB of audio, about one second of 24 kHz PCM16), and a
 * session's total audio in each direction is bounded by its signed
 * `limits`. Audio is never a text delta: a transcript is `transcript.delta`,
 * spoken audio is `output_audio.delta`, and neither is `text.delta`.
 *
 * ## Commands are at-most-once
 *
 * Every command carries a client-chosen `commandId`, unique within the session,
 * and the server answers each with `command.accepted` BEFORE applying it. So:
 *
 *  - A command whose acknowledgement arrived was applied, once.
 *  - A command sent again with a `commandId` the server has already accepted is
 *    NOT applied again: the server answers `command.accepted` with
 *    `duplicate: true`. A client may therefore retry a command it is unsure of by
 *    resending the SAME `commandId`, and only that way.
 *  - A command whose write was AMBIGUOUS — the connection dropped before its
 *    acknowledgement — is never replayed automatically by any hop. Resending it
 *    under a NEW `commandId` is a new command, and appending the same audio twice
 *    is exactly the double-metered input this rule exists to prevent.
 *  - The data plane never replays a command upstream. If ITS upstream connection
 *    drops, the upstream conversation is gone with it and the session ends with
 *    `session.closed` (`upstream_closed` or `upstream_error`).
 *
 * ## Reconnect
 *
 * A dropped client connection does not end the session at once. For
 * `resumeWindowMs` (declared by `session.created`, at most
 * {@link MAX_REALTIME_RESUME_WINDOW_MS}) the client may open a new connection
 * whose FIRST frame is a signed `session.resume` naming the last server
 * `sequence` it processed. The server then replays every event after it, in
 * order, emits `session.resumed`, and continues. Events are numbered from 0 by a
 * single monotonic `sequence` per session, so a replayed event is recognisable
 * as a duplicate rather than as new output. Past the window, or when the named
 * sequence is no longer buffered, the resume is refused and the session closes
 * (`resume_expired`): nothing is guessed. Commands are not part of the replay —
 * see above.
 *
 * ## Authentication
 *
 * The session request and a `session.resume` are the first frame of their
 * connection and are signed with the same edge signature the one-shot envelope
 * carries, over that frame's exact bytes; the signature headers ride on the
 * WebSocket upgrade. Every later frame is covered by the connection that
 * signature opened.
 *
 * Decided in: OxyHQ/Kaana#90.
 */

import { z } from 'zod';
import { inferenceAttributionSchema } from './attribution';
import { realtimeSessionKindSchema, realtimeSessionTransportSchema } from './catalogue';
import { inferenceErrorSchema } from './errors';
import {
  deploymentIdSchema,
  inferenceProviderSlugSchema,
  inferenceTimestampSchema,
  modelReferenceSchema,
  PADDED_BASE64_PATTERN,
  requestIdSchema,
} from './identifiers';
import { usageQuantitySchema, usageSourceSchema } from './money';
import { toolChoiceSchema, toolDefinitionSchema } from './request';
import { authorizedRouteSchema, routingPolicyReferenceSchema } from './routingPolicy';
import { inferenceFinishReasonSchema } from './streamEvents';

/* -------------------------------------------------------------------------- */
/*  Bounds                                                                    */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*  Vocabulary                                                                */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*  Session configuration                                                     */
/* -------------------------------------------------------------------------- */

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
        code: z.ZodIssueCode.custom,
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
 * What the edge records about the session CALL. Strict for the reason
 * `clientRequestMetadataSchema` is: this object is where an IP would be added.
 */
export const realtimeClientMetadataSchema = z
  .object({
    /** The public path, e.g. `/v1/realtime`. */
    endpoint: z.string().min(1).max(256),
    clientSessionId: z.string().min(1).max(128).optional(),
    receivedAt: inferenceTimestampSchema,
    labels: z.record(z.string().max(256)).optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  The session request                                                       */
/* -------------------------------------------------------------------------- */

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
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    if (request.limits.idleTimeoutMs > request.limits.maxDurationMs) {
      issue(['limits', 'idleTimeoutMs'], 'an idle timeout cannot outlast the session');
    }

    const producesAudio = config.outputModalities?.includes('audio') === true;
    const hasTools = config.tools !== undefined && config.tools.length > 0;
    switch (request.kind) {
      case 'conversation':
        if (config.outputModalities === undefined) {
          issue(['config', 'outputModalities'], 'a conversation names what its responses produce');
        }
        if (
          producesAudio &&
          (config.voice === undefined || config.outputAudioFormat === undefined)
        ) {
          issue(['config'], 'spoken responses need a voice and an output audio format');
        }
        if (config.translation !== undefined) {
          issue(['config', 'translation'], 'only a translation session translates');
        }
        break;
      case 'transcription':
        if (config.inputAudioTranscription === undefined) {
          issue(
            ['config', 'inputAudioTranscription'],
            'a transcription session transcribes its input',
          );
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
            issue(['config', field], 'a transcription session never responds');
          }
        }
        if (
          config.turnDetection.type !== 'none' &&
          (config.turnDetection.createResponse || config.turnDetection.interruptResponse)
        ) {
          issue(
            ['config', 'turnDetection'],
            'a transcription session has no response to create or interrupt',
          );
        }
        break;
      case 'translation':
        if (config.translation === undefined || config.outputAudioFormat === undefined) {
          issue(
            ['config'],
            'a translation session names its target language and output audio format',
          );
        }
        if (config.tools !== undefined || config.toolChoice !== undefined) {
          issue(['config', 'tools'], 'a translation session calls no tools');
        }
        break;
    }

    if (config.toolChoice !== undefined && !hasTools) {
      issue(['config', 'toolChoice'], 'a tool choice requires at least one tool definition');
    }
    if (config.tools !== undefined) {
      const names = config.tools.map((tool) => tool.name);
      if (new Set(names).size !== names.length) {
        issue(['config', 'tools'], 'tool names must be unique within one session');
      }
    }
    if (
      config.outputModalities !== undefined &&
      new Set(config.outputModalities).size !== config.outputModalities.length
    ) {
      issue(['config', 'outputModalities'], 'each output modality is named at most once');
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

/* -------------------------------------------------------------------------- */
/*  Conversation items                                                        */
/* -------------------------------------------------------------------------- */

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
          code: z.ZodIssueCode.custom,
          path: ['content', index, 'type'],
          message: `a ${item.role} message cannot carry ${part.type}`,
        });
      }
      if (item.role === 'system' && part.type !== 'input_text') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
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

/* -------------------------------------------------------------------------- */
/*  Client commands                                                           */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*  Server events                                                             */
/* -------------------------------------------------------------------------- */

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
        code: z.ZodIssueCode.custom,
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
export type RealtimeClientMetadata = z.infer<typeof realtimeClientMetadataSchema>;
export type RealtimeSessionRequest = z.infer<typeof realtimeSessionRequestSchema>;
export type RealtimeContentPart = z.infer<typeof realtimeContentPartSchema>;
export type RealtimeConversationItem = z.infer<typeof realtimeConversationItemSchema>;
export type RealtimeResponseParameters = z.infer<typeof realtimeResponseParametersSchema>;
export type RealtimeClientCommand = z.infer<typeof realtimeClientCommandSchema>;
export type RealtimeTranscriptSource = z.infer<typeof realtimeTranscriptSourceSchema>;
export type RealtimeResponseStatus = z.infer<typeof realtimeResponseStatusSchema>;
export type RealtimeSessionCloseReason = z.infer<typeof realtimeSessionCloseReasonSchema>;
export type RealtimeServerEvent = z.infer<typeof realtimeServerEventSchema>;
