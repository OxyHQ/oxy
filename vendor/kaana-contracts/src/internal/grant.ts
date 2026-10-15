/**
 * The grant: how Oxy decides who may spend, for every billable request Kaana
 * serves on `https://kaana.ai/v1` (Kaana ADR 0002, decisions 3 and 4).
 *
 * Kaana parses and validates the public request, then asks
 * `POST https://api.oxy.so/internal/kaana/v1/authorizations` with the caller's
 * credential VERBATIM and content-free facts — never the prompt, the audio or
 * the output. Oxy resolves the principal and lane, applies the Console policy,
 * capacity and rate limits, quotes and RESERVES with its ledger, and answers
 * with a grant signed under {@link GRANT_SIGNATURE_DOMAIN}. Kaana verifies the
 * signature, the {@link GRANT_EXECUTION_WINDOW_MS} window and `bodySha256`, and
 * executes inside the grant; without a valid grant no provider is called.
 *
 * The grant carries the funding model as it is today, field for field: it
 * invents no policy. New in contract set 4.0.0; it replaces what the v1–v4
 * envelopes signed (`authorizedRoutes`, the scoped and Private Auto bindings).
 */

import { z } from 'zod';
import { powerLevelSchema, realtimeSessionKindSchema } from '../public/catalogue.js';
import { generationRecordSchema } from '../public/generations.js';
import {
  delegatedUserIdSchema,
  generationIdSchema,
  idempotencyKeySchema,
  inferenceEnvironmentSchema,
  inferenceRegionSchema,
  inferenceTimestampSchema,
  modelIdSchema,
  modelReferenceSchema,
  modelRevisionLabelSchema,
  oxyApplicationIdSchema,
  oxyCredentialIdSchema,
  requestIdSchema,
} from '../public/identifiers.js';
import { requestLabelsSchema } from '../public/messages.js';
import { moneySchema } from '../public/money.js';
import { routingPolicyReferenceSchema } from '../public/policy.js';
import { inferenceScopeSchema } from './attribution.js';
import { inferenceEconomicTreatmentSchema } from './economics.js';
import {
  deploymentIdSchema,
  inferenceFundingTierSchema,
  inferenceProviderSlugSchema,
  oxyAccountIdSchema,
} from './identifiers.js';
import { authorizedRouteSchema } from './routing.js';

/* -------------------------------------------------------------------------- */
/*  Signing                                                                    */
/* -------------------------------------------------------------------------- */

/** The signature domain of a grant. Same Ed25519 keys as the envelope (`KAANA_EDGE_PUBLIC_KEYS`). */
export const GRANT_SIGNATURE_DOMAIN = 'oxy-kaana-grant:v1';

/** How long after `issuedAt` Kaana may START executing a grant. */
export const GRANT_EXECUTION_WINDOW_MS = 60_000;

/**
 * The bytes a signature covers, the scheme every signed Oxy↔Kaana body already
 * uses (`internal/edgeauth`): the domain, the key id, the Unix-millisecond
 * timestamp and the lowercase hex SHA-256 of the exact body bytes, joined by
 * `\n` with no trailing newline. The key id, timestamp and signature travel in
 * the `X-Oxy-Kaana-Key-Id`, `X-Oxy-Kaana-Timestamp` and `X-Oxy-Kaana-Signature`
 * headers of the response (grant) or request (settlement) that carries the body.
 */
export function signatureInput(
  domain: string,
  keyId: string,
  timestampMillis: number,
  bodySha256: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(bodySha256)) {
    throw new Error('bodySha256 must be 64 lowercase hex characters');
  }
  return [domain, keyId, String(timestampMillis), bodySha256].join('\n');
}

/** A lowercase hex SHA-256. */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters');

/* -------------------------------------------------------------------------- */
/*  The request Kaana makes                                                    */
/* -------------------------------------------------------------------------- */

/** What a request asks to do, as the authorization names it. */
export const grantOperationSchema = z.enum([
  'responses',
  'chat_completions',
  'embeddings',
  'audio_speech',
  'audio_transcriptions',
  'images_generations',
  'decisions',
  'realtime_session',
]);

