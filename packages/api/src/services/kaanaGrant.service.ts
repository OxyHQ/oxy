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
 * 1. the credential        authenticateInferenceBearer — the edge's two lanes, audience kaana.ai;
 *                          or authenticateProductSession — a person's session (ADR 0050)
 * 2. scope, attribution    inference:invoke; X-Oxy-User-Id as attribution only
 * 3. treatment             resolveEconomicTreatment — the same versioned policy
 * 4. the operation         facts → the units its hold is sized in; unsound facts refuse
 * 5. the policy            resolveEffectiveRoutingPolicy, pinned; allowed levels; default target
 * 6. steps                 per step, the model lines KAANA's catalogue declares (identity,
 *                          audience, capabilities, list price) with the routes it publishes
 *                          that the application's policy qualifies, each admitted at the
 *                          priceVersionId a settlement of it is billed at
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
 * relationship (`config/inferenceEconomicPolicy.ts`); a customer-key (BYOK)
 * route is not admitted yet (`kaanaGrantRoutes.service.ts`); ADR 0037's promotional lane is a `credit`-ceilinged step
 * followed by the pilot's `xhigh` step. `docs/inference/kaana-grants.md` holds
 * the matrix lane by lane.
 *
 * ## Decisions
 *
 * `decisions` is an ordinary operation held in input tokens only, granted to an
 * application whose economic relationship carries decisions terms
 * (`pilot.decisions`) and to no other (`decisions-not-enabled`). Its model lines
 * are the reviewed, versioned decisions profile (`config/decisionsPolicy.ts`):
 * with no target, one step per profile line in order; a named model must be a
 * profile line at its revision; a power level is refused. Every step is pinned
 * to its line's revision, requires zero data retention and no training on
 * customer data, and serves each line on one provider and key. A line Kaana
 * publishes no route for admits nothing and its step is dropped.
 *
 * ## What this phase does not grant yet
 *
 *  - A COMMERCIAL realtime session: the authorization's facts carry no session
 *    duration, so no hold Oxy could size from them would be a bound.
 *  - A `product_session` for an application with no reviewed terms: the lane
 *    (ADR 0050) is admitted only under a relationship that names it, and the
 *    person is the session's, never a header's.
 *
 * Each is a typed refusal, never a grant on different terms.
 *
 * ## No content, ever
 *
 * Every log line names ids, codes and counts. The request this module sees is
 * already content-free; it keeps it that way.
 */

import { eq } from 'drizzle-orm';
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
import {
  DECISIONS_GRANT_LIMITS,
  DECISIONS_POLICY_VERSION,
  DECISIONS_PROFILE,
} from '../config/decisionsPolicy';
import { isChargingAuthorized } from '../config/rolloutFlags';
import {
  type EconomicTreatmentDecision,
  type InternalMeteredPilot,
  type InternalMeteredPilotDeployment,
  pilotTextTerms,
  resolveEconomicTreatment,
} from '../config/inferenceEconomicPolicy';
import {
  kaanaGrantAdmittedLines,
  kaanaGrantLineUnitPrices,
  kaanaGrantSteps,
  kaanaGrants,
} from '../db/schema/kaanaGrants';
import { usageReservations } from '../db/schema/usageReservations';
import { readApplicationInferenceLimits } from './applicationInferenceLimits.service';
import {
  type EdgePrincipal,
  hasInferenceScope,
  PLATFORM_DEFAULT_AUTHORIZES_SAME_MODEL_FAILOVER,
  PLATFORM_DEFAULT_ROUTING_POLICY,
  PLATFORM_INTERNAL_DEFAULT_ROUTING_POLICY,
  RESERVATION_TTL_SECONDS,
  ceilingQuoteScenarios,
  quoteRouteCeiling,
  reservationOrRefusal,
  type RouteCeilingPlan,
  viewerForPrincipal,
} from './inferenceEdge.service';
import {
  type EdgeCapacityRequirement,
  type EdgeModalityRequirement,
  TEXT_COMPLETION_MODALITY,
  UNCONSTRAINED_ROUTING,
  exceedsAmount,
  routingConstraintsOf,
} from './inferenceCatalogue.service';
import {
  type PriceSnapshotInput,
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
  POWER_LEVEL_CLASS,
  powerLevelProfileIds,
} from './inferencePowerLevels.service';
import { resolveEffectiveRoutingPolicy } from './inferenceRoutingPolicy.service';
import {
  type DeclaredCatalogueObservation,
  currentDeclaredCatalogue,
} from './kaanaDeclaredCatalogue.service';
import { currentDeploymentLiveness } from './kaanaDeploymentPublication.service';
import {
  type GrantLane,
  type GrantLine,
  type GrantLineResolution,
  type GrantRoute,
  powerLevelLines,
  resolveGrantLine,
} from './kaanaGrantRoutes.service';
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
  | { readonly status: 'refused'; readonly error: PublicError };

