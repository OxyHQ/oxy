/**
 * The public catalogue: what `GET /v1/models` and `GET /v1/power-levels` say.
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/catalogue.ts`) by Kaana ADR 0002.
 */

import { z } from 'zod';
import {
  inferenceDateSchema,
  inferenceHttpsUrlSchema,
  inferenceRegionSchema,
  inferenceTimestampSchema,
  modelIdSchema,
  modelReferenceSchema,
  modelRevisionLabelSchema,
  publisherSlugSchema,
} from './identifiers.js';
import {
  audioInputMediaTypeSchema,
  languageTagSchema,
  realtimeAudioFormatSchema,
} from './audioFormats.js';
import { priceSnapshotSchema } from './money.js';
import { inferenceAudioMediaTypeSchema } from './streamEvents.js';

/** Input/request modalities; structured decisions are an output, never an input. */
export const inferenceModalitySchema = z.enum(['text', 'image', 'audio', 'video', 'embedding']);

/** Declared model outputs, separate from request/input modalities. */
export const inferenceOutputModalitySchema = z.enum([
  ...inferenceModalitySchema.options,
  'decisions',
]);

/**
 * How hard a reasoning model is asked to think before it answers.
 *
 * A closed, provider-neutral vocabulary: Kaana translates each value into the
 * serving provider's own control. A model advertises the subset it accepts in
 * `modelCapabilitiesSchema.reasoningEfforts`, and Oxy refuses a request for an
 * effort the resolved model does not advertise rather than dropping it.
 */
export const reasoningEffortSchema = z.enum(['low', 'medium', 'high']);

/**
 * A POWER LEVEL: the public name of a product-preset routing profile that asks
 * Oxy to choose a model by capability tier instead of naming one (contract set
 * 3.4.0). Ordered cheapest first; `auto` asks Oxy to pick the cheapest level
 * that suffices for the request.
 *
 * - `instant` — very cheap, fast small models; the least reasoning each model
 *   accepts (`low` on a reasoning model, nothing on one without effort control)
 * - `medium` — mid-size models, low reasoning effort
 * - `high` — strong models, medium reasoning effort
 * - `xhigh` — strong models, high reasoning effort
 * - `pro` — frontier models, high reasoning effort
 * - `ultra` — the heaviest frontier models, maximum reasoning effort
 *
 * A power level is a routing profile, never a model: its slug has no `/`, and
 * the response always reports the concrete model that ran.
 */
export const powerLevelSchema = z.enum([
  'auto',
  'instant',
  'medium',
  'high',
  'xhigh',
  'pro',
  'ultra',
]);

/**
 * The reviewed capability tier of one MODEL, which power levels choose from.
 * `xhigh` and `auto` are not classes: `xhigh` runs `high`-class models at a
 * higher effort, and `auto` chooses a level. Reviewed catalogue data with a
 * cited public benchmark source — never inferred from a model's name.
 */
export const modelPowerClassSchema = z.enum(['instant', 'medium', 'high', 'pro', 'ultra']);

/**
 * The public dialects a request can arrive in — `client.apiFormat` on the
 * envelope, and the list a deployment declares it can execute.
 *
 * Named (contract set 3.2.0) rather than inline on the client metadata so the
 * two uses cannot drift: a capability naming a dialect the envelope cannot
 * carry, or the reverse, would authorize a request no route can serve.
 */
export const inferenceApiFormatSchema = z.enum([
  'responses',
  'chat_completions',
  'embeddings',
  'decisions',
  'images_generations',
  'audio_transcriptions',
  'audio_speech',
  'rerank',
  'batches',
]);

/**
 * What a realtime session is FOR. The three are different upstream products
 * with different event families and different metering, not options of one:
 *
 *  - `conversation` — a speech-to-speech (or text) model holding a dialogue,
 *    with responses, tool calls and interruption.
 *  - `transcription` — live speech-to-text; the model never responds, it only
 *    transcribes committed input audio.
 *  - `translation` — live speech-to-speech translation into one target language.
 */
export const realtimeSessionKindSchema = z.enum(['conversation', 'transcription', 'translation']);

/**
 * How a realtime session is carried. One member today: a WebSocket, whose every
 * frame is one JSON message (see `realtime.ts`). WebRTC and SIP are separate
 * transports with separate media handling, and are added as members only when a
 * deployment can actually execute them.
 */
export const realtimeSessionTransportSchema = z.enum(['websocket']);

