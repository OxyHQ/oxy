/**
 * Contract set 3.2.0: spoken output from audio chat models, audio-token units,
 * capability-declared API formats and realtime sessions (OxyHQ/Kaana#90).
 *
 * The compatibility suite round-trips a fixture of every new versioned shape;
 * this file holds the rules those shapes exist to enforce, each with the
 * accepted case beside the refused one so a refinement that refuses everything
 * cannot pass.
 */

import {
  inferenceRequestSchema,
  inferenceStreamDeltaEventSchema,
  MAX_REALTIME_AUDIO_FRAME_BASE64_LENGTH,
  modelCapabilitiesSchema,
  realtimeClientCommandSchema,
  realtimeConversationItemSchema,
  realtimeServerEventSchema,
  realtimeSessionConfigUpdateSchema,
  realtimeSessionRequestSchema,
  USAGE_UNITS,
} from "../index";

const attribution = {
  principal: {
    billing: { accountId: "acc_1" },
    applicationId: "app_1",
    credentialId: "cred_1",
    environment: "production" as const,
    inferenceScopes: ["inference:invoke"],
  },
  requestId: "req_rt_1",
};

/* -------------------------------------------------------------------------- */
/*  Audio chat                                                                */
/* -------------------------------------------------------------------------- */

const audioChat = {
  schemaVersion: 2,
  attribution,
  target: { kind: "model", modelReference: "openai/gpt-audio-1.5" },
  modality: "audio",
  input: {
    format: "messages",
    messages: [{ role: "user", content: [{ type: "text", text: "Say hello." }] }],
  },
  stream: true,
  sampling: {},
  tools: [],
  audioOutput: { voice: "marin", format: "pcm" },
  client: {
    apiFormat: "chat_completions",
    endpoint: "/v1/chat/completions",
    receivedAt: "2026-09-30T10:00:00.000Z",
  },
  routingPolicy: { routingPolicyId: "rp_1", policyVersion: 3 },
};

