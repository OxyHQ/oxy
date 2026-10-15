/**
 * The grant: Oxy deciding who may spend on a request Kaana serves on
 * `https://kaana.ai/v1` (Kaana ADR 0002, decisions 3 and 4; phase 2).
 *
 * Kaana parses the public request, keeps its content, and asks
 * `POST /internal/kaana/v1/authorizations` with the caller's credential
 * VERBATIM and content-free facts. This module answers with a grant signed
 * Ed25519 under `oxy-kaana-grant:v1`, or a public error Kaana relays as is.
 *
 * ## The order, and what it reuses
 *
 * ```text
 * 1. the credential        authenticateInferenceBearer — the edge's two lanes, audience kaana.ai
 * 2. scope, attribution    inference:invoke; X-Oxy-User-Id as attribution only
 * 3. treatment             resolveEconomicTreatment — the same versioned policy
 * 4. the operation         facts → the units its hold is sized in; unsound facts refuse
 * 5. the policy            resolveEffectiveRoutingPolicy, pinned; allowed levels; default target
 * 6. steps                 per step, the model lines Oxy's catalogue qualifies, each at the
 *                          price version a settlement of it is billed at
 * 7. ceiling               the dearest admitted line's quote
 * 8. capacity              claimMeteredAdmission — idempotency, relationship capacity,
 *                          Console session limits
 * 9. hold                  reserve — balance, spending limits, promotional-only
 * 10. grant                built, validated by grantSchema, stored, signed
 * ```
 *
 * Nothing after step 8 runs without a durable usage row, and every refusal
 * after it releases what it took — exactly the edge's discipline.
 *
 * ## Who pays is today's matrix, unchanged
 *
 * The payer is the owner of the AUTHENTICATED application, never the end user
 * (`billing.md`); `internal_metered` is decided only by the versioned
 * relationship (`config/inferenceEconomicPolicy.ts`); BYOK is
 * `platform_fee_only`; ADR 0037's promotional lane is a `credit`-ceilinged step
 * followed by the pilot's `xhigh` step. `docs/inference/kaana-grants.md` holds
 * the matrix lane by lane.
 *
 * ## What this phase does not grant yet
 *
 *  - Source-approved operations (scoped permits, Private Auto, the Mention
 *    classifier) and `decisions`: their approvals hash the input in Oxy today
 *    and must be re-issued under `canonicalInputSha256` (ADR 0002, risk 2).
 *  - A COMMERCIAL realtime session: the authorization's facts carry no session
 *    duration, so no hold Oxy could size from them would be a bound.
 *  - The `product_session` lane: a user session needs the new public
 *    credential the ADR names, and Inbox's session check, first.
 *
 * Each is a typed refusal, never a grant on different terms.
 *
 * ## No content, ever
 *
 * Every log line names ids, codes and counts. The request this module sees is
 * already content-free; it keeps it that way.
 */

import { and, eq } from 'drizzle-orm';
import {
  type Grant,
  type GrantOperation,
  type GrantTarget,
  type InferenceAuthorizationRequest,
  GRANT_EXECUTION_WINDOW_MS,
  grantSchema,
} from '@kaana.ai/contracts/internal';
import {
  NON_RETRYABLE_PUBLIC_ERROR_CODES,
  PUBLIC_ERROR_HTTP_STATUS,
  type PublicError,
  type PublicErrorCode,
  publicErrorSchema,
} from '@kaana.ai/contracts';
import {
  effectiveSameModelDeployment,
  exactDecimalSchema,
  type PowerLevel,
  type RoutingPolicyReference,
  type RoutingTarget,
  type UsageUnit,
} from '@oxy.so/contracts';
import { uuidv7 } from '@oxy.so/db';
import { getDb } from '../config/postgres';
import type { KaanaDataPlaneConfig } from '../config/kaanaDataPlane';
import { isChargingAuthorized } from '../config/rolloutFlags';
import {
  type EconomicTreatmentDecision,
  type InternalMeteredPilot,
  type InternalMeteredPilotDeployment,
  resolveEconomicTreatment,
} from '../config/inferenceEconomicPolicy';
import { kaanaGrantAdmittedLines, kaanaGrantSteps, kaanaGrants } from '../db/schema/kaanaGrants';
import { usageReservations } from '../db/schema/usageReservations';
import { readApplicationInferenceLimits } from './applicationInferenceLimits.service';
import {
  type EdgePrincipal,
  PLATFORM_DEFAULT_AUTHORIZES_SAME_MODEL_FAILOVER,
  PLATFORM_DEFAULT_ROUTING_POLICY,
  PLATFORM_INTERNAL_DEFAULT_OPTIMISE_FOR,
  PLATFORM_INTERNAL_DEFAULT_ROUTING_POLICY,
  RESERVATION_TTL_SECONDS,
  ceilingQuoteScenarios,
  compareQualifiedRoutes,
  modelLineOf,
  quoteRouteCeiling,
  reservationOrRefusal,
  type RouteCeilingPlan,
  viewerForPrincipal,
} from './inferenceEdge.service';
import {
  type EdgeCapacityRequirement,
  type EdgeModalityRequirement,
  type EdgeRoute,
  TEXT_COMPLETION_MODALITY,
  UNCONSTRAINED_ROUTING,
  exceedsAmount,
  powerLevelCandidates,
  resolveEdgeRoute,
  resolveRoutingProfileForEdgeById,
  routingConstraintsOf,
} from './inferenceCatalogue.service';
import {
  publishedUnitPrice,
  reserve,
  settle,
  type LedgerAttribution,
} from './inferenceLedger.service';
import {
  claimMeteredAdmission,
  markMeteredAdmissionRefused,
  REALTIME_SESSION_ENDPOINT,
} from './inferenceMeteredUsage.service';
import {
  AUTO_POWER_LEVELS,
  type ConcretePowerLevel,
  powerLevelProfileIds,
} from './inferencePowerLevels.service';
import { resolveEffectiveRoutingPolicy } from './inferenceRoutingPolicy.service';
import {
  currentDeploymentLiveness,
  isDeploymentPublished,
} from './kaanaDeploymentPublication.service';
import { sha256Hex, signGrantBody, type SignedHeaders } from './kaanaGrantSigning';
import { logger } from '../utils/logger';

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export type GrantDecision =
  | {
      readonly status: 'granted';
      readonly grant: Grant;
      /** The exact bytes signed; the route sends these and nothing else. */
      readonly body: Buffer;
      readonly headers: SignedHeaders;
    }
  | { readonly status: 'refused'; readonly httpStatus: number; readonly error: PublicError };

type UnresolvedRoute = Exclude<
  Awaited<ReturnType<typeof resolveEdgeRoute>>,
  { readonly status: 'resolved' }
>;

export interface AuthorizeInferenceInput {
  readonly request: InferenceAuthorizationRequest;
  readonly principal: EdgePrincipal;
  /** The Oxy edge key; absent when this deployment has no Kaana binding. */
  readonly signing: Pick<KaanaDataPlaneConfig, 'keyId' | 'privateKey'> | undefined;
  readonly now?: () => number;
}

/**
 * How long a realtime grant's usage row (and so its session slot) stands if no
 * settlement closes it: the longest session the old edge ever signed (one
 * hour) plus the reservation window. A settlement at close releases it at once.
 */
export const REALTIME_GRANT_SLOT_SECONDS = 3_600 + RESERVATION_TTL_SECONDS;