/**
 * What the caller asked to be served: a model line, optionally pinned to a
 * revision, or a power level. Absent on the request means the application's
 * default from its Console policy.
 */
export const grantTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('model'),
      modelLine: modelIdSchema,
      /** Present when the caller pinned `publisher/model@revision`. */
      revision: modelRevisionLabelSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('level'), level: powerLevelSchema }).strict(),
]);

/**
 * The content-free facts Oxy sizes a hold from. Counts, never content: the
 * prompt, the audio and the output never leave Kaana.
 */
export const grantRequestFactsSchema = z
  .object({
    /** Kaana's estimate of the input, in tokens. */
    estimatedInputTokens: z.number().int().nonnegative().safe().optional(),
    maxOutputTokens: z.number().int().positive().safe().optional(),
    /** Speech: the characters to read, UTF-16 code units. */
    inputCharacters: z.number().int().nonnegative().safe().optional(),
    /**
     * Transcription: the duration of the uploaded audio, in milliseconds rounded
     * up, as Kaana read it from the file's own container (`internal/audioprobe`)
     * before asking: the WAV data chunk, the MPEG and ADTS frames, the FLAC
     * stream info, the last Ogg granule, the Matroska/WebM blocks or the MP4
     * sample tables. Never estimated from the byte count: an upload whose
     * duration Kaana cannot read (raw `audio/pcm`, a damaged or mislabelled
     * file) is refused `invalid_request` naming `file`, and no grant is asked
     * for. Settlement still charges the provider's own measurement.
     */
    audioInputMilliseconds: z.number().int().nonnegative().safe().optional(),
    /** Embeddings: how many inputs. Images: how many images. */
    embeddingInputs: z.number().int().positive().max(2048).optional(),
    images: z.number().int().positive().max(10).optional(),
    /** How many tools the request declares; their definitions stay in Kaana. */
    declaredTools: z.number().int().nonnegative().max(128),
    stream: z.boolean(),
    /** Realtime: the session kind being opened. */
    realtimeSessionKind: realtimeSessionKindSchema.optional(),
  })
  .strict();

const credentialSchema = z.string().min(1).max(8192);

/**
 * `POST /internal/kaana/v1/authorizations` for an inference request. Kaana
 * authenticates as a workload (Oxy ADR 0026); `credential` is the caller's
 * `Authorization: Bearer` value, forwarded opaque and never stored.
 */
export const inferenceAuthorizationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('inference'),
    credential: credentialSchema,
    /** Minted by Kaana on admission (`Kaana-Request-Id`). */
    requestId: requestIdSchema,
    operation: grantOperationSchema,
    target: grantTargetSchema.optional(),
    facts: grantRequestFactsSchema,
    idempotencyKey: idempotencyKeySchema.optional(),
    /** `X-Oxy-User-Id`: attribution only, honoured only with a service token. */
    onBehalfOfUserId: delegatedUserIdSchema.optional(),
    /** SHA-256 of the normalized request body; the grant is bound to it. */
    bodySha256: sha256HexSchema,
    /**
     * For an operation under a source approval (scoped execution, Private Auto,
     * the Jev classifier): `canonicalInputSha256(input)`, which Oxy compares
     * with the hash the approval fixed.
     */
    canonicalInputSha256: sha256HexSchema.optional(),
    client: z
      .object({
        /** The public path, e.g. `/v1/responses`. */
        endpoint: z.string().min(1).max(256),
        clientRequestId: z.string().min(1).max(128).optional(),
        receivedAt: inferenceTimestampSchema,
        labels: requestLabelsSchema.optional(),
      })
      .strict(),
  })
  .strict();

/**
 * Authorization to read the catalogue (`GET /v1/models`, `/v1/power-levels`):
 * no reservation, cached for 60 s per credential.
 */
export const catalogueAuthorizationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('catalogue.read'),
    credential: credentialSchema,
    requestId: requestIdSchema,
  })
  .strict();