/**
 * What a deployment can execute as a realtime session. Present only on a model
 * that holds sessions; absent means it holds none, which is the state of every
 * catalogue written before contract set 3.2.0.
 *
 * Two optional fields arrived in contract set 4.1.0 (Alia ADR 0017, Kaana
 * phase 1), and ABSENT means undeclared — a catalogue from an older producer —
 * never "every value":
 *
 * - `inputAudioTranscription` — the model transcribes the caller's speech
 *   inside a `conversation` when the session asks for it
 *   (`config.inputAudioTranscription`), and delivers each turn as a
 *   `transcript.done` with `source: 'input_audio'`. Absent or `false`: a
 *   session that asks is refused before anything is held.
 * - `audioFormats` — the realtime encodings a session may name as
 *   `config.inputAudioFormat` and `config.outputAudioFormat`. These are not the
 *   media types of `audio.audioFormats`, which describe files.
 */
export const modelRealtimeCapabilitiesSchema = z
  .object({
    transports: z.array(realtimeSessionTransportSchema).min(1),
    sessionKinds: z.array(realtimeSessionKindSchema).min(1),
    inputAudioTranscription: z.boolean().optional(),
    audioFormats: z
      .object({
        input: z.array(realtimeAudioFormatSchema).min(1),
        output: z.array(realtimeAudioFormatSchema),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * What a model can do, in the terms a caller has to decide against before
 * sending a request: can it call tools, does it accept images, will it honour a
 * JSON schema, how much context does it take, how much can it emit.
 */
export const modelCapabilitiesSchema = z
  .object({
    inputModalities: z.array(inferenceModalitySchema).min(1),
    outputModalities: z.array(inferenceOutputModalitySchema).min(1),
    tools: z.boolean(),
    parallelToolCalls: z.boolean(),
    structuredOutput: z.boolean(),
    jsonMode: z.boolean(),
    reasoning: z.boolean(),
    /**
     * The reasoning efforts a request may name for this model, in the order
     * low → high. Empty means the model takes no effort control at all (it may
     * still reason: `reasoning` answers that). Added in contract set 3.1.0;
     * absent on the wire from an older producer, it parses as `[]`.
     */
    reasoningEfforts: z.array(reasoningEffortSchema).default([]),
    streaming: z.boolean(),
    promptCaching: z.boolean(),
    maxContextTokens: z.number().int().positive().safe(),
    maxOutputTokens: z.number().int().positive().safe(),
    /**
     * The request dialects a route to this model can EXECUTE. Modalities say
     * what a model consumes and produces; they do not say which request shape a
     * route can carry, and catalogue presence is not that evidence either — a
     * speech-to-speech model is `audio` in and out and still cannot answer a
     * `/v1/audio/transcriptions` upload. Oxy authorizes a request only when its
     * `client.apiFormat` is listed here.
     *
     * Added in contract set 3.2.0. ABSENT means undeclared — a catalogue from an
     * older producer — never "every format": a consumer then applies the rules it
     * applied before this field existed, and authorizes no format that needs a
     * declaration (audio output on `chat_completions`, a realtime session).
     */
    apiFormats: z.array(inferenceApiFormatSchema).min(1).optional(),
    /** Realtime sessions this model holds; absent means none. Contract set 3.2.0. */
    realtime: modelRealtimeCapabilitiesSchema.optional(),
  })
  .strict()
  .superRefine((capabilities, ctx) => {
    const formats = capabilities.apiFormats;
    if (formats !== undefined && new Set(formats).size !== formats.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['apiFormats'],
        message: 'each API format is declared at most once',
      });
    }
    const realtime = capabilities.realtime;
    if (realtime === undefined) return;
    if (new Set(realtime.sessionKinds).size !== realtime.sessionKinds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['realtime', 'sessionKinds'],
        message: 'each session kind is declared at most once',
      });
    }
    if (new Set(realtime.transports).size !== realtime.transports.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['realtime', 'transports'],
        message: 'each transport is declared at most once',
      });
    }
    for (const direction of ['input', 'output'] as const) {
      const formats = realtime.audioFormats?.[direction];
      if (formats !== undefined && new Set(formats).size !== formats.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['realtime', 'audioFormats', direction],
          message: 'each realtime audio format is declared at most once',
        });
      }
    }
    // A realtime session consumes audio: a model that declares sessions and no
    // audio input is a declaration no session could honour.
    if (!capabilities.inputModalities.includes('audio')) {
      ctx.addIssue({
        code: 'custom',
        path: ['realtime'],
        message: 'a model that holds realtime sessions consumes audio',
      });
    }
  });