describe("spoken output from a conversational model", () => {
  it("accepts a streamed pcm audio chat request", () => {
    expect(inferenceRequestSchema.parse(audioChat).audioOutput).toEqual({ voice: "marin", format: "pcm" });
  });

  it("accepts a whole (non-streamed) request in a container format", () => {
    expect(
      inferenceRequestSchema.safeParse({ ...audioChat, stream: false, audioOutput: { voice: "marin", format: "mp3" } }).success,
    ).toBe(true);
  });

  it.each([
    ["another dialect", { client: { ...audioChat.client, apiFormat: "responses", endpoint: "/v1/responses" } }],
    ["text modality", { modality: "text" }],
    ["a text input", { input: { format: "text", text: "Say hello." } }],
    ["a streamed container format", { audioOutput: { voice: "marin", format: "mp3" } }],
    ["an unknown field on the leaf", { audioOutput: { voice: "marin", format: "pcm", speed: 1 } }],
  ])("refuses spoken output with %s", (_, override) => {
    expect(inferenceRequestSchema.safeParse({ ...audioChat, ...override }).success).toBe(false);
  });

  it("carries the transcript on its own delta channel", () => {
    const delta = { schemaVersion: 1, type: "delta", requestId: "req_1", sequence: 3, outputIndex: 0, text: "Hello" };
    expect(inferenceStreamDeltaEventSchema.safeParse({ ...delta, channel: "output_audio_transcript" }).success).toBe(true);
    expect(inferenceStreamDeltaEventSchema.safeParse({ ...delta, channel: "audio_transcript" }).success).toBe(false);
  });

  it("meters audio tokens as their own units, siblings of the text tokens", () => {
    expect(USAGE_UNITS).toEqual(
      expect.arrayContaining(["audio_input_tokens", "cached_audio_input_tokens", "audio_output_tokens", "input_tokens"]),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Capabilities                                                              */
/* -------------------------------------------------------------------------- */

const capabilities = {
  inputModalities: ["text", "audio"],
  outputModalities: ["text", "audio"],
  tools: true,
  parallelToolCalls: false,
  structuredOutput: false,
  jsonMode: false,
  reasoning: false,
  streaming: true,
  promptCaching: true,
  maxContextTokens: 32_000,
  maxOutputTokens: 4_096,
};

describe("capability-declared request shapes", () => {
  it("parses a catalogue from before 3.2.0, which declares neither", () => {
    const parsed = modelCapabilitiesSchema.parse(capabilities);
    expect(parsed.apiFormats).toBeUndefined();
    expect(parsed.realtime).toBeUndefined();
  });

  it("parses a realtime model's declaration", () => {
    expect(
      modelCapabilitiesSchema.safeParse({
        ...capabilities,
        apiFormats: ["chat_completions"],
        realtime: { transports: ["websocket"], sessionKinds: ["conversation"] },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["an empty format list", { apiFormats: [] }],
    ["a repeated format", { apiFormats: ["chat_completions", "chat_completions"] }],
    ["an unknown format", { apiFormats: ["realtime"] }],
    ["a repeated session kind", { realtime: { transports: ["websocket"], sessionKinds: ["conversation", "conversation"] } }],
    ["an unknown transport", { realtime: { transports: ["webrtc"], sessionKinds: ["conversation"] } }],
    [
      "sessions on a model that consumes no audio",
      { inputModalities: ["text"], realtime: { transports: ["websocket"], sessionKinds: ["transcription"] } },
    ],
  ])("refuses %s", (_, override) => {
    expect(modelCapabilitiesSchema.safeParse({ ...capabilities, ...override }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Realtime sessions                                                         */
/* -------------------------------------------------------------------------- */

const route = {
  substitution: "same_model",
  modelReference: "openai/gpt-realtime-2.1@2026-08-28",
  provider: "openai",
  deploymentId: "dep_rt_1",
  regions: ["us-east-1"],
};

const session = {
  schemaVersion: 1,
  attribution,
  modelReference: "openai/gpt-realtime-2.1",
  kind: "conversation",
  transport: "websocket",
  config: {
    outputModalities: ["audio"],
    voice: "marin",
    inputAudioFormat: "pcm16_24khz",
    outputAudioFormat: "pcm16_24khz",
    turnDetection: { type: "semantic_vad", eagerness: "auto", createResponse: true, interruptResponse: true },
  },
  limits: {
    maxDurationMs: 600_000,
    idleTimeoutMs: 60_000,
    maxInputAudioBytes: 28_800_000,
    maxOutputAudioBytes: 28_800_000,
    maxResponses: 50,
  },
  client: { endpoint: "/v1/realtime", receivedAt: "2026-09-30T10:00:00.000Z" },
  routingPolicy: { routingPolicyId: "rp_1", policyVersion: 3 },
  authorizedRoutes: [route],
};

const transcriptionSession = {
  ...session,
  modelReference: "openai/gpt-live-transcribe",
  kind: "transcription",
  config: {
    inputAudioFormat: "pcm16_24khz",
    turnDetection: { type: "server_vad", createResponse: false, interruptResponse: false },
    inputAudioTranscription: { language: "es" },
  },
  authorizedRoutes: [{ ...route, modelReference: "openai/gpt-live-transcribe@2026-09-01" }],
};

describe("realtime session request", () => {
  it("accepts a conversation and a transcription session", () => {
    expect(realtimeSessionRequestSchema.safeParse(session).success).toBe(true);
    expect(realtimeSessionRequestSchema.safeParse(transcriptionSession).success).toBe(true);
  });

  it("accepts a translation session", () => {
    expect(
      realtimeSessionRequestSchema.safeParse({
        ...session,
        kind: "translation",
        config: {
          inputAudioFormat: "pcm16_24khz",
          outputAudioFormat: "pcm16_24khz",
          turnDetection: { type: "none" },
          translation: { targetLanguage: "fr" },
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["a conversation that names no output", { config: { ...session.config, outputModalities: undefined } }],
    ["spoken output without a voice", { config: { ...session.config, voice: undefined } }],
    ["a tool choice without tools", { config: { ...session.config, toolChoice: "auto" } }],
    ["an idle timeout longer than the session", { limits: { ...session.limits, idleTimeoutMs: 700_000 } }],
    ["a session longer than an hour", { limits: { ...session.limits, maxDurationMs: 3_600_001 } }],
    ["no authorized route", { authorizedRoutes: [] }],
    [
      "a cross-model substitute",
      {
        authorizedRoutes: [
          route,
          { ...route, substitution: "cross_model", modelReference: "openai/gpt-realtime-2@2026-05-01", deploymentId: "dep_rt_2", authorizedByPolicy: true },
        ],
      },
    ],
    ["a route on another model line", { authorizedRoutes: [{ ...route, modelReference: "openai/gpt-realtime-2@2026-05-01" }] }],
    ["another revision than the one pinned", { modelReference: "openai/gpt-realtime-2.1@2026-01-01" }],
    ["the same deployment twice", { authorizedRoutes: [route, route] }],
    ["an unknown transport", { transport: "webrtc" }],
    ["a caller IP on the client metadata", { client: { ...session.client, ip: "203.0.113.9" } }],
  ])("refuses %s", (_, override) => {
    expect(realtimeSessionRequestSchema.safeParse({ ...session, ...override }).success).toBe(false);
  });

  it.each([
    ["a voice", { voice: "marin" }],
    ["tools", { tools: [{ type: "function", name: "f", parameters: {} }] }],
    ["automatic responses", { turnDetection: { type: "server_vad", createResponse: true, interruptResponse: false } }],
    ["no transcription", { inputAudioTranscription: undefined }],
  ])("refuses a transcription session with %s", (_, override) => {
    expect(
      realtimeSessionRequestSchema.safeParse({
        ...transcriptionSession,
        config: { ...transcriptionSession.config, ...override },
      }).success,
    ).toBe(false);
  });
});

describe("realtime commands and events", () => {
  const command = { schemaVersion: 1, requestId: "req_rt_1", commandId: "cmd_1" };
  const event = { schemaVersion: 1, requestId: "req_rt_1", sequence: 4 };

  it("bounds every audio frame", () => {
    const append = { ...command, type: "input_audio.append" };
    const largest = "A".repeat(MAX_REALTIME_AUDIO_FRAME_BASE64_LENGTH);
    expect(realtimeClientCommandSchema.safeParse({ ...append, data: largest }).success).toBe(true);
    expect(realtimeClientCommandSchema.safeParse({ ...append, data: `${largest}AAAA` }).success).toBe(false);
    expect(realtimeClientCommandSchema.safeParse({ ...append, data: "not base64!" }).success).toBe(false);
  });

  it("refuses a command without a command id, which could not be deduplicated", () => {
    expect(realtimeClientCommandSchema.safeParse({ schemaVersion: 1, requestId: "req_rt_1", type: "input_audio.commit" }).success).toBe(false);
  });

  it("refuses a session update that changes nothing, or changes what is fixed at open", () => {
    expect(realtimeSessionConfigUpdateSchema.safeParse({ temperature: 0.5 }).success).toBe(true);
    expect(realtimeSessionConfigUpdateSchema.safeParse({}).success).toBe(false);
    expect(realtimeSessionConfigUpdateSchema.safeParse({ voice: "cedar" }).success).toBe(false);
    expect(realtimeSessionConfigUpdateSchema.safeParse({ inputAudioFormat: "g711_ulaw" }).success).toBe(false);
  });

  it("resumes only from an explicit sequence", () => {
    const resume = { ...command, type: "session.resume" };
    expect(realtimeClientCommandSchema.safeParse({ ...resume, afterSequence: -1 }).success).toBe(true);
    expect(realtimeClientCommandSchema.safeParse(resume).success).toBe(false);
    expect(realtimeClientCommandSchema.safeParse({ ...resume, afterSequence: -2 }).success).toBe(false);
  });

  it("keeps input and output parts on their own side of the conversation", () => {
    const message = { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] };
    expect(realtimeConversationItemSchema.safeParse(message).success).toBe(true);
    expect(
      realtimeConversationItemSchema.safeParse({ ...message, content: [{ type: "output_text", text: "hi" }] }).success,
    ).toBe(false);
    expect(
      realtimeConversationItemSchema.safeParse({ ...message, role: "assistant" }).success,
    ).toBe(false);
    expect(
      realtimeConversationItemSchema.safeParse({
        ...message,
        role: "system",
        content: [{ type: "input_audio", format: "pcm16_24khz", data: "AAAA" }],
      }).success,
    ).toBe(false);
  });

  it("never carries spoken output inline in an item", () => {
    const item = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_audio", format: "pcm16_24khz", data: "AAAA" }],
    };
    expect(realtimeConversationItemSchema.safeParse(item).success).toBe(false);
  });

  it("reports each unit once on a response and on the close", () => {
    const done = {
      ...event,
      type: "response.done",
      responseId: "resp_1",
      status: "cancelled",
      deploymentId: "dep_rt_1",
      usageSource: "provider_reported",
    };
    expect(realtimeServerEventSchema.safeParse({ ...done, units: [{ unit: "audio_output_tokens", quantity: 12 }] }).success).toBe(true);
    expect(
      realtimeServerEventSchema.safeParse({
        ...done,
        units: [
          { unit: "audio_output_tokens", quantity: 12 },
          { unit: "audio_output_tokens", quantity: 3 },
        ],
      }).success,
    ).toBe(false);
    const closed = {
      ...event,
      type: "session.closed",
      reason: "max_duration",
      usageSource: "provider_reported",
      closedAt: "2026-09-30T11:00:00.000Z",
    };
    expect(realtimeServerEventSchema.safeParse({ ...closed, units: [] }).success).toBe(true);
    expect(
      realtimeServerEventSchema.safeParse({
        ...closed,
        units: [
          { unit: "input_tokens", quantity: 1 },
          { unit: "input_tokens", quantity: 1 },
        ],
      }).success,
    ).toBe(false);
  });

  it("acknowledges a duplicate command without applying it twice", () => {
    const accepted = { ...event, type: "command.accepted", commandId: "cmd_1" };
    expect(realtimeServerEventSchema.parse({ ...accepted, duplicate: true })).toMatchObject({ duplicate: true });
    expect(realtimeServerEventSchema.safeParse(accepted).success).toBe(false);
  });

  it("refuses an event type outside the closed set", () => {
    expect(realtimeServerEventSchema.safeParse({ ...event, type: "response.audio.delta" }).success).toBe(false);
  });
});