/**
 * Authorization to read a generation record (`inference:usage:read`); Oxy
 * answers with the record itself, amount included.
 */
export const receiptAuthorizationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('receipt.read'),
    credential: credentialSchema,
    requestId: requestIdSchema,
    generationId: generationIdSchema.optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
    /** With `idempotencyKey`: the original delegated attribution, if any. */
    onBehalfOfUserId: delegatedUserIdSchema.optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if ((request.generationId === undefined) === (request.idempotencyKey === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['generationId'],
        message: 'name exactly one of generationId or idempotencyKey',
      });
    }
  });

export const authorizationRequestSchema = z.discriminatedUnion('kind', [
  inferenceAuthorizationRequestSchema,
  catalogueAuthorizationRequestSchema,
  receiptAuthorizationRequestSchema,
]);

/* -------------------------------------------------------------------------- */
/*  The grant Oxy signs                                                        */
/* -------------------------------------------------------------------------- */

/** How the caller authenticated, which decides who pays. */
export const grantLaneSchema = z.enum(['machine_credential', 'service_token', 'product_session']);

/**
 * Who pays and who called. `billingAccountId` is the owner of the
 * authenticated application, UNRESOLVED: the ledger resolves the billable
 * ancestor. The end user never pays.
 */
export const grantPrincipalSchema = z
  .object({
    billingAccountId: oxyAccountIdSchema,
    applicationId: oxyApplicationIdSchema,
    credentialId: oxyCredentialIdSchema,
    environment: inferenceEnvironmentSchema,
    scopes: z.array(inferenceScopeSchema),
    lane: grantLaneSchema,
  })
  .strict();

/** A model line Oxy admits for a step, with the price it settles at. */
export const admittedModelLineSchema = z
  .object({
    modelLine: modelIdSchema,
    priceVersionId: z.string().min(1).max(128),
  })
  .strict();

/**
 * What bounds one step: the Console policy, already applied by Oxy, as values
 * Kaana filters by. Kaana never re-derives a policy: it intersects what it can
 * serve with `admittedModelLines` and walks keys free → credit → paid within
 * `maxFundingTier`.
 */
export const grantStepLimitsSchema = z
  .object({
    /** The most one request may cost under this step. */
    maxPricePerRequest: moneySchema.optional(),
    /** The dearest funding tier Kaana may spend; absent means no ceiling. */
    maxFundingTier: inferenceFundingTierSchema.optional(),
    /** The ONLY model lines this step may serve, each with its settling price. */
    admittedModelLines: z.array(admittedModelLineSchema).min(1),
    providerAllowlist: z.array(inferenceProviderSlugSchema).default([]),
    providerDenylist: z.array(inferenceProviderSlugSchema).default([]),
    allowedRegions: z.array(inferenceRegionSchema).default([]),
    deniedRegions: z.array(inferenceRegionSchema).default([]),
    requireZeroDataRetention: z.boolean(),
    prohibitTrainingOnCustomerData: z.boolean(),
    allowedLicenseIds: z.array(z.string().min(1).max(128)).default([]),
    requireCommercialUseRights: z.boolean(),
  })
  .strict()
  .superRefine((limits, ctx) => {
    const lines = limits.admittedModelLines.map((line) => line.modelLine);
    if (new Set(lines).size !== lines.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['admittedModelLines'],
        message: 'each model line is admitted once, at one price',
      });
    }
    const denied = new Set(limits.providerDenylist);
    if (limits.providerAllowlist.some((provider) => denied.has(provider))) {
      ctx.addIssue({
        code: 'custom',
        path: ['providerAllowlist'],
        message: 'a provider cannot be both allowed and denied',
      });
    }
    const deniedRegions = new Set(limits.deniedRegions);
    if (limits.allowedRegions.some((region) => deniedRegions.has(region))) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedRegions'],
        message: 'a region cannot be both allowed and denied',
      });
    }
  });