/**
 * License terms, including the two questions that decide whether Oxy may serve
 * a model to third parties at all: is commercial use permitted, and must the
 * base model be attributed.
 */
export const modelLicenseSchema = z
  .object({
    /** SPDX identifier where one exists, otherwise the publisher's own name. */
    licenseId: z.string().min(1).max(128),
    displayName: z.string().min(1).max(200),
    url: inferenceHttpsUrlSchema.optional(),
    commercialUseAllowed: z.boolean(),
    requiresAttribution: z.boolean(),
    acceptableUsePolicyUrl: inferenceHttpsUrlSchema.optional(),
  })
  .strict();

/**
 * How a model came to exist.
 *
 * `releaseKind` is what stops `alia/*` from becoming a re-badging namespace:
 * a first-party namespace may only carry models Alia actually trained or
 * derived, never a third-party route wearing an Oxy name.
 */
export const modelProvenanceSchema = z
  .object({
    releaseKind: z.enum([
      'first_party_original',
      'first_party_derived',
      'open_weight',
      'third_party_hosted',
    ]),
    /** The model this one was derived/fine-tuned from, where there is one. */
    baseModelId: modelIdSchema.optional(),
    trainingOrganization: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * What happens to the customer's prompts and responses on a given route.
 *
 * Every field here is enforceable by a routing policy, which is the reason they
 * are structured rather than a prose paragraph on a docs page.
 */
export const inferenceDataPolicySchema = z
  .object({
    retainsPayloads: z.boolean(),
    /** Zero when nothing is retained. */
    retentionDays: z.number().int().nonnegative().max(3650),
    trainsOnCustomerData: z.boolean(),
    zeroDataRetentionAvailable: z.boolean(),
    /** Named subprocessors a payload may pass through, for compliance review. */
    subprocessors: z.array(z.string().min(1).max(200)).default([]),
    policyUrl: inferenceHttpsUrlSchema.optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (!policy.retainsPayloads && policy.retentionDays > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['retentionDays'],
        message: 'a route that retains no payloads cannot have a retention window',
      });
    }

    // Training requires having the data to train on. A route claiming both is
    // reporting one of the two fields wrongly, and a routing policy that
    // prohibits training would be enforced against a value that is not true.
    if (!policy.retainsPayloads && policy.trainsOnCustomerData) {
      ctx.addIssue({
        code: 'custom',
        path: ['trainsOnCustomerData'],
        message: 'a route that retains no payloads cannot train on customer data',
      });
    }
  });

/** Deprecation state, with the replacement a customer should migrate to. */
export const modelDeprecationSchema = z
  .object({
    status: z.enum(['active', 'deprecated', 'retired']),
    replacementModelReference: modelReferenceSchema.optional(),
    announcedAt: inferenceTimestampSchema.optional(),
    sunsetAt: inferenceTimestampSchema.optional(),
  })
  .strict()
  .superRefine((deprecation, ctx) => {
    if (deprecation.status === 'active' && deprecation.sunsetAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['sunsetAt'],
        message: 'an active model has no sunset date; announce the deprecation first',
      });
    }
  });

/** One published evaluation result for a revision. */
export const modelEvaluationResultSchema = z
  .object({
    suite: z.string().min(1).max(128),
    metric: z.string().min(1).max(128),
    /** Kept as a string: an eval score is published text, not arithmetic. */
    score: z.string().min(1).max(64),
    evaluatedAt: inferenceTimestampSchema.optional(),
    reportUrl: inferenceHttpsUrlSchema.optional(),
  })
  .strict();

/**
 * Safety metadata a downstream developer needs, and the EU AI Act / GPAI
 * documentation trail expects to find beside a served model.
 */
export const modelSafetyMetadataSchema = z
  .object({
    safetyCardUrl: inferenceHttpsUrlSchema.optional(),
    contentFilteringDefault: z.enum(['none', 'provider_default', 'strict']),
    knownLimitations: z.array(z.string().min(1).max(500)).default([]),
    /** Content-provenance marking the modality requires, where it requires one. */
    provenanceMarking: z.enum(['none', 'visible_watermark', 'invisible_watermark', 'c2pa']),
  })
  .strict();