/** The public path each operation's usage is recorded under, never Kaana's string. */
export const GRANT_ENDPOINTS: Readonly<Record<GrantOperation, string>> = {
  responses: '/v1/responses',
  chat_completions: '/v1/chat/completions',
  embeddings: '/v1/embeddings',
  audio_speech: '/v1/audio/speech',
  audio_transcriptions: '/v1/audio/transcriptions',
  images_generations: '/v1/images/generations',
  decisions: '/v1/decisions',
  realtime_session: REALTIME_SESSION_ENDPOINT,
};

/** One minute, in every duration unit a realtime session's own model can be billed in. */
const REALTIME_MINUTE_UNITS: Partial<Record<UsageUnit, number>> = {
  audio_input_milliseconds: 60_000,
  audio_output_milliseconds: 60_000,
  session_milliseconds: 60_000,
};

/**
 * The same minute with its input transcribed by the deployment's own ASR model,
 * billed apart (`input_transcription_milliseconds`, `@kaana.ai/contracts`
 * 4.1.0): at most every millisecond of input audio, so 60 000 a minute.
 */
const REALTIME_TRANSCRIBED_MINUTE_UNITS: Partial<Record<UsageUnit, number>> = {
  ...REALTIME_MINUTE_UNITS,
  input_transcription_milliseconds: 60_000,
};

/** Per-message framing tokens, as the edge counts them (`MESSAGE_TOKEN_OVERHEAD`). */
const SPEECH_FRAMING_TOKENS = 8;

/* -------------------------------------------------------------------------- */
/*  Refusals                                                                   */
/* -------------------------------------------------------------------------- */

const NON_RETRYABLE: ReadonlySet<string> = new Set(NON_RETRYABLE_PUBLIC_ERROR_CODES);

class GrantRefusal extends Error {
  constructor(
    readonly code: PublicErrorCode,
    message: string,
    readonly options: { readonly param?: string; readonly reason?: string } = {},
  ) {
    super(message);
  }
}

function refusal(
  request: InferenceAuthorizationRequest,
  principal: EdgePrincipal | undefined,
  error: GrantRefusal,
): GrantDecision {
  logger.warn('inference.grant.refused', {
    requestId: request.requestId,
    code: error.code,
    operation: request.operation,
    ...(principal === undefined
      ? {}
      : {
          applicationId: principal.applicationId,
          credentialId: principal.credentialId,
          lane: principal.lane,
        }),
    ...(error.options.reason === undefined ? {} : { reason: error.options.reason }),
  });
  return {
    status: 'refused',
    httpStatus: PUBLIC_ERROR_HTTP_STATUS[error.code],
    error: publicError(request.requestId, error.code, error.message, error.options.param),
  };
}