/**
 * One step: a target and its limits. Kaana tries the steps IN ORDER and moves
 * to the next only when no admissible route of this one is left — before any
 * output, never after. Alia's Pro/Ultra lane is two steps: the level under
 * `maxFundingTier: 'credit'`, then `xhigh` on the pilot tuples.
 */
export const grantStepSchema = z
  .object({
    target: grantTargetSchema,
    limits: grantStepLimitsSchema,
  })
  .strict()
  .superRefine((step, ctx) => {
    const target = step.target;
    if (
      target.kind === 'model' &&
      !step.limits.admittedModelLines.some((line) => line.modelLine === target.modelLine)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['limits', 'admittedModelLines'],
        message: 'a step that names a model line admits it',
      });
    }
  });

/**
 * The exact route of an operation with a source approval (scoped execution,
 * Private Auto, the Mention classifier): the deployment, provider, key and
 * price the approval fixed, and the input it was approved for.
 */
export const grantExactRouteSchema = z
  .object({
    approval: z.enum(['scoped_execution', 'private_auto', 'mention_classifier']),
    deploymentId: deploymentIdSchema,
    provider: inferenceProviderSlugSchema,
    /** The provider key the approval fixed (opaque Kaana key identity). */
    keyId: z.string().min(1).max(256),
    /** Always revision-pinned. */
    modelReference: modelReferenceSchema,
    priceVersionId: z.string().min(1).max(128),
    /** `canonicalInputSha256` of the approved input. */
    inputSha256: sha256HexSchema,
  })
  .strict()
  .superRefine((route, ctx) => {
    if (!route.modelReference.includes('@')) {
      ctx.addIssue({
        code: 'custom',
        path: ['modelReference'],
        message: 'an exact route pins an immutable revision',
      });
    }
  });

/** The BYOK binding, exactly as an authorized route carries it today. */
const customerProviderCredentialBinding =
  authorizedRouteSchema.options[0].shape.customerProviderCredential;

/**
 * The signed grant: the body of a successful authorization for an inference
 * operation. Kaana verifies it and executes inside it; Oxy settles against it.
 */