/** The publisher fields a customer sees beside a model. */
export const cataloguePublisherSummarySchema = z
  .object({
    slug: publisherSlugSchema,
    displayName: z.string().min(1).max(200),
    websiteUrl: inferenceHttpsUrlSchema.optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Audio capabilities (Kaana ADR 0002, decision 9)                           */
/* -------------------------------------------------------------------------- */

/** One voice a speech or realtime model can speak in. */
export const voiceSchema = z
  .object({
    /** What a speech request names in `voice`. */
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    /** The languages this voice speaks; each is one of the model's `languages`. */
    languages: z.array(languageTagSchema),
    gender: z.enum(['female', 'male', 'neutral']).optional(),
  })
  .strict();

/**
 * What an audio model accepts, published so a request that cannot be served
 * is refused BEFORE a grant or a reservation (`invalid_request` with `param`),
 * never by an adapter after money was held.
 *
 * When several providers serve one model line, the published value is the
 * INTERSECTION — what every one of them accepts — so a request that passes
 * here is servable by any route of the line.
 *
 * - `voices` — empty for a model that reads no text aloud (transcription).
 * - `audioFormats.input` — the media types an upload may have (transcription).
 * - `audioFormats.output` — the media types speech can be produced in.
 * - `speed` — absent when the model accepts no speed control; a request that
 *   names one is then refused.
 * - `maxInputCharacters` — the longest text one speech request may carry,
 *   counted in UTF-16 code units, as JavaScript's `length` counts.
 *
 * A REALTIME model publishes the same shape (contract set 4.1.0): `voices` are
 * what a session's `config.voice` may name, `languages` what it converses in
 * and what `config.inputAudioTranscription.language` may name, and
 * `audioFormats` is empty in both directions because a session carries no
 * files — its encodings are `capabilities.realtime.audioFormats`. An empty
 * `languages` means the provider documents none, not that the model speaks
 * none; a caller that needs a language then cannot choose the model.
 * `gender` is published only where it has been reviewed against the
 * provider's own catalogue; absent is unknown.
 */
export const modelAudioCapabilitiesSchema = z
  .object({
    voices: z.array(voiceSchema),
    languages: z.array(languageTagSchema),
    audioFormats: z
      .object({
        input: z.array(audioInputMediaTypeSchema),
        output: z.array(inferenceAudioMediaTypeSchema),
      })
      .strict(),
    speed: z
      .object({
        min: z.number().min(0.25).max(4),
        max: z.number().min(0.25).max(4),
      })
      .strict()
      .optional(),
    maxInputCharacters: z.number().int().positive().safe().optional(),
  })
  .strict()
  .superRefine((audio, ctx) => {
    const ids = audio.voices.map((voice) => voice.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['voices'], message: 'each voice id is declared once' });
    }
    const languages = new Set(audio.languages);
    if (languages.size !== audio.languages.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['languages'],
        message: 'each language is declared once',
      });
    }
    for (const [index, voice] of audio.voices.entries()) {
      for (const [languageIndex, language] of voice.languages.entries()) {
        if (!languages.has(language)) {
          ctx.addIssue({
            code: 'custom',
            path: ['voices', index, 'languages', languageIndex],
            message: `voice ${voice.id} speaks ${language}, which the model does not declare`,
          });
        }
      }
    }
    if (audio.speed !== undefined && audio.speed.min > audio.speed.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['speed'],
        message: 'a speed range cannot end below where it starts',
      });
    }
  });

/* -------------------------------------------------------------------------- */
/*  The public catalogue (`GET /v1/models`)                                    */
/* -------------------------------------------------------------------------- */

/**
 * One model as `GET /v1/models` and `GET /v1/models/{publisher}/{model}`
 * serve it: modalities, power class, limits, parameters, audio capabilities and
 * the customer price.
 *
 * Derived from Oxy's `modelCatalogueEntrySchema` without what names who serves
 * the model: no serving provider, no deployment, no availability scope and no
 * commercial permission. Those are in the operational catalogue under
 * `@kaana.ai/contracts/internal`.
 */