/** A public error, retryable exactly when the public vocabulary says it can be. */
export function publicError(
  requestId: string,
  code: PublicErrorCode,
  message: string,
  param?: string,
  retryAfterMs?: number,
): PublicError {
  const retryable = !NON_RETRYABLE.has(code);
  return publicErrorSchema.parse({
    schemaVersion: 1,
    code,
    message,
    retryable,
    requestId,
    ...(param === undefined ? {} : { param }),
    ...(retryable && retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

/* -------------------------------------------------------------------------- */
/*  The operation                                                              */
/* -------------------------------------------------------------------------- */

/** What an operation needs of a route, and the units its hold is sized in. */
interface OperationPlan {
  readonly family: 'completion' | 'embeddings' | 'speech' | 'transcription' | 'images' | 'realtime';
  readonly modality: EdgeModalityRequirement;
  readonly capacity: EdgeCapacityRequirement;
  /** Token units Oxy reserves as known (`reserve`'s `knownUnits`). */
  readonly knownUnits: Partial<Record<UsageUnit, number>>;
  /** The caller's own output limit, when it named one; Kaana executes the bound body. */
  readonly maxOutputTokens: number | undefined;
  /**
   * The ceiling plans of one route, in order: the first whose every scenario
   * quotes is the route's ceiling (`quoteRouteCeiling`). One plan for every
   * operation but a realtime session.
   */
  plans(route: EdgeRoute): readonly RouteCeilingPlan[];
}

function requireFact(value: number | undefined, param: string): number {
  if (value === undefined) {
    throw new GrantRefusal('invalid_request', `The authorization lacks facts.${param}.`, {
      param: `facts.${param}`,
      reason: `missing-fact:${param}`,
    });
  }
  return value;
}

/** The output budget a completion route is held at: the caller's, or the most the route can write. */
function completionOutputBudget(
  route: Pick<EdgeRoute, 'maxOutputTokens' | 'maxContextTokens'>,
  inputTokens: number,
  requested: number | undefined,
): number {
  return (
    requested ?? Math.max(0, Math.min(route.maxOutputTokens, route.maxContextTokens - inputTokens))
  );
}

function planOperation(request: InferenceAuthorizationRequest): OperationPlan {
  const { facts } = request;
  switch (request.operation) {
    case 'responses':
    case 'chat_completions': {
      const input = requireFact(facts.estimatedInputTokens, 'estimatedInputTokens');
      const requested = facts.maxOutputTokens;
      return {
        family: 'completion',
        modality: { ...TEXT_COMPLETION_MODALITY, apiFormat: request.operation },
        capacity: { inputTokens: input, outputTokens: requested ?? 'model-maximum' },
        knownUnits: { input_tokens: input },
        maxOutputTokens: requested,
        plans: (route) => [
          {
            metering: 'tokens',
            scenarios: ceilingQuoteScenarios(
              { kind: 'completion' },
              input,
              completionOutputBudget(route, input, requested),
            ),
          },
        ],
      };
    }
    case 'embeddings': {
      const input = requireFact(facts.estimatedInputTokens, 'estimatedInputTokens');
      const embeddings = requireFact(facts.embeddingInputs, 'embeddingInputs');
      return {
        family: 'embeddings',
        modality: { input: 'text', output: 'embedding', apiFormat: 'embeddings' },
        capacity: { inputTokens: input, outputTokens: 0 },
        knownUnits: { input_tokens: input },
        maxOutputTokens: undefined,
        plans: () => [
          {
            metering: 'tokens',
            scenarios: ceilingQuoteScenarios({ kind: 'embeddings', embeddings }, input, 0),
          },
        ],
      };
    }
    case 'audio_speech': {
      const characters = requireFact(facts.inputCharacters, 'inputCharacters');
      return {
        family: 'speech',
        modality: { input: 'text', output: 'audio', apiFormat: 'audio_speech' },
        capacity: { inputTokens: characters + SPEECH_FRAMING_TOKENS, outputTokens: 0 },
        knownUnits: { characters },
        maxOutputTokens: undefined,
        plans: () => [
          {
            metering: 'tokens',
            scenarios: ceilingQuoteScenarios({ kind: 'speech', characters }, 0, 0),
          },
        ],
      };
    }
    case 'audio_transcriptions': {
      const milliseconds = requireFact(facts.audioInputMilliseconds, 'audioInputMilliseconds');
      return {
        family: 'transcription',
        modality: {
          input: 'audio',
          output: 'text',
          apiFormat: 'audio_transcriptions',
          requiresDeclaredApiFormat: true,
        },
        capacity: { inputTokens: 0, outputTokens: 0 },
        knownUnits: { audio_input_milliseconds: milliseconds },
        maxOutputTokens: undefined,
        // The hold is the measured duration Kaana read from the upload
        // (`facts.audioInputMilliseconds`), exactly; the transcript's text is
        // free on every route this admits (see `admitLine`).
        plans: () => [
          {
            metering: 'duration',
            scenarios: [{ requests: 1, audio_input_milliseconds: milliseconds }],
          },
        ],
      };
    }
    case 'images_generations': {
      const input = requireFact(facts.estimatedInputTokens, 'estimatedInputTokens');
      const images = requireFact(facts.images, 'images');
      return {
        family: 'images',
        modality: { input: 'text', output: 'image', apiFormat: 'images_generations' },
        capacity: { inputTokens: input, outputTokens: 0 },
        knownUnits: { input_tokens: input },
        maxOutputTokens: undefined,
        plans: () => [
          {
            metering: 'tokens',
            scenarios: ceilingQuoteScenarios({ kind: 'images', images }, input, 0),
          },
        ],
      };
    }
    case 'realtime_session': {
      const kind = facts.realtimeSessionKind;
      if (kind === undefined) {
        throw new GrantRefusal(
          'invalid_request',
          'The authorization lacks facts.realtimeSessionKind.',
          {
            param: 'facts.realtimeSessionKind',
            reason: 'missing-fact:realtimeSessionKind',
          },
        );
      }
      return {
        family: 'realtime',
        modality: {
          input: 'audio',
          output: kind === 'transcription' ? 'text' : 'audio',
          realtime: { kind, transport: 'websocket' },
        },
        capacity: { inputTokens: facts.estimatedInputTokens ?? 0, outputTokens: 0 },
        knownUnits: {},
        maxOutputTokens: undefined,
        // A per-minute figure: what a minute of this line costs, at most. It
        // qualifies a line under the pilot's per-minute ceiling; no hold is
        // sized from it (an internal session holds nothing, and a commercial one
        // is refused before this is read). A line that prices input
        // transcription apart is quoted WITH it (Alia's calls transcribe their
        // input); one whose session price includes it (xAI) is quoted without.
        plans: () => [
          { metering: 'duration', scenarios: [REALTIME_TRANSCRIBED_MINUTE_UNITS] },
          { metering: 'duration', scenarios: [REALTIME_MINUTE_UNITS] },
        ],
      };
    }
    case 'decisions':
      // Refused before planning; kept total so a new operation fails `tsc` here.
      throw new GrantRefusal('service_unavailable', 'Decisions are not granted yet.', {
        reason: 'decisions-not-granted',
      });
  }
}

/* -------------------------------------------------------------------------- */
/*  The pilot, per operation                                                    */
/* -------------------------------------------------------------------------- */

/** An internal relationship's terms for one operation; `undefined` is outside it. */
interface GrantPilotTerms {
  /** Tokens, characters or milliseconds, in the unit the operation is measured in. */
  readonly maxInput: number | undefined;
  readonly maxOutputTokens: number | undefined;
  readonly maxPriceUsd: string;
  /** Exact routes; `undefined` admits by price alone (realtime, transcription). */
  readonly deployments: readonly InternalMeteredPilotDeployment[] | undefined;
}

function grantPilotTerms(
  pilot: InternalMeteredPilot,
  plan: OperationPlan,
  request: InferenceAuthorizationRequest,
): GrantPilotTerms | undefined {
  switch (plan.family) {
    case 'completion':
      return pilot.maxPricePerRequestUsd === undefined
        ? undefined
        : {
            maxInput: pilot.maxControlledCompletionInputBudget ?? pilot.maxControlledInputBudget,
            maxOutputTokens: pilot.maxOutputTokens,
            maxPriceUsd: pilot.maxPricePerRequestUsd,
            deployments: pilot.deployments,
          };
    case 'speech':
      return pilot.speech === undefined
        ? undefined
        : {
            maxInput: pilot.speech.maxInputCharacters,
            maxOutputTokens: undefined,
            maxPriceUsd: pilot.speech.maxPricePerRequestUsd,
            deployments: pilot.speech.deployments,
          };
    case 'transcription':
      return pilot.transcription === undefined
        ? undefined
        : {
            maxInput: pilot.transcription.maxInputAudioMilliseconds,
            maxOutputTokens: undefined,
            maxPriceUsd: pilot.transcription.maxPricePerRequestUsd,
            deployments: undefined,
          };
    case 'realtime': {
      const kind = request.facts.realtimeSessionKind;
      return pilot.realtime === undefined ||
        kind === undefined ||
        !pilot.realtime.sessionKinds.includes(kind)
        ? undefined
        : {
            maxInput: undefined,
            maxOutputTokens: undefined,
            maxPriceUsd: pilot.realtime.maxPricePerMinuteUsd,
            deployments: undefined,
          };
    }
    case 'embeddings':
    case 'images':
      return undefined;
  }
}

/** The figure a pilot's input ceiling is compared with, in the operation's own unit. */
function pilotInputFigure(plan: OperationPlan, request: InferenceAuthorizationRequest): number {
  switch (plan.family) {
    case 'speech':
      return request.facts.inputCharacters ?? 0;
    case 'transcription':
      return request.facts.audioInputMilliseconds ?? 0;
    default:
      return request.facts.estimatedInputTokens ?? 0;
  }
}

/* -------------------------------------------------------------------------- */
/*  Steps                                                                      */
/* -------------------------------------------------------------------------- */

/** One step as Oxy computes it, before it is written into the grant. */
interface StepPlan {
  readonly target: GrantTarget;
  /** Model references to resolve (`publisher/model`, `@revision` when pinned). */
  readonly candidates: readonly string[];
  readonly maxPrice: { readonly amount: string; readonly currency: string } | undefined;
  readonly maxFundingTier: 'credit' | undefined;
  /** Exact pilot routes this step is limited to; `undefined` for none. */
  readonly pilotDeployments: readonly InternalMeteredPilotDeployment[] | undefined;
  /** Same-model failover off: the step is served on its best provider only. */
  readonly singleProvider: boolean;
}

/** An admitted line: its best route (for the usage row) and the price it settles at. */
interface AdmittedLine {
  readonly modelLine: string;
  readonly priceVersionId: string;
  readonly quote: { readonly amount: string; readonly currency: string };
  readonly bestRoute: EdgeRoute;
  readonly providers: readonly string[];
}

interface ResolvedStep {
  readonly plan: StepPlan;
  readonly lines: readonly AdmittedLine[];
  readonly providers: readonly string[];
}

function usd(amount: string): { amount: string; currency: 'USD' } {
  return { amount: exactDecimalSchema.parse(amount), currency: 'USD' };
}

/** The tighter of two USD-or-policy price ceilings; a currency mismatch refuses. */
function tighterPrice(
  policy: { readonly amount: string; readonly currency: string } | undefined,
  pilotUsd: string | undefined,
): { readonly amount: string; readonly currency: string } | undefined {
  if (pilotUsd === undefined) return policy;
  const pilot = usd(pilotUsd);
  if (policy === undefined) return pilot;
  if (policy.currency !== 'USD') {
    throw new GrantRefusal('policy_violation', 'The internal pilot quote ceiling requires USD.', {
      reason: 'pilot-currency',
    });
  }
  return exceedsAmount(policy.amount, pilot.amount) ? pilot : policy;
}

/* -------------------------------------------------------------------------- */
/*  authorizeInference                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Authorize one inference request for Kaana: a signed grant, or the public
 * error Kaana relays. Never throws for a request-level refusal.
 */
export async function authorizeInference(input: AuthorizeInferenceInput): Promise<GrantDecision> {
  const { request, principal } = input;
  try {
    return await authorize(input);
  } catch (error) {
    if (error instanceof GrantRefusal) return refusal(request, principal, error);
    throw error;
  }
}

async function authorize(input: AuthorizeInferenceInput): Promise<GrantDecision> {
  const { request, principal, signing } = input;
  const now = input.now ?? Date.now;

  if (signing === undefined) {
    throw new GrantRefusal('service_unavailable', 'Inference grants are not configured here.', {
      reason: 'grant-signing-not-configured',
    });
  }
  if (!principal.scopes.includes('inference:invoke')) {
    throw new GrantRefusal(
      'insufficient_scope',
      'This credential does not hold the inference:invoke scope.',
    );
  }
  if (request.operation === 'decisions' || request.canonicalInputSha256 !== undefined) {
    throw new GrantRefusal(
      'service_unavailable',
      'Source-approved operations are not granted until their approvals are re-issued under the canonical input hash.',
      { reason: 'source-approval-not-granted' },
    );
  }

  const economics = resolveEconomicTreatment(principal);
  const plan = planOperation(request);

  // ---- The internal relationship's terms for this operation ---------------
  const pilot =
    economics.treatment === 'internal_metered' ? economics.relationship.pilot : undefined;
  const pilotTerms = pilot === undefined ? undefined : grantPilotTerms(pilot, plan, request);
  if (pilot !== undefined) {
    if (pilotTerms === undefined) {
      throw new GrantRefusal(
        'unsupported_modality',
        'The operation is outside the controlled internal pilot.',
        {
          reason: 'pilot-operation',
        },
      );
    }
    if (
      pilotTerms.maxInput !== undefined &&
      pilotInputFigure(plan, request) > pilotTerms.maxInput
    ) {
      throw new GrantRefusal(
        'context_length_exceeded',
        'The input exceeds the internal pilot budget.',
        {
          param: 'input',
          reason: 'pilot-input',
        },
      );
    }
    // The grant carries no output limit of its own: Kaana executes the body
    // bound by `bodySha256`, so the pilot needs the caller's limit IN it.
    if (pilotTerms.maxOutputTokens !== undefined) {
      if (plan.maxOutputTokens === undefined || plan.maxOutputTokens > pilotTerms.maxOutputTokens) {
        throw new GrantRefusal(
          'output_limit_exceeded',
          `The internal pilot requires an output limit of at most ${pilotTerms.maxOutputTokens} tokens.`,
          { param: 'max_output_tokens', reason: 'pilot-output' },
        );
      }
    }
  }
  if (plan.family === 'realtime' && economics.treatment !== 'internal_metered') {
    throw new GrantRefusal(
      'unsupported_modality',
      'Realtime sessions are not yet billable through a grant: its facts carry no session ceiling.',
      { reason: 'realtime-commercial-ceiling' },
    );
  }
  if (economics.treatment === 'commercial' && !isChargingAuthorized()) {
    throw new GrantRefusal(
      'service_unavailable',
      'Charged inference is not authorized on this deployment.',
      {
        reason: 'charging-not-authorized',
      },
    );
  }

  // ---- The policy, pinned ---------------------------------------------------
  const policy = await resolveEffectiveRoutingPolicy(principal.applicationId);
  const viewer = viewerForPrincipal(principal);
  const internalDefault =
    policy.status !== 'resolved' && viewer.scopes.includes('platform_internal');
  const routingPolicy: RoutingPolicyReference =
    policy.status === 'resolved'
      ? {
          routingPolicyId: policy.stored.policy.routingPolicyId,
          policyVersion: policy.stored.policy.policyVersion,
        }
      : internalDefault
        ? PLATFORM_INTERNAL_DEFAULT_ROUTING_POLICY
        : PLATFORM_DEFAULT_ROUTING_POLICY;
  const routingPolicyVersionId = policy.status === 'resolved' ? policy.stored.versionId : undefined;
  const constraints =
    policy.status === 'resolved'
      ? routingConstraintsOf(policy.stored.policy)
      : UNCONSTRAINED_ROUTING;
  const levelProfileIds = await powerLevelProfileIds();
  const allowedProfileIds =
    policy.status === 'resolved' ? policy.stored.policy.allowedRoutingProfileIds : [];
  const levelAllowed = (level: PowerLevel): boolean => {
    const id = levelProfileIds.get(level);
    return id !== undefined && (allowedProfileIds.length === 0 || allowedProfileIds.includes(id));
  };

  const target = await grantTargetOf(
    request,
    policy.status === 'resolved' ? policy.stored.policy.defaultTarget : undefined,
    levelProfileIds,
  );
  if (plan.family === 'realtime' && target.kind !== 'model') {
    throw new GrantRefusal(
      'invalid_request',
      'A realtime session names a model, never a power level.',
      {
        param: 'model',
      },
    );
  }
  if (target.kind === 'level' && !levelAllowed(target.level)) {
    throw new GrantRefusal(
      'policy_violation',
      `This application’s routing policy does not allow the power level "${target.level}".`,
      { param: 'model', reason: 'policy_excluded:allowedRoutingProfileIds' },
    );
  }

  // ---- Steps ---------------------------------------------------------------
  const policyPrice = constraints.maxPricePerRequest;
  const stepPlans: StepPlan[] = [];
  if (target.kind === 'model') {
    const reference =
      target.revision === undefined ? target.modelLine : `${target.modelLine}@${target.revision}`;
    const sameModelFailover =
      policy.status === 'resolved'
        ? effectiveSameModelDeployment(policy.stored.policy.fallback)
        : PLATFORM_DEFAULT_AUTHORIZES_SAME_MODEL_FAILOVER;
    const step = {
      maxPrice: tighterPrice(policyPrice, pilotTerms?.maxPriceUsd),
      maxFundingTier: undefined,
      pilotDeployments: pilotTerms?.deployments,
      singleProvider: !sameModelFailover,
    } as const;
    stepPlans.push({ ...step, target, candidates: [reference] });
    const crossModel =
      plan.family !== 'realtime' &&
      target.revision === undefined &&
      policy.status === 'resolved' &&
      !policy.stored.policy.fallback.disabled
        ? policy.stored.policy.fallback.authorizedCrossModel
        : [];
    for (const fallback of crossModel.slice(0, 7)) {
      const [line, revision] = fallback.split('@');
      stepPlans.push({
        ...step,
        target: {
          kind: 'model',
          modelLine: line ?? fallback,
          ...(revision === undefined ? {} : { revision }),
        },
        candidates: [fallback],
      });
    }
  } else {
    stepPlans.push(
      ...(await levelStepPlans(
        target.level,
        plan,
        pilot,
        pilotTerms,
        policyPrice,
        levelAllowed,
        viewer,
      )),
    );
  }

  const optimiseFor = await optimiseForTarget(target, policy, internalDefault, levelProfileIds);
  const routingContext = {
    applicationId: principal.applicationId,
    environment: principal.environment,
  };
  const liveness = await currentDeploymentLiveness();
  if (liveness.status === 'unavailable') {
    throw new GrantRefusal(
      'service_unavailable',
      'The inference routing evidence is temporarily unavailable.',
      {
        reason: 'routing_evidence:kaana-publication-unavailable',
      },
    );
  }

  const resolvedSteps: ResolvedStep[] = [];
  let sawPriceExclusion = false;
  /** The first step's own failure, when it names one model: what the caller asked for. */
  let primaryFailure: UnresolvedRoute | undefined;
  for (const stepPlan of stepPlans) {
    const lines: AdmittedLine[] = [];
    for (const candidate of stepPlan.candidates) {
      const resolution = await resolveEdgeRoute(
        viewer,
        candidate,
        constraints,
        plan.modality,
        optimiseFor,
        plan.capacity,
        routingContext,
      );
      if (resolution.status !== 'resolved') {
        if (stepPlan === stepPlans[0] && target.kind === 'model') primaryFailure ??= resolution;
        continue;
      }
      const routes = [resolution.route, ...resolution.alternates]
        .filter((route) => isDeploymentPublished(liveness, route.deploymentId))
        .filter(
          (route) =>
            stepPlan.pilotDeployments === undefined ||
            stepPlan.pilotDeployments.some(
              (allowed) =>
                allowed.deploymentId === route.deploymentId &&
                allowed.modelReference === route.modelReference &&
                allowed.provider === route.provider,
            ),
        )
        .sort((left, right) =>
          compareQualifiedRoutes(left, right, constraints.byokPreference === 'prefer'),
        );
      const admitted = await admitLine(routes, plan, stepPlan);
      if (admitted === 'over-price') sawPriceExclusion = true;
      else if (admitted !== undefined) lines.push(admitted);
    }
    if (lines.length > 0) {
      const providers = [...new Set(lines.flatMap((line) => line.providers))].sort();
      resolvedSteps.push({ plan: stepPlan, lines, providers });
    }
  }

  if (resolvedSteps.length === 0) {
    if (sawPriceExclusion) {
      throw new GrantRefusal(
        'policy_violation',
        'Every route for this request is excluded by this application’s routing policy: maxPricePerRequest.',
        { reason: 'policy_excluded:maxPricePerRequest' },
      );
    }
    if (primaryFailure !== undefined && target.kind === 'model') {
      throw refusalForResolution(primaryFailure, target);
    }
    throw new GrantRefusal('no_route_available', 'No route is currently available.', {
      reason: 'no_admissible_line',
    });
  }

  // ---- BYOK: the customer's own key, as the edge's ranking would pick it ----
  const primary = resolvedSteps[0]?.lines[0]?.bestRoute;
  if (primary === undefined) {
    throw new GrantRefusal('no_route_available', 'No route is currently available.');
  }
  const byok = primary.customerProviderCredential;
  const treatment: Grant['economics']['treatment'] =
    byok !== undefined ? 'platform_fee_only' : economics.treatment;
  if (byok !== undefined && economics.treatment === 'internal_metered') {
    throw new GrantRefusal(
      'policy_violation',
      'An internal relationship is not served on a customer key.',
      {
        reason: 'internal-byok',
      },
    );
  }
  const steps = byok === undefined ? resolvedSteps : byokSteps(resolvedSteps, primary);
  if (steps.length === 0) {
    throw new GrantRefusal('no_route_available', 'No route is currently available.', {
      reason: 'byok-no-line',
    });
  }

  // ---- The ceiling: the dearest admitted line ---------------------------
  let ceilingLine: AdmittedLine | undefined;
  for (const line of steps.flatMap((step) => step.lines)) {
    if (ceilingLine !== undefined && line.quote.currency !== ceilingLine.quote.currency) {
      throw new GrantRefusal(
        'service_unavailable',
        'The inference routing evidence is temporarily unavailable.',
        {
          reason: 'routing_evidence:price-currency-mismatch',
        },
      );
    }
    if (ceilingLine === undefined || exceedsAmount(line.quote.amount, ceilingLine.quote.amount))
      ceilingLine = line;
  }
  if (ceilingLine === undefined)
    throw new GrantRefusal('no_route_available', 'No route is currently available.');
  // A realtime session's line quote is per MINUTE: it qualified the line, it is not a ceiling.
  const ceiling = plan.family === 'realtime' ? undefined : ceilingLine.quote;

  // ---- Idempotency, capacity, the usage row --------------------------------
  const ledgerKey =
    request.idempotencyKey === undefined
      ? `kaana-grant:req:${request.requestId}`
      : `oxy-edge:idem:${principal.credentialId}:${request.idempotencyKey}`;
  if (request.idempotencyKey !== undefined && (await reservationExists(ledgerKey))) {
    throw idempotencyConflict();
  }

  const limits = await readApplicationInferenceLimits(principal.applicationId);
  const claimEconomics = withConsoleCapacity(economics, limits);
  const endpoint = GRANT_ENDPOINTS[request.operation];
  const delegatedUserId = request.onBehalfOfUserId;
  const expiresInSeconds =
    plan.family === 'realtime' ? REALTIME_GRANT_SLOT_SECONDS : RESERVATION_TTL_SECONDS;
  const requestedReference =
    target.kind === 'model'
      ? target.revision === undefined
        ? target.modelLine
        : `${target.modelLine}@${target.revision}`
      : target.level;
  const claim = await claimMeteredAdmission({
    requestId: request.requestId,
    idempotencyKey: ledgerKey,
    economics: claimEconomics,
    accountId: principal.ownerAccountId,
    applicationId: principal.applicationId,
    applicationCredentialId: principal.credentialId,
    ...(delegatedUserId === undefined ? {} : { delegatedUserId }),
    environment: principal.environment,
    endpoint,
    requestedModelReference: requestedReference,
    admittedModelReference: primary.modelReference,
    admittedProvider: primary.provider,
    admittedDeploymentId: primary.deploymentId,
    routingPolicyVersionId,
    ceiling,
    expiresInSeconds,
    ...(plan.family === 'realtime'
      ? {
          realtimeSessionLimits: {
            perApplication: limits.maxConcurrentRealtimeSessions,
            perCredential: limits.maxConcurrentRealtimeSessionsPerCredential,
          },
        }
      : {}),
  });
  switch (claim.status) {
    case 'claimed':
      break;
    case 'duplicate':
      throw idempotencyConflict();
    case 'parent-unavailable':
      throw new GrantRefusal('policy_violation', 'The request has no parent admission.');
    case 'sessions-exceeded':
      throw new GrantRefusal(
        'rate_limited',
        claim.scope === 'application'
          ? 'This application has reached its concurrent realtime sessions.'
          : 'This credential has reached its concurrent realtime sessions.',
        { reason: `realtime-sessions-${claim.scope}` },
      );
    case 'capacity-exceeded':
      throw claim.limit === 'concurrency'
        ? new GrantRefusal(
            'rate_limited',
            'This application has reached its concurrent inference capacity. Try again shortly.',
            { reason: 'internal-capacity-concurrency' },
          )
        : new GrantRefusal(
            'quota_exceeded',
            'This application has reached its daily inference capacity.',
            {
              reason: 'internal-capacity-daily',
            },
          );
  }
  const meteredUsageId = claim.meteredUsageId;

  // ---- The hold -------------------------------------------------------------
  const attribution: LedgerAttribution = {
    accountId: principal.ownerAccountId,
    applicationId: principal.applicationId,
    applicationCredentialId: principal.credentialId,
    ...(delegatedUserId === undefined ? {} : { delegatedUserId }),
    requestId: request.requestId,
    environment: principal.environment,
  };
  let reservationId: string | undefined;
  if (treatment !== 'internal_metered') {
    if (ceiling === undefined) {
      await markMeteredAdmissionRefused(meteredUsageId);
      throw new GrantRefusal('no_route_available', 'No route is currently available.', {
        reason: 'no-ceiling',
      });
    }
    const reservation = await reserve({
      idempotencyKey: ledgerKey,
      attribution,
      knownUnits: plan.knownUnits,
      ...(plan.maxOutputTokens === undefined || plan.maxOutputTokens <= 0
        ? {}
        : { maxOutputTokens: plan.maxOutputTokens }),
      ceilingPriceVersionId: ceilingLine.priceVersionId,
      maxAmount: ceiling.amount,
      currency: ceiling.currency,
      expiresInSeconds: RESERVATION_TTL_SECONDS,
    });
    const held = reservationOrRefusal(reservation, request.requestId, ceiling.currency);
    if ('error' in held) {
      await markMeteredAdmissionRefused(meteredUsageId);
      logger.warn('inference.grant.reservation_refused', {
        requestId: request.requestId,
        accountId: principal.ownerAccountId,
        applicationId: principal.applicationId,
        reservationStatus: reservation.status,
      });
      throw new GrantRefusal(held.error.code as PublicErrorCode, held.error.message, {
        ...(held.error.param === undefined ? {} : { param: held.error.param }),
        reason: `reservation:${reservation.status}`,
      });
    }
    reservationId = held.reservation.reservationId;
  }

  // ---- The grant ------------------------------------------------------------
  const issuedAtMs = now();
  const grantId = uuidv7();
  // Typed by the parse below, which is the contract's own check: brands and
  // refinements (window, treatment, BYOK) are applied there, not asserted here.
  const grantInput = {
    schemaVersion: 1,
    grantId,
    requestId: request.requestId,
    operation: request.operation,
    issuedAt: new Date(issuedAtMs).toISOString(),
    executeBy: new Date(issuedAtMs + GRANT_EXECUTION_WINDOW_MS).toISOString(),
    bodySha256: request.bodySha256,
    principal: {
      billingAccountId: principal.ownerAccountId,
      applicationId: principal.applicationId,
      credentialId: principal.credentialId,
      environment: principal.environment,
      scopes: principal.scopes.filter(isInferenceScope),
      lane: principal.lane,
    },
    ...(delegatedUserId === undefined ? {} : { userId: delegatedUserId }),
    economics: {
      treatment,
      policyVersion: economics.policyVersion,
      ...(economics.treatment === 'internal_metered'
        ? { relationshipId: economics.relationship.relationshipId }
        : {}),
    },
    ...(reservationId === undefined || ceiling === undefined
      ? {}
      : {
          reservation: {
            reservationId,
            ceiling: { amount: ceiling.amount, currency: ceiling.currency },
          },
        }),
    ...(economics.treatment === 'internal_metered' ? { capacity: { meteredUsageId } } : {}),
    steps: steps.map((step) => grantStepOf(step, constraints, byok !== undefined)),
    ...(byok === undefined ? {} : { customerProviderCredential: byok }),
    ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
    client: request.client.labels === undefined ? {} : { labels: request.client.labels },
    routingPolicy,
  };

  let grant: Grant;
  let body: Buffer;
  try {
    grant = grantSchema.parse(grantInput);
    body = Buffer.from(JSON.stringify(grant), 'utf8');
    await recordGrant({
      grant,
      body,
      signingKeyId: signing.keyId,
      endpoint,
      meteredUsageId,
      reservationId,
      ceiling,
      routingPolicyVersionId,
      relationshipId:
        economics.treatment === 'internal_metered'
          ? economics.relationship.relationshipId
          : undefined,
      expiresAt: new Date(issuedAtMs + expiresInSeconds * 1000),
      steps,
    });
  } catch (error) {
    // Nothing was signed: give back the slot and the hold before answering.
    await releaseUnsignedGrant(meteredUsageId, reservationId, ledgerKey, attribution, ceilingLine);
    logger.error(
      'inference.grant.record_failed',
      error instanceof Error ? error : new Error(String(error)),
      {
        requestId: request.requestId,
      },
    );
    throw new GrantRefusal('internal_error', 'The grant could not be recorded.', {
      reason: 'grant-record-failed',
    });
  }

  logger.info('inference.grant.issued', {
    requestId: request.requestId,
    grantId,
    operation: request.operation,
    applicationId: principal.applicationId,
    lane: principal.lane,
    treatment,
    steps: grant.steps.length,
    lines: steps.reduce((total, step) => total + step.lines.length, 0),
  });
  return { status: 'granted', grant, body, headers: signGrantBody(signing, body, issuedAtMs) };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** The caller-facing reason a named model has no route, as the edge words it. */
function refusalForResolution(
  resolution: UnresolvedRoute,
  target: Extract<GrantTarget, { kind: 'model' }>,
): GrantRefusal {
  const name =
    target.revision === undefined ? target.modelLine : `${target.modelLine}@${target.revision}`;
  switch (resolution.status) {
    case 'unknown-model':
      return new GrantRefusal('model_not_found', `No model ${name} is available to you.`, {
        param: 'model',
      });
    case 'policy-excluded':
      return new GrantRefusal(
        'policy_violation',
        `Every route for ${name} is excluded by this application’s routing policy: ${resolution.constraints.join(', ')}.`,
        { reason: `policy_excluded:${resolution.constraints.join(',')}` },
      );
    case 'capability-unsupported':
    case 'modality-unsupported':
      return new GrantRefusal('unsupported_modality', `${name} cannot serve this request.`, {
        param: 'model',
        reason: resolution.status,
      });
    case 'capacity-unavailable':
      return resolution.outputLimitExceeded
        ? new GrantRefusal(
            'output_limit_exceeded',
            'No authorized route supports that output ceiling.',
            {
              param: 'max_output_tokens',
            },
          )
        : new GrantRefusal(
            'context_length_exceeded',
            'No authorized route can fit this request and its output ceiling.',
            {
              param: 'input',
            },
          );
    case 'routing-evidence-unavailable':
      return new GrantRefusal('no_route_available', 'No route is currently available.', {
        reason: `routing_evidence:${resolution.reason}`,
      });
    case 'customer-provider-credential-unavailable':
      return new GrantRefusal('no_route_available', 'No route is currently available.', {
        reason: 'customer-provider-credential-unavailable',
      });
  }
}

function idempotencyConflict(): GrantRefusal {
  return new GrantRefusal(
    'idempotency_conflict',
    'This Idempotency-Key has already been used. Responses are not retained, so it cannot be replayed.',
    { param: 'Idempotency-Key' },
  );
}

const INFERENCE_SCOPES = new Set([
  'inference:invoke',
  'inference:models:read',
  'inference:usage:read',
  'inference:routing:read',
  'inference:routing:write',
]);

function isInferenceScope(
  scope: string,
): scope is
  | 'inference:invoke'
  | 'inference:models:read'
  | 'inference:usage:read'
  | 'inference:routing:read'
  | 'inference:routing:write' {
  return INFERENCE_SCOPES.has(scope);
}

async function reservationExists(idempotencyKey: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: usageReservations.id })
    .from(usageReservations)
    .where(eq(usageReservations.idempotencyKey, idempotencyKey))
    .limit(1);
  return row !== undefined;
}

/** The grant target: the caller's, or the application's default target. */
async function grantTargetOf(
  request: InferenceAuthorizationRequest,
  defaultTarget: RoutingTarget | undefined,
  levelProfileIds: ReadonlyMap<PowerLevel, string>,
): Promise<GrantTarget> {
  if (request.target !== undefined) return request.target;
  if (defaultTarget === undefined) {
    throw new GrantRefusal(
      'invalid_request',
      'Name a model, or configure a default target on this application’s routing policy.',
      { param: 'model' },
    );
  }
  if (defaultTarget.kind === 'model') {
    const [line, revision] = defaultTarget.modelReference.split('@');
    return {
      kind: 'model',
      modelLine: line ?? defaultTarget.modelReference,
      ...(revision === undefined ? {} : { revision }),
    };
  }
  for (const [level, id] of levelProfileIds) {
    if (id === defaultTarget.routingProfileId) return { kind: 'level', level };
  }
  throw new GrantRefusal(
    'service_unavailable',
    'This application’s default target is a fixed routing profile, which grants do not serve; name a model or a power level.',
    { reason: 'default-target-fixed-profile' },
  );
}

/** The ranking dimension the catalogue resolver orders a target's routes by. */
async function optimiseForTarget(
  target: GrantTarget,
  policy: Awaited<ReturnType<typeof resolveEffectiveRoutingPolicy>>,
  internalDefault: boolean,
  levelProfileIds: ReadonlyMap<PowerLevel, string>,
): Promise<Parameters<typeof resolveEdgeRoute>[4]> {
  if (target.kind === 'model') {
    const optimiseFor =
      policy.status === 'resolved'
        ? policy.stored.policy.optimiseFor
        : internalDefault
          ? PLATFORM_INTERNAL_DEFAULT_OPTIMISE_FOR
          : undefined;
    if (optimiseFor === undefined) {
      throw new GrantRefusal('no_route_available', 'No route is currently available.', {
        reason: 'routing_evidence:missing-versioned-optimisation',
      });
    }
    return optimiseFor;
  }
  const id = levelProfileIds.get(target.level);
  const resolution = id === undefined ? undefined : await resolveRoutingProfileForEdgeById(id);
  if (resolution?.status !== 'power-level') {
    throw new GrantRefusal('no_route_available', 'No route is currently available.', {
      reason: 'unknown_power_level',
    });
  }
  return resolution.optimiseFor;
}

/**
 * The steps of a power-level target. `auto` is ONE step over every level it may
 * climb to (Kaana decides, by content); a promotional level named by an
 * internal relationship (ADR 0037) is two: the level on credit only, then the
 * pilot's fallback level on its exact routes.
 */
async function levelStepPlans(
  level: PowerLevel,
  plan: OperationPlan,
  pilot: InternalMeteredPilot | undefined,
  pilotTerms: GrantPilotTerms | undefined,
  policyPrice: { readonly amount: string; readonly currency: string } | undefined,
  levelAllowed: (level: PowerLevel) => boolean,
  viewer: ReturnType<typeof viewerForPrincipal>,
): Promise<StepPlan[]> {
  const linesOf = async (levels: readonly ConcretePowerLevel[]): Promise<string[]> =>
    (await powerLevelCandidates(viewer, levels)).map((candidate) => candidate.modelReference);
  const ordinary = {
    maxPrice: tighterPrice(policyPrice, pilotTerms?.maxPriceUsd),
    maxFundingTier: undefined,
    pilotDeployments: pilotTerms?.deployments,
    singleProvider: false,
  } as const;

  if (level === 'auto') {
    // Every level `auto` may land on (it never climbs past `AUTO_CEILING`),
    // narrowed by the application's allowed levels; Kaana picks among them.
    const levels = AUTO_POWER_LEVELS.filter(levelAllowed);
    return [{ ...ordinary, target: { kind: 'level', level }, candidates: await linesOf(levels) }];
  }

  const lane = pilot?.promotionalCredit;
  if (plan.family === 'completion' && lane !== undefined && lane.levels.includes(level)) {
    const steps: StepPlan[] = [
      {
        target: { kind: 'level', level },
        candidates: await linesOf([level]),
        maxPrice: tighterPrice(policyPrice, lane.maxPricePerRequestUsd),
        maxFundingTier: 'credit',
        pilotDeployments: undefined,
        singleProvider: false,
      },
    ];
    if (lane.fallbackLevel !== level && levelAllowed(lane.fallbackLevel)) {
      steps.push({
        ...ordinary,
        target: { kind: 'level', level: lane.fallbackLevel },
        candidates: await linesOf([lane.fallbackLevel]),
      });
    }
    return steps;
  }
  return [
    {
      ...ordinary,
      target: { kind: 'level', level },
      candidates: await linesOf([level as ConcretePowerLevel]),
    },
  ];
}

/**
 * Admit one model line under a step: quote each qualified route, keep the ones
 * under the step's price ceiling, and settle the line at its DEAREST surviving
 * route's price version — the line's list price for this grant, so the hold
 * covers whichever of them Kaana serves and the price never depends on its
 * choice (ADR 0002 decision 4).
 */
async function admitLine(
  routes: readonly EdgeRoute[],
  plan: OperationPlan,
  step: StepPlan,
): Promise<AdmittedLine | 'over-price' | undefined> {
  let sawOverPrice = false;
  const survivors: { route: EdgeRoute; quote: { amount: string; currency: string } }[] = [];
  for (const route of routes) {
    if (
      plan.family === 'transcription' &&
      (await publishedUnitPrice(route.priceVersionId, 'output_tokens')) === 'positive'
    ) {
      // A transcript's text has no bound in the facts; a route that charges for
      // it could settle above any hold sized from them.
      continue;
    }
    const quote = await quoteRouteCeiling(route.priceVersionId, plan.plans(route));
    if (quote.status !== 'quoted') continue;
    const ceiling = step.maxPrice;
    if (
      ceiling !== undefined &&
      (quote.currency !== ceiling.currency || exceedsAmount(quote.amount, ceiling.amount))
    ) {
      sawOverPrice = true;
      continue;
    }
    survivors.push({ route, quote: { amount: quote.amount, currency: quote.currency } });
  }
  const best = survivors[0];
  if (best === undefined) return sawOverPrice ? 'over-price' : undefined;
  const served = step.singleProvider
    ? survivors.filter((entry) => entry.route.provider === best.route.provider)
    : survivors;
  let dearest = best;
  for (const entry of served) {
    if (entry.quote.currency !== dearest.quote.currency) continue;
    if (exceedsAmount(entry.quote.amount, dearest.quote.amount)) dearest = entry;
  }
  return {
    modelLine: modelLineOf(best.route.modelReference),
    priceVersionId: dearest.route.priceVersionId,
    quote: dearest.quote,
    bestRoute: best.route,
    providers: [...new Set(served.map((entry) => entry.route.provider))],
  };
}

/** Steps restricted to the customer's own key: only lines it serves, at its fee. */
function byokSteps(steps: readonly ResolvedStep[], primary: EdgeRoute): ResolvedStep[] {
  const binding = primary.customerProviderCredential;
  return steps
    .map((step) => ({
      ...step,
      lines: step.lines.filter(
        (line) =>
          line.bestRoute.customerProviderCredential?.credentialHandle ===
            binding?.credentialHandle &&
          line.bestRoute.customerProviderCredential?.credentialRevision ===
            binding?.credentialRevision,
      ),
      providers: [primary.provider],
    }))
    .filter((step) => step.lines.length > 0);
}

/** A resolved step as the grant carries it: the policy's values, Kaana filters by them. */
function grantStepOf(
  step: ResolvedStep,
  constraints: typeof UNCONSTRAINED_ROUTING,
  byok: boolean,
): Record<string, unknown> {
  return {
    target: step.plan.target,
    limits: {
      ...(step.plan.maxPrice === undefined ? {} : { maxPricePerRequest: step.plan.maxPrice }),
      ...(step.plan.maxFundingTier === undefined || byok
        ? {}
        : { maxFundingTier: step.plan.maxFundingTier }),
      admittedModelLines: step.lines.map((line) => ({
        modelLine: line.modelLine,
        priceVersionId: line.priceVersionId,
      })),
      // Only providers Oxy's catalogue qualified for this request under every
      // policy control it enforces (data retention, training, regions, licences):
      // Kaana may choose among them, never outside them.
      providerAllowlist: [...step.providers],
      providerDenylist: constraints.providerDenylist.filter(
        (provider) => !step.providers.includes(provider),
      ),
      allowedRegions: [...constraints.allowedRegions],
      deniedRegions: [...constraints.deniedRegions],
      requireZeroDataRetention: constraints.requireZeroDataRetention,
      prohibitTrainingOnCustomerData: constraints.prohibitTrainingOnCustomerData,
      allowedLicenseIds: [...constraints.allowedLicenseIds],
      requireCommercialUseRights: constraints.requireCommercialUseRights,
    },
  };
}

/**
 * The relationship's capacity with the application's Console overrides: a value
 * set in Console replaces the reviewed default for this application only.
 */
function withConsoleCapacity(
  economics: EconomicTreatmentDecision,
  limits: Awaited<ReturnType<typeof readApplicationInferenceLimits>>,
): EconomicTreatmentDecision {
  if (economics.treatment !== 'internal_metered') return economics;
  const capacity = economics.relationship.capacity;
  return {
    ...economics,
    relationship: {
      ...economics.relationship,
      capacity: {
        ...capacity,
        maxConcurrentRequests: limits.maxConcurrentRequests ?? capacity.maxConcurrentRequests,
        maxRequestsPerUtcDay: limits.maxRequestsPerUtcDay ?? capacity.maxRequestsPerUtcDay,
      },
    },
  };
}

interface GrantRecord {
  readonly grant: Grant;
  readonly body: Buffer;
  readonly signingKeyId: string;
  readonly endpoint: string;
  readonly meteredUsageId: string;
  readonly reservationId: string | undefined;
  readonly ceiling: { readonly amount: string; readonly currency: string } | undefined;
  readonly routingPolicyVersionId: string | undefined;
  readonly relationshipId: string | undefined;
  readonly expiresAt: Date;
  readonly steps: readonly ResolvedStep[];
}

async function recordGrant(record: GrantRecord): Promise<void> {
  const { grant } = record;
  await getDb().transaction(async (tx) => {
    await tx.insert(kaanaGrants).values({
      id: grant.grantId,
      requestId: grant.requestId,
      operation: grant.operation,
      endpoint: record.endpoint,
      lane: grant.principal.lane,
      accountId: grant.principal.billingAccountId,
      applicationId: grant.principal.applicationId,
      applicationCredentialId: grant.principal.credentialId,
      delegatedUserId: grant.userId ?? null,
      environment: grant.principal.environment,
      economicTreatment: grant.economics.treatment,
      economicPolicyVersion: grant.economics.policyVersion,
      economicRelationshipId: record.relationshipId ?? null,
      meteredUsageId: record.meteredUsageId,
      reservationId: record.reservationId ?? null,
      ceilingAmount: record.ceiling?.amount ?? null,
      ceilingCurrency: record.ceiling?.currency ?? null,
      routingPolicyVersionId: record.routingPolicyVersionId ?? null,
      bodySha256: grant.bodySha256,
      grantSha256: sha256Hex(record.body),
      signingKeyId: record.signingKeyId,
      issuedAt: new Date(grant.issuedAt),
      executeBy: new Date(grant.executeBy),
      expiresAt: record.expiresAt,
    });
    for (const [stepIndex, step] of grant.steps.entries()) {
      await tx.insert(kaanaGrantSteps).values({
        grantId: grant.grantId,
        stepIndex,
        targetKind: step.target.kind,
        target:
          step.target.kind === 'level'
            ? step.target.level
            : step.target.revision === undefined
              ? step.target.modelLine
              : `${step.target.modelLine}@${step.target.revision}`,
        maxFundingTier: step.limits.maxFundingTier ?? null,
        maxPriceAmount: step.limits.maxPricePerRequest?.amount ?? null,
        maxPriceCurrency: step.limits.maxPricePerRequest?.currency ?? null,
      });
      await tx.insert(kaanaGrantAdmittedLines).values(
        step.limits.admittedModelLines.map((line) => ({
          grantId: grant.grantId,
          stepIndex,
          modelLine: line.modelLine,
          priceVersionId: line.priceVersionId,
        })),
      );
    }
  });
}

/**
 * Undo what a grant that was never signed took: its usage row and capacity
 * slot, and its hold — settled at zero as `failed`, so the ledger records why
 * the money came back rather than letting the sweeper find it.
 */
async function releaseUnsignedGrant(
  meteredUsageId: string,
  reservationId: string | undefined,
  ledgerKey: string,
  attribution: LedgerAttribution,
  ceilingLine: AdmittedLine,
): Promise<void> {
  await markMeteredAdmissionRefused(meteredUsageId).catch(() => undefined);
  if (reservationId === undefined) return;
  await settle({
    idempotencyKey: ledgerKey,
    reservationId,
    attribution,
    outcome: 'failed',
    usageSource: 'estimated',
    units: {},
    resolvedModelReference: ceilingLine.bestRoute.modelReference,
    servingProvider: ceilingLine.bestRoute.provider,
    priceVersionId: ceilingLine.priceVersionId,
  }).catch((error: unknown) =>
    logger.error(
      'inference.grant.release_failed',
      error instanceof Error ? error : new Error(String(error)),
      {
        reservationId,
      },
    ),
  );
}

/** Read a stored grant's steps and admitted lines, by step. */
export async function readGrantLines(
  grantId: string,
): Promise<
  ReadonlyMap<
    number,
    { readonly maxFundingTier: string | null; readonly lines: ReadonlyMap<string, string> }
  >
> {
  const db = getDb();
  const steps = await db
    .select({
      stepIndex: kaanaGrantSteps.stepIndex,
      maxFundingTier: kaanaGrantSteps.maxFundingTier,
    })
    .from(kaanaGrantSteps)
    .where(eq(kaanaGrantSteps.grantId, grantId));
  const lines = await db
    .select({
      stepIndex: kaanaGrantAdmittedLines.stepIndex,
      modelLine: kaanaGrantAdmittedLines.modelLine,
      priceVersionId: kaanaGrantAdmittedLines.priceVersionId,
    })
    .from(kaanaGrantAdmittedLines)
    .where(and(eq(kaanaGrantAdmittedLines.grantId, grantId)));
  const byStep = new Map<number, { maxFundingTier: string | null; lines: Map<string, string> }>();
  for (const step of steps)
    byStep.set(step.stepIndex, { maxFundingTier: step.maxFundingTier, lines: new Map() });
  for (const line of lines)
    byStep.get(line.stepIndex)?.lines.set(line.modelLine, line.priceVersionId);
  return byStep;
}