export const grantSchema = z
  .object({
    schemaVersion: z.literal(1),
    grantId: z.string().min(1).max(128),
    requestId: requestIdSchema,
    operation: grantOperationSchema,
    issuedAt: inferenceTimestampSchema,
    /** Kaana must start executing by this instant: `issuedAt` + 60 s. */
    executeBy: inferenceTimestampSchema,
    /** The request body this grant authorizes; Kaana re-hashes and compares. */
    bodySha256: sha256HexSchema,
    principal: grantPrincipalSchema,
    /** Delegated or session user. Attribution only. */
    userId: delegatedUserIdSchema.optional(),
    economics: z
      .object({
        treatment: inferenceEconomicTreatmentSchema,
        policyVersion: z.string().min(1).max(128),
        relationshipId: z.string().min(1).max(128).optional(),
      })
      .strict(),
    /** The hold. Absent for `internal_metered`, which holds nothing. */
    reservation: z
      .object({
        reservationId: z.string().min(1).max(128),
        /** The most the hold covers. Shown, never spent by Kaana. */
        ceiling: moneySchema,
        /** `promotional-only` for a scoped permit. */
        fundingRestriction: z.literal('promotional-only').optional(),
      })
      .strict()
      .optional(),
    /** The capacity slot an internal relationship claimed (e.g. `alia-kaana`). */
    capacity: z
      .object({ meteredUsageId: z.string().min(1).max(128) })
      .strict()
      .optional(),
    steps: z.array(grantStepSchema).min(1).max(8),
    exactRoute: grantExactRouteSchema.optional(),
    /** BYOK: the customer's own provider key. Excludes `maxFundingTier`. */
    customerProviderCredential: customerProviderCredentialBinding,
    idempotencyKey: idempotencyKeySchema.optional(),
    client: z.object({ labels: requestLabelsSchema.optional() }).strict(),
    /** The customer's routing-policy revision, as provenance. */
    routingPolicy: routingPolicyReferenceSchema,
  })
  .strict()
  .superRefine((grant, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const issued = Date.parse(grant.issuedAt);
    const executeBy = Date.parse(grant.executeBy);
    if (executeBy <= issued || executeBy - issued > GRANT_EXECUTION_WINDOW_MS) {
      issue(['executeBy'], 'a grant is executable for at most 60 seconds after it is issued');
    }
    const metered = grant.economics.treatment === 'internal_metered';
    if (metered && grant.reservation !== undefined) {
      issue(['reservation'], 'an internally metered grant holds nothing');
    }
    if (!metered && grant.reservation === undefined) {
      issue(['reservation'], 'a charged grant carries the hold it was sized against');
    }
    const byok = grant.customerProviderCredential !== undefined;
    if (byok !== (grant.economics.treatment === 'platform_fee_only')) {
      issue(
        ['customerProviderCredential'],
        'a customer provider credential is exactly the platform-fee-only treatment',
      );
    }
    for (const [index, step] of grant.steps.entries()) {
      if (byok && step.limits.maxFundingTier !== undefined) {
        issue(
          ['steps', index, 'limits', 'maxFundingTier'],
          'a funding ceiling bounds platform keys; a customer credential is billed to the customer',
        );
      }
    }
    if (grant.exactRoute !== undefined) {
      const [step] = grant.steps;
      const route = grant.exactRoute;
      const [line, revision] = route.modelReference.split('@');
      if (
        grant.steps.length !== 1 ||
        step.target.kind !== 'model' ||
        step.target.modelLine !== line ||
        step.target.revision !== revision ||
        byok
      ) {
        issue(
          ['exactRoute'],
          'an exact route is one platform route for the one pinned model the grant serves',
        );
      }
      if (
        step !== undefined &&
        !step.limits.admittedModelLines.some(
          (admitted) =>
            admitted.modelLine === line && admitted.priceVersionId === route.priceVersionId,
        )
      ) {
        issue(['exactRoute', 'priceVersionId'], 'the exact route settles at its admitted price');
      }
    }
  });

/**
 * The answer to a catalogue authorization: what the credential may see.
 * Kaana filters `GET /v1/models` and `GET /v1/power-levels` with it.
 */
export const catalogueAccessSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('catalogue.read'),
    audience: z.enum(['public', 'platform_internal']),
    /** The power levels the credential's policy allows; empty means every level. */
    allowedLevels: z.array(powerLevelSchema).default([]),
    /** Kaana caches the answer until then, at most 60 s. */
    expiresAt: inferenceTimestampSchema,
  })
  .strict();

/** The answer to a receipt authorization: the record, amount included. */
export const receiptAccessSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('receipt.read'),
    record: generationRecordSchema,
  })
  .strict();

export type GrantOperation = z.infer<typeof grantOperationSchema>;
export type GrantTarget = z.infer<typeof grantTargetSchema>;
export type GrantRequestFacts = z.infer<typeof grantRequestFactsSchema>;
export type InferenceAuthorizationRequest = z.infer<typeof inferenceAuthorizationRequestSchema>;
export type CatalogueAuthorizationRequest = z.infer<typeof catalogueAuthorizationRequestSchema>;
export type ReceiptAuthorizationRequest = z.infer<typeof receiptAuthorizationRequestSchema>;
export type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;
export type GrantLane = z.infer<typeof grantLaneSchema>;
export type GrantPrincipal = z.infer<typeof grantPrincipalSchema>;
export type AdmittedModelLine = z.infer<typeof admittedModelLineSchema>;
export type GrantStepLimits = z.infer<typeof grantStepLimitsSchema>;
export type GrantStep = z.infer<typeof grantStepSchema>;
export type GrantExactRoute = z.infer<typeof grantExactRouteSchema>;
export type Grant = z.infer<typeof grantSchema>;
export type CatalogueAccess = z.infer<typeof catalogueAccessSchema>;
export type ReceiptAccess = z.infer<typeof receiptAccessSchema>;