export const modelSchema = z.object({
  /** A whole message on the wire, so it is versioned. */
  schemaVersion: z.literal(1),
  modelId: modelIdSchema,
  publisher: cataloguePublisherSummarySchema,
  displayName: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  currentRevision: modelRevisionLabelSchema,
  /** Revisions a customer may pin today, newest first. */
  availableRevisions: z.array(modelRevisionLabelSchema).min(1),
  capabilities: modelCapabilitiesSchema,
  /** Present for a model that consumes or produces audio. */
  audio: modelAudioCapabilitiesSchema.optional(),
  license: modelLicenseSchema,
  provenance: modelProvenanceSchema,
  knowledgeCutoff: inferenceDateSchema.optional(),
  releasedOn: inferenceDateSchema.optional(),
  /** When the model was first published upstream, as reported; never an observation time. */
  releasedAt: inferenceTimestampSchema.optional(),
  /** Attested regions some route of this model serves from; empty means none attested. */
  regions: z.array(inferenceRegionSchema).default([]),
  /** The data policy every route of this model satisfies. */
  dataPolicy: inferenceDataPolicySchema,
  /** Oxy's list price. Absent for a model a customer cannot buy per unit (BYOK-only). */
  pricing: priceSnapshotSchema.optional(),
  deprecation: modelDeprecationSchema,
  evaluations: z.array(modelEvaluationResultSchema).default([]),
  safety: modelSafetyMetadataSchema.optional(),
  modelCardUrl: inferenceHttpsUrlSchema.optional(),
  /** The reviewed power class. Absent: callable by name only, chosen by no power level. */
  powerClass: modelPowerClassSchema.optional(),
});

/** `GET /v1/models`. */
export const modelListSchema = z.object({ data: z.array(modelSchema) }).strict();

/**
 * One power level as `GET /v1/power-levels` lists it for the calling
 * credential: the level, the class it draws from, the effort it asks for, and
 * the model lines it can currently choose among.
 *
 * `auto` draws from no single class (it chooses a level), so it carries no
 * `powerClass` and lists every line of the levels it may climb to.
 */
export const powerLevelEntrySchema = z
  .object({
    level: powerLevelSchema,
    powerClass: modelPowerClassSchema.optional(),
    /** The effort the level asks for when the request names none. */
    reasoningEffort: reasoningEffortSchema.optional(),
    /** Model lines (`publisher/model`) the level can choose today, for this credential. */
    modelLines: z.array(modelIdSchema),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if ((entry.level === 'auto') !== (entry.powerClass === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['powerClass'],
        message: 'every level but auto draws from exactly one power class',
      });
    }
    if (new Set(entry.modelLines).size !== entry.modelLines.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['modelLines'],
        message: 'each model line is listed once',
      });
    }
  });

/** `GET /v1/power-levels`. Replaces Oxy's `/v1/models/routing-profiles`. */
export const powerLevelListSchema = z.object({ data: z.array(powerLevelEntrySchema) }).strict();

export type InferenceOutputModality = z.infer<typeof inferenceOutputModalitySchema>;
export type InferenceModality = z.infer<typeof inferenceModalitySchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type PowerLevel = z.infer<typeof powerLevelSchema>;
export type ModelPowerClass = z.infer<typeof modelPowerClassSchema>;
export type InferenceApiFormat = z.infer<typeof inferenceApiFormatSchema>;
export type RealtimeSessionKind = z.infer<typeof realtimeSessionKindSchema>;
export type RealtimeSessionTransport = z.infer<typeof realtimeSessionTransportSchema>;
export type ModelRealtimeCapabilities = z.infer<typeof modelRealtimeCapabilitiesSchema>;
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;
export type ModelLicense = z.infer<typeof modelLicenseSchema>;
export type ModelProvenance = z.infer<typeof modelProvenanceSchema>;
export type InferenceDataPolicy = z.infer<typeof inferenceDataPolicySchema>;
export type ModelDeprecation = z.infer<typeof modelDeprecationSchema>;
export type ModelEvaluationResult = z.infer<typeof modelEvaluationResultSchema>;
export type ModelSafetyMetadata = z.infer<typeof modelSafetyMetadataSchema>;
export type CataloguePublisherSummary = z.infer<typeof cataloguePublisherSummarySchema>;
export type Voice = z.infer<typeof voiceSchema>;
export type ModelAudioCapabilities = z.infer<typeof modelAudioCapabilitiesSchema>;
export type Model = z.infer<typeof modelSchema>;
export type ModelList = z.infer<typeof modelListSchema>;
export type PowerLevelEntry = z.infer<typeof powerLevelEntrySchema>;
export type PowerLevelList = z.infer<typeof powerLevelListSchema>;