type UnresolvedRoute = Exclude<GrantLineResolution, { readonly status: 'resolved' }>;

/** The ceilings a plan sizes a line's hold from: its declared capabilities. */
type LineCeilings = Pick<GrantLine, 'maxContextTokens' | 'maxOutputTokens'>;

export interface AuthorizeInferenceInput {
  readonly request: InferenceAuthorizationRequest;
  readonly principal: EdgePrincipal;
  /** The Oxy edge key; absent when this deployment has no Kaana binding. */
  readonly signing: Pick<KaanaDataPlaneConfig, 'keyId' | 'privateKey'> | undefined;
  /**
   * The person a `product_session` principal's session proves (its subject
   * account), from the session row. Required on that lane and absent on every
   * other: it is the request's attributed user, never a header's.
   */
  readonly sessionUserId?: string;
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
    readonly options: {
      readonly param?: string;
      readonly reason?: string;
      /** Why no line was admitted (`no_admissible_line`); logged, never sent. */
      readonly exclusions?: readonly string[];
    } = {},
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
    ...(error.options.exclusions === undefined ? {} : { exclusions: error.options.exclusions }),
  });
  return {
    status: 'refused',
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
  readonly family:
    | 'completion'
    | 'embeddings'
    | 'speech'
    | 'transcription'
    | 'images'
    | 'realtime'
    | 'decisions';
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
  plans(route: LineCeilings): readonly RouteCeilingPlan[];
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
  route: LineCeilings,
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
        // A context window bounds EACH input: every input is embedded on its
        // own, so the batch's total is no measure of fit (it still prices the
        // request and answers to the pilot's budget). The facts carry the total
        // and the count, not each input, so the route is held to the smallest
        // the largest input can be: the batch's mean, exact for one input. A
        // batch refused here holds an input no route can embed; one long input
        // among short ones is the provider's to refuse.
        capacity: { inputTokens: Math.ceil(input / embeddings), outputTokens: 0 },
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
        // free on every route this admits (see `admitLine`). A line that also
        // prices the request is quoted with it; one that prices the duration
        // alone (xAI's grok-voice-transcribe, whose adapter settles only
        // `audio_input_milliseconds`) is quoted without it — an unpriced
        // `requests` fails the first plan closed, never the line.
        plans: () => [
          {
            metering: 'duration',
            scenarios: [{ requests: 1, audio_input_milliseconds: milliseconds }],
          },
          {
            metering: 'duration',
            scenarios: [{ audio_input_milliseconds: milliseconds }],
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
    case 'decisions': {
      // Kaana's estimate of the serialized state, instructions and questions.
      // A decision generates no billable output: the hold is `requests` and
      // `input_tokens`, and a line that prices output is never admitted (see
      // `admitLine`), so the few output tokens Kaana reports settle at zero.
      const input = requireFact(facts.estimatedInputTokens, 'estimatedInputTokens');
      return {
        family: 'decisions',
        modality: {
          input: 'text',
          output: 'decisions',
          apiFormat: 'decisions',
          requiresDeclaredApiFormat: true,
        },
        capacity: { inputTokens: input, outputTokens: 0 },
        knownUnits: { input_tokens: input },
        maxOutputTokens: undefined,
        plans: () => [
          {
            metering: 'tokens',
            scenarios: ceilingQuoteScenarios({ kind: 'decisions' }, input, 0),
          },
        ],
      };
    }
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
  /** The only power levels a request may target; absent: any target. */
  readonly levels?: readonly PowerLevel[];
}

function grantPilotTerms(
  pilot: InternalMeteredPilot,
  plan: OperationPlan,
  request: InferenceAuthorizationRequest,
): GrantPilotTerms | undefined {
  switch (plan.family) {
    case 'completion': {
      const text = pilotTextTerms(pilot);
      if (text === undefined && pilot.levelText !== undefined) {
        return {
          maxInput: pilot.levelText.maxInputTokens,
          maxOutputTokens: pilot.levelText.maxOutputTokens,
          maxPriceUsd: pilot.levelText.maxPricePerRequestUsd,
          deployments: undefined,
          levels: pilot.levelText.levels,
        };
      }
      return text?.maxPricePerRequestUsd === undefined
        ? undefined
        : {
            maxInput: text.maxControlledInputBudget,
            maxOutputTokens: text.maxOutputTokens,
            maxPriceUsd: text.maxPricePerRequestUsd,
            deployments: text.deployments,
          };
    }
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
      return pilot.embeddings === undefined
        ? undefined
        : {
            maxInput: pilot.embeddings.maxInputTokens,
            maxOutputTokens: undefined,
            maxPriceUsd: pilot.embeddings.maxPricePerRequestUsd,
            deployments: pilot.embeddings.deployments,
          };
    case 'decisions':
      return pilot.decisions === undefined
        ? undefined
        : {
            maxInput: pilot.decisions.maxInputTokens,
            maxOutputTokens: undefined,
            maxPriceUsd: pilot.decisions.maxPricePerRequestUsd,
            deployments: undefined,
          };
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
  /**
   * Whether Kaana may fail over to another provider or key of the same model
   * within the step: the application's policy, sent as `sameModelFailover` on
   * the step limits (contract set 4.4.0).
   */
  readonly sameModelFailover: boolean;
}

/** An admitted line: its best route (for the usage row) and the price it settles at. */
interface AdmittedLine {
  readonly modelLine: string;
  /** `list`: Kaana's own keys at the declared list. `byok`: the customer's key at Oxy's platform fee. */
  readonly lane: 'list' | 'byok';
  /**
   * What the line settles at. `list`: the list Kaana declared (its id is the
   * grant's `priceVersionId`). `byok`: Oxy's platform fee schedule, as a list.
   */
  readonly price: PriceSnapshotInput;
  readonly quote: { readonly amount: string; readonly currency: string };
  readonly bestRoute: GrantRoute;
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
  const economics = resolveEconomicTreatment(principal, request.operation);
  const delegatedUserId = productSessionUser(input, economics);
  if (!hasInferenceScope(principal, 'inference:invoke')) {
    throw new GrantRefusal(
      'insufficient_scope',
      'This credential does not hold the inference:invoke scope.',
    );
  }
  const plan = planOperation(request);

  // Decisions are granted only under an economic relationship's decisions terms.
  if (
    plan.family === 'decisions' &&
    (economics.treatment !== 'internal_metered' ||
      economics.relationship.pilot?.decisions === undefined)
  ) {
    throw new GrantRefusal('permission_denied', 'Decisions are not enabled for this application.', {
      reason: 'decisions-not-enabled',
    });
  }

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
  const policyConstraints =
    policy.status === 'resolved'
      ? routingConstraintsOf(policy.stored.policy)
      : UNCONSTRAINED_ROUTING;
  // A decision is answered with zero data retention and no training on it,
  // whatever the application's own policy asks (`config/decisionsPolicy.ts`).
  const constraints =
    plan.family === 'decisions'
      ? {
          ...policyConstraints,
          requireZeroDataRetention: DECISIONS_GRANT_LIMITS.requireZeroDataRetention,
          prohibitTrainingOnCustomerData: DECISIONS_GRANT_LIMITS.prohibitTrainingOnCustomerData,
        }
      : policyConstraints;
  const levelProfileIds = await powerLevelProfileIds();
  const allowedProfileIds =
    policy.status === 'resolved' ? policy.stored.policy.allowedRoutingProfileIds : [];
  const levelAllowed = (level: PowerLevel): boolean => {
    const id = levelProfileIds.get(level);
    return id !== undefined && (allowedProfileIds.length === 0 || allowedProfileIds.includes(id));
  };

  // Decisions take their lines from the decisions profile, never from the
  // application's default target (which names a generation model or level).
  const target: GrantTarget | undefined =
    plan.family === 'decisions'
      ? request.target
      : await grantTargetOf(
          request,
          policy.status === 'resolved' ? policy.stored.policy.defaultTarget : undefined,
          levelProfileIds,
        );
  if (plan.family === 'decisions' && target?.kind === 'level') {
    throw new GrantRefusal(
      'invalid_request',
      'Decisions name a model revision of the decisions profile, or no model; a power level does not answer decisions.',
      { param: 'model', reason: 'decisions-level-target' },
    );
  }
  if (plan.family === 'realtime' && target?.kind !== 'model') {
    throw new GrantRefusal(
      'invalid_request',
      'A realtime session names a model, never a power level.',
      {
        param: 'model',
      },
    );
  }
  if (
    pilotTerms?.levels !== undefined &&
    (target?.kind !== 'level' || !pilotTerms.levels.includes(target.level))
  ) {
    throw new GrantRefusal(
      'policy_violation',
      `The internal pilot serves this operation on the power levels ${pilotTerms.levels.join(', ')} only.`,
      { param: 'model', reason: 'pilot-level' },
    );
  }
  if (target?.kind === 'level' && !levelAllowed(target.level)) {
    throw new GrantRefusal(
      'policy_violation',
      `This application’s routing policy does not allow the power level "${target.level}".`,
      { param: 'model', reason: 'policy_excluded:allowedRoutingProfileIds' },
    );
  }

  // ---- Kaana's evidence: the catalogue it declares and the routes it publishes ----
  // Both are read BEFORE anything is claimed or held: a grant is rated from
  // Kaana's declared list or not at all.
  const catalogueView = await currentDeclaredCatalogue();
  if (catalogueView.status !== 'observed') {
    throw new GrantRefusal(
      'service_unavailable',
      'The model catalogue is temporarily unavailable.',
      { reason: `declared_catalogue:${catalogueView.status}` },
    );
  }
  const catalogue: DeclaredCatalogueObservation = catalogueView;
  const liveness = await currentDeploymentLiveness();
  if (liveness.status !== 'observed' || liveness.routes === undefined) {
    throw new GrantRefusal(
      'service_unavailable',
      'The inference routing evidence is temporarily unavailable.',
      { reason: `routing_evidence:kaana-publication-${liveness.status}` },
    );
  }
  const evidence = { catalogue, published: liveness.routes };

  // ---- Steps ---------------------------------------------------------------
  const policyPrice = constraints.maxPricePerRequest;
  const stepPlans: StepPlan[] = [];
  /** Why each line or lane was not admitted, for the refusal's log line. */
  const exclusions = new Set<LineExclusion>();
  if (plan.family === 'decisions') {
    // A level target was refused above.
    stepPlans.push(
      ...decisionsStepPlans(target?.kind === 'model' ? target : undefined, policyPrice, pilotTerms),
    );
  } else if (target?.kind === 'model') {
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
      sameModelFailover,
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
  } else if (target?.kind === 'level') {
    stepPlans.push(
      ...levelStepPlans(
        target.level,
        plan,
        pilot,
        pilotTerms,
        policyPrice,
        levelAllowed,
        viewer,
        catalogue,
      ),
    );
  }

  const resolvedSteps: ResolvedStep[] = [];
  let sawPriceExclusion = false;
  /** The first step's own failure, when it names one model: what the caller asked for. */
  let primaryFailure: UnresolvedRoute | undefined;
  for (const stepPlan of stepPlans) {
    const lines: AdmittedLine[] = [];
    for (const candidate of stepPlan.candidates) {
      const resolution = await resolveGrantLine(
        evidence,
        viewer,
        { applicationId: principal.applicationId, environment: principal.environment },
        candidate,
        constraints,
        plan.modality,
        plan.capacity,
      );
      if (resolution.status !== 'resolved') {
        if (stepPlan === stepPlans[0] && target?.kind === 'model') primaryFailure ??= resolution;
        continue;
      }
      for (const lane of resolution.line.lanes) {
        const routes = lane.routes.filter(
          (route) =>
            stepPlan.pilotDeployments === undefined ||
            stepPlan.pilotDeployments.some(
              (allowed) =>
                allowed.deploymentId === route.deploymentId &&
                allowed.modelReference === route.modelReference &&
                allowed.provider === route.provider,
            ),
        );
        const admitted = await admitLine(resolution.line, lane, routes, plan, stepPlan);
        if (admitted.status === 'admitted') lines.push(admitted.line);
        else {
          if (admitted.status === 'over-price') sawPriceExclusion = true;
          exclusions.add(
            admitted.status === 'unquoted' ? `unquoted:${admitted.reason}` : admitted.status,
          );
        }
      }
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
    if (primaryFailure !== undefined && target?.kind === 'model') {
      throw refusalForResolution(primaryFailure, target);
    }
    throw new GrantRefusal('no_route_available', 'No route is currently available.', {
      reason: 'no_admissible_line',
      exclusions: [...exclusions].sort(),
    });
  }

  // ---- Treatment: the lane the first line is served in ------------------------
  // Lines come in lane-preference order. A grant has ONE economics, so it is
  // served in the lane of its first line: Kaana's own keys at the declared list,
  // or the customer's key (`platform_fee_only`, rated at Oxy's platform fee
  // alone) with that one credential binding.
  const primaryLine = resolvedSteps[0]?.lines[0];
  if (primaryLine === undefined) {
    throw new GrantRefusal('no_route_available', 'No route is currently available.');
  }
  const primary = primaryLine.bestRoute;
  const byok = primary.customerProviderCredential;
  if (byok !== undefined && economics.treatment === 'internal_metered') {
    throw new GrantRefusal(
      'policy_violation',
      'An internal relationship is not served on a customer key.',
      { reason: 'internal-byok' },
    );
  }
  const treatment: Grant['economics']['treatment'] =
    byok !== undefined ? 'platform_fee_only' : economics.treatment;
  const steps: ResolvedStep[] = resolvedSteps
    .map((step) => {
      const lines = step.lines.filter(
        (line) =>
          line.lane === primaryLine.lane &&
          line.bestRoute.customerProviderCredential?.credentialHandle === byok?.credentialHandle &&
          line.bestRoute.customerProviderCredential?.credentialRevision ===
            byok?.credentialRevision,
      );
      return {
        plan: step.plan,
        lines,
        providers: [...new Set(lines.flatMap((line) => line.providers))].sort(),
      };
    })
    .filter((step) => step.lines.length > 0);
  if (steps.length === 0) {
    throw new GrantRefusal('no_route_available', 'No route is currently available.', {
      reason: 'no-line-in-lane',
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
  const expiresInSeconds =
    plan.family === 'realtime' ? REALTIME_GRANT_SLOT_SECONDS : RESERVATION_TTL_SECONDS;
  const requestedReference =
    target === undefined
      ? DECISIONS_POLICY_VERSION
      : target.kind === 'model'
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
        : claim.limit === 'user-daily'
          ? new GrantRefusal(
              'quota_exceeded',
              'You have reached this application’s daily inference limit.',
              { reason: 'internal-capacity-user-daily' },
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
      ceilingPriceVersionId: ceilingLine.price.priceVersionId,
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
  // refinements (window, treatment) are applied there, not asserted here.
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
      ...(principal.authority === 'first_party'
        ? { authority: 'first_party' as const }
        : { authority: 'external' as const, scopes: principal.scopes.filter(isInferenceScope) }),
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

/**
 * The request's attributed user. On every lane but `product_session` it is
 * `X-Oxy-User-Id`, attribution only. On `product_session` it is the person the
 * session proves, and the lane is admitted only under a relationship that names
 * it (ADR 0050): with no reviewed terms the application's owner is never
 * charged for a person's session, and a header naming someone else is refused
 * rather than recorded.
 */
function productSessionUser(
  input: AuthorizeInferenceInput,
  economics: EconomicTreatmentDecision,
): string | undefined {
  const { request, principal, sessionUserId } = input;
  if (principal.lane !== 'product_session') return request.onBehalfOfUserId;
  if (sessionUserId === undefined) {
    throw new GrantRefusal('authentication_failed', 'This session could not be verified.', {
      reason: 'product-session-without-user',
    });
  }
  if (economics.treatment !== 'internal_metered') {
    throw new GrantRefusal(
      'permission_denied',
      'This application does not offer inference with a signed-in session.',
      { reason: 'product-session-not-enabled' },
    );
  }
  if (request.onBehalfOfUserId !== undefined && request.onBehalfOfUserId !== sessionUserId) {
    throw new GrantRefusal(
      'permission_denied',
      'X-Oxy-User-Id must name the signed-in person, or be omitted.',
      { param: 'X-Oxy-User-Id', reason: 'product-session-user-mismatch' },
    );
  }
  return sessionUserId;
}

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
    case 'model-not-priced':
      // Typed, and never a zero price: Kaana declares no price per unit for
      // this model (the BYOK-only case), or republished a price version.
      return new GrantRefusal('no_route_available', `${name} cannot be priced per unit.`, {
        param: 'model',
        reason: `pricing:${resolution.error.code}`,
      });
    case 'platform-fee-unavailable':
      return new GrantRefusal('no_route_available', 'No route is currently available.', {
        reason: 'platform_fee_not_approved',
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
              reason: 'route-output',
            },
          )
        : new GrantRefusal(
            'context_length_exceeded',
            'No authorized route can fit this request and its output ceiling.',
            {
              param: 'input',
              reason: 'route-context',
            },
          );
    case 'no-published-route':
      return new GrantRefusal('no_route_available', 'No route is currently available.', {
        reason: 'no_published_route',
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

/**
 * The steps of a decisions request: one per decisions-profile line, in the
 * profile's order, or the one line the request pinned, each at the line's
 * pinned revision. Each is held to the tightest of the application's price
 * cap, the relationship's decisions terms and the line's own reviewed ceiling,
 * and serves its line on one provider. A line Kaana publishes no route for
 * admits nothing, as any step's line.
 */
function decisionsStepPlans(
  target: Extract<GrantTarget, { kind: 'model' }> | undefined,
  policyPrice: { readonly amount: string; readonly currency: string } | undefined,
  pilotTerms: GrantPilotTerms | undefined,
): StepPlan[] {
  const plans: StepPlan[] = [];
  for (const line of DECISIONS_PROFILE) {
    if (
      target !== undefined &&
      (target.modelLine !== line.modelLine || target.revision !== line.revision)
    )
      continue;
    plans.push({
      target: { kind: 'model', modelLine: line.modelLine, revision: line.revision },
      candidates: [`${line.modelLine}@${line.revision}`],
      maxPrice: tighterPrice(
        tighterPrice(policyPrice, pilotTerms?.maxPriceUsd),
        line.maxPricePerRequestUsd,
      ),
      maxFundingTier: undefined,
      pilotDeployments: undefined,
      sameModelFailover: DECISIONS_GRANT_LIMITS.sameModelFailover,
    });
  }
  if (target !== undefined && plans.length === 0) {
    const name =
      target.revision === undefined ? target.modelLine : `${target.modelLine}@${target.revision}`;
    throw new GrantRefusal('model_not_found', `No decisions model ${name} is available to you.`, {
      param: 'model',
      reason: 'decisions-outside-profile',
    });
  }
  return plans;
}

/**
 * The steps of a power-level target. `auto` is ONE step over every level it may
 * climb to (Kaana decides, by content); a promotional level named by an
 * internal relationship (ADR 0037) is two: the level on credit only, then the
 * pilot's fallback level on its exact routes.
 */
function levelStepPlans(
  level: PowerLevel,
  plan: OperationPlan,
  pilot: InternalMeteredPilot | undefined,
  pilotTerms: GrantPilotTerms | undefined,
  policyPrice: { readonly amount: string; readonly currency: string } | undefined,
  levelAllowed: (level: PowerLevel) => boolean,
  viewer: ReturnType<typeof viewerForPrincipal>,
  catalogue: DeclaredCatalogueObservation,
): StepPlan[] {
  // A level's lines are the models Kaana declares in its power class.
  const linesOf = (levels: readonly ConcretePowerLevel[]): string[] =>
    powerLevelLines(catalogue, viewer, levels, (concrete) => POWER_LEVEL_CLASS[concrete]);
  const ordinary = {
    maxPrice: tighterPrice(policyPrice, pilotTerms?.maxPriceUsd),
    maxFundingTier: undefined,
    pilotDeployments: pilotTerms?.deployments,
    sameModelFailover: true,
  } as const;

  if (level === 'auto') {
    // Every level `auto` may land on (it never climbs past `AUTO_CEILING`),
    // narrowed by the application's allowed levels; Kaana picks among them.
    const levels = AUTO_POWER_LEVELS.filter(levelAllowed);
    return [{ ...ordinary, target: { kind: 'level', level }, candidates: linesOf(levels) }];
  }

  const lane = pilot?.promotionalCredit;
  if (plan.family === 'completion' && lane !== undefined && lane.levels.includes(level)) {
    const steps: StepPlan[] = [
      {
        target: { kind: 'level', level },
        candidates: linesOf([level]),
        maxPrice: tighterPrice(policyPrice, lane.maxPricePerRequestUsd),
        maxFundingTier: 'credit',
        pilotDeployments: undefined,
        sameModelFailover: true,
      },
    ];
    if (lane.fallbackLevel !== level && levelAllowed(lane.fallbackLevel)) {
      steps.push({
        ...ordinary,
        target: { kind: 'level', level: lane.fallbackLevel },
        candidates: linesOf([lane.fallbackLevel]),
      });
    }
    return steps;
  }
  return [
    {
      ...ordinary,
      target: { kind: 'level', level },
      candidates: linesOf([level as ConcretePowerLevel]),
    },
  ];
}

/**
 * Admit one lane of a model line under a step: quote it at the lane's price (the
 * list Kaana declared, or Oxy's platform fee for the customer's own key) and
 * keep it if that is under the step's price ceiling. There is one price per
 * lane, so the hold covers whichever route Kaana serves.
 *
 * ALL the eligible routes are admitted: the providers are every one the
 * application's policy qualified, and Kaana chooses among them — cheapest first,
 * with failover and recovery (owner decision 2026-10-12). The customer's own
 * key is the exception, by construction: the grant carries ONE credential, so a
 * `byok` line is admitted for the provider that credential belongs to.
 */
/**
 * Why a resolved lane was not admitted. Logged on `no_admissible_line` (never
 * sent to the caller), so a refusal says which rule excluded every line.
 */
type LineExclusion =
  | 'no-routes'
  | 'priced-transcript'
  | 'priced-decision-output'
  | 'over-price'
  | `unquoted:${string}`;

type LineAdmission =
  | { readonly status: 'admitted'; readonly line: AdmittedLine }
  | {
      readonly status: 'no-routes' | 'priced-transcript' | 'priced-decision-output' | 'over-price';
    }
  | { readonly status: 'unquoted'; readonly reason: string };

async function admitLine(
  line: GrantLine,
  lane: GrantLane,
  routes: readonly GrantRoute[],
  plan: OperationPlan,
  step: StepPlan,
): Promise<LineAdmission> {
  const best = routes[0];
  if (best === undefined) return { status: 'no-routes' };
  if (
    plan.family === 'transcription' &&
    (await publishedUnitPrice(lane.price, 'output_tokens')) === 'positive'
  ) {
    // A transcript's text has no bound in the facts; a line that charges for it
    // could settle above any hold sized from them.
    return { status: 'priced-transcript' };
  }
  if (
    plan.family === 'decisions' &&
    (await publishedUnitPrice(lane.price, 'output_tokens')) !== 'zero'
  ) {
    // The hold is input only; the output tokens a decision truthfully reports
    // settle inside it only on a line that publishes them at exactly zero.
    return { status: 'priced-decision-output' };
  }
  const quote = await quoteRouteCeiling(lane.price, plan.plans(line));
  if (quote.status !== 'quoted') return { status: 'unquoted', reason: quote.reason };
  const ceiling = step.maxPrice;
  if (
    ceiling !== undefined &&
    (quote.currency !== ceiling.currency || exceedsAmount(quote.amount, ceiling.amount))
  ) {
    return { status: 'over-price' };
  }
  const served =
    lane.kind === 'byok' ? routes.filter((route) => route.provider === best.provider) : routes;
  return {
    status: 'admitted',
    line: {
      modelLine: line.modelLine,
      lane: lane.kind,
      price: lane.price,
      quote: { amount: quote.amount, currency: quote.currency },
      bestRoute: best,
      providers: [...new Set(served.map((route) => route.provider))],
    },
  };
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
        priceVersionId: line.price.priceVersionId,
      })),
      // Every provider that serves the line, that Kaana says may be sold to this
      // audience, and that the application's policy qualifies (data retention,
      // training, regions, licences): Kaana chooses among them and fails over
      // within them, never outside.
      // Whether Kaana may fail over within the step is the policy's, sent as is.
      sameModelFailover: step.plan.sameModelFailover,
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
      const admitted = record.steps[stepIndex]?.lines ?? [];
      await tx.insert(kaanaGrantAdmittedLines).values(
        step.limits.admittedModelLines.map((line) => {
          const priced = admitted.find((candidate) => candidate.modelLine === line.modelLine);
          if (priced === undefined || priced.price.priceVersionId !== line.priceVersionId) {
            throw new Error(`the grant admits ${line.modelLine} at a list it did not price`);
          }
          return {
            grantId: grant.grantId,
            stepIndex,
            modelLine: line.modelLine,
            priceVersionId: line.priceVersionId,
            currency: priced.price.currency,
          };
        }),
      );
      // The list the line was rated at, copied: the settlement rates at THESE
      // entries, whatever Kaana declares afterwards.
      await tx.insert(kaanaGrantLineUnitPrices).values(
        admitted.flatMap((line) =>
          line.price.unitPrices.map((entry) => ({
            grantId: grant.grantId,
            stepIndex,
            modelLine: line.modelLine,
            unit: entry.unit,
            amount: entry.amount,
            per: entry.per,
          })),
        ),
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
    priceVersionId: ceilingLine.price.priceVersionId,
    priceSnapshot: ceilingLine.price,
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

/** A stored grant's step: its funding ceiling and the lists its lines were rated at. */
export interface StoredGrantStep {
  readonly maxFundingTier: string | null;
  /** By model line: exactly the list the grant was signed with. */
  readonly lines: ReadonlyMap<string, PriceSnapshotInput>;
}

/** Read a stored grant's steps and admitted lines, with their price lists, by step. */
export async function readGrantLines(
  grantId: string,
): Promise<ReadonlyMap<number, StoredGrantStep>> {
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
      currency: kaanaGrantAdmittedLines.currency,
    })
    .from(kaanaGrantAdmittedLines)
    .where(eq(kaanaGrantAdmittedLines.grantId, grantId));
  const unitPrices = await db
    .select({
      stepIndex: kaanaGrantLineUnitPrices.stepIndex,
      modelLine: kaanaGrantLineUnitPrices.modelLine,
      unit: kaanaGrantLineUnitPrices.unit,
      amount: kaanaGrantLineUnitPrices.amount,
      per: kaanaGrantLineUnitPrices.per,
    })
    .from(kaanaGrantLineUnitPrices)
    .where(eq(kaanaGrantLineUnitPrices.grantId, grantId));
  const byStep = new Map<
    number,
    { maxFundingTier: string | null; lines: Map<string, PriceSnapshotInput> }
  >();
  for (const step of steps)
    byStep.set(step.stepIndex, { maxFundingTier: step.maxFundingTier, lines: new Map() });
  for (const line of lines) {
    byStep.get(line.stepIndex)?.lines.set(line.modelLine, {
      priceVersionId: line.priceVersionId,
      currency: line.currency,
      unitPrices: unitPrices
        .filter((entry) => entry.stepIndex === line.stepIndex && entry.modelLine === line.modelLine)
        .map((entry) => ({ unit: entry.unit, amount: entry.amount, per: entry.per })),
    });
  }
  return byStep;
}
