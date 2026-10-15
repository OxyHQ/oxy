/**
 * Which authenticated callers the inference edge treats as `internal_metered`
 * rather than `commercial` — issue #1526 (plan item I09).
 *
 * ## The treatment is a property of a configured PRODUCT RELATIONSHIP
 *
 * A relationship names the consuming application by its pinned, immutable id,
 * the environments it applies in and the lane it must arrive on. The edge
 * derives the treatment from the principal it has ALREADY authenticated
 * (`authenticateEdgeCaller`, which re-reads the application, credential and
 * scopes from the database on every request). Nothing else selects it:
 *
 *  - not the request body, a header or a client flag — none is read here;
 *  - not `users.kind = 'bot'`, an agent id or a delegated user — those are
 *    attribution, and a bot account is a full account under the same commercial
 *    rules as a human one;
 *  - not "being an official application" — every other first-party app stays
 *    `commercial` until a relationship here says otherwise;
 *  - not passing a request through Alia — an external caller that reaches Kaana
 *    via Alia is billed by Alia's own product rules, never by this exemption.
 *
 * Everything not listed is `commercial`, which is the default and the answer
 * for every caller that has not been migrated.
 *
 * ## Versioned in code, not switched by an environment variable
 *
 * The relationship set is reviewable data with a version string. Changing it is
 * a commit that bumps {@link INFERENCE_ECONOMIC_POLICY_VERSION}, and every
 * metered record stores the version it was admitted under, so history keeps
 * the policy that applied to it. There is deliberately no env switch: an
 * exemption that a deployment variable could widen is one nobody reviewed.
 *
 * ## What `internal_metered` does NOT relax
 *
 * Scopes, revocation, routing policy, model eligibility, privacy, provider
 * gates (`decisionAvailability`, reviewed Kaana audiences), idempotency and
 * TECHNICAL capacity all still apply. Capacity is enforced from
 * {@link InternalMeteredRelationship.capacity} — a request and concurrency
 * budget that refuses without ever asking for a top-up — because removing the
 * monetary hold must not remove the limit the hold used to imply.
 */

import type {
  InferenceEconomicTreatment,
  InferenceEnvironment,
  PowerLevel,
} from '@oxy.so/contracts';
import {
  KAANA_SPEECH_DEPLOYMENT_ID,
  KAANA_SPEECH_MAX_INPUT_CHARACTERS,
  KAANA_SPEECH_MODEL_REFERENCE,
  KAANA_SPEECH_PROVIDER_SLUG,
} from './kaanaInitialCatalogue';

/**
 * The version every metered record is stamped with. Bump it on ANY change to
 * {@link INTERNAL_METERED_RELATIONSHIPS} — added, removed or re-sized.
 */
export const INFERENCE_ECONOMIC_POLICY_VERSION = 'oxy-inference-economics/2026-10-15.2';

/**
 * Alia's Oxy application, pinned. A test compares it to the seed spec's
 * `ALIA_APPLICATION_ID`, so a re-seeded id cannot silently orphan the relationship.
 */
export const ALIA_INFERENCE_CONSUMER_APPLICATION_ID = '6a2f851751b784a86fd0e934';

/** Technical limits that replace what a monetary hold used to bound. */
export interface InternalMeteredCapacity {
  /** Requests admitted and not yet settled, at once, per application + environment. */
  readonly maxConcurrentRequests: number;
  /** Requests admitted per UTC day, per application + environment. */
  readonly maxRequestsPerUtcDay: number;
  /** Default remains all application traffic; a reviewed feature may own a separate budget. */
  readonly scope?: 'relationship';
  /** Closed, source-reviewed Mention qualification; ordinary daily budgets are unchanged. */
  readonly qualificationBudget?: {
    readonly utcDay: '2026-10-05';
    readonly expiresAt: string;
  };
}

/**
 * ADR 0037: the pilot's terms for routes funded by an available promotional
 * credit grant. Admission reads the route's own funding evidence — never a
 * provider, model or deployment name — and only at the named power levels.
 */
export interface InternalMeteredPromotionalCredit {
  /**
   * The levels a request must NAME for a promotionally funded route to be
   * admitted. `auto` is not one: it never reaches `pro`/`ultra` and must not
   * spend a grant on its everyday levels.
   */
  readonly levels: readonly Exclude<PowerLevel, 'auto'>[];
  /**
   * The level whose ordinary pilot routes are signed at the next priority, so a
   * request at a promotional level is still served when no grant-funded route
   * qualifies (spent, stale, unknown, over the ceiling) and Kaana can fail over
   * to them before the first output.
   */
  readonly fallbackLevel: Exclude<PowerLevel, 'auto'>;
  /** Exact USD quote ceiling for a route admitted by its promotional funding. */
  readonly maxPricePerRequestUsd: string;
}

/** One exact signed route: deployment, model revision and serving provider together. */
export interface InternalMeteredPilotDeployment {
  readonly deploymentId: string;
  readonly modelReference: string;
  readonly provider: string;
}

/**
 * The pilot's terms for `POST /v1/audio/speech`, kept apart from the text
 * terms because speech is measured and billed in exact characters
 * (`input.length`), generates no tokens and runs on its own routes. A speech
 * route is never admitted for a completion, nor a completion route for speech.
 */
export interface InternalMeteredSpeechPilot {
  /** Exact characters (`input.length`, UTF-16 units) one speech request may carry. */
  readonly maxInputCharacters: number;
  /** Exact USD tariff quote ceiling for one speech request, before any claim. */
  readonly maxPricePerRequestUsd: string;
  /** The only routes a speech request may sign, including failovers. */
  readonly deployments: readonly InternalMeteredPilotDeployment[];
}

/**
 * The pilot's terms for a realtime session granted on `kaana.ai/v1/realtime`
 * (Kaana ADR 0002, Alia ADR 0017 §5). Only the grant API reads them: the old
 * edge's pilot refuses realtime and keeps doing so until it is deleted.
 *
 * A session is one grant, held open for its whole life and settled at close.
 * How long it lasts and how many answers it gives are the CONSUMER's product
 * rules (Alia: 30 minutes, 2 minutes idle), and how many may be open at once
 * is the application's Console configuration (`application_inference_limits`).
 * What the relationship decides is which models it may run on, by price:
 */
export interface InternalMeteredRealtimePilot {
  /** The session kinds admitted; Alia's calls are `conversation` sessions. */
  readonly sessionKinds: readonly ('conversation' | 'transcription' | 'translation')[];
  /**
   * Exact USD ceiling on ONE MINUTE of session on a model line, quoted at the
   * line's price version over every duration unit a session can be billed in
   * (`audio_input_milliseconds`, `audio_output_milliseconds`,
   * `session_milliseconds`, each at 60 000). A line priced in tokens has no
   * per-minute figure that is a bound rather than a guess, so it does not quote
   * and is not admitted.
   */
  readonly maxPricePerMinuteUsd: string;
}

/**
 * The pilot's terms for `POST kaana.ai/v1/audio/transcriptions` (Alia ADR
 * 0017 §7: dictation). Kaana measures the upload's duration before it asks for
 * the grant (`facts.audioInputMilliseconds`), so a transcription is bounded
 * exactly, in the unit it is billed in.
 */
export interface InternalMeteredTranscriptionPilot {
  /** Exact milliseconds of audio one transcription may carry. */
  readonly maxInputAudioMilliseconds: number;
  /** Exact USD tariff quote ceiling for one transcription, before any claim. */
  readonly maxPricePerRequestUsd: string;
}

export interface InternalMeteredPilot {
  readonly maxControlledInputBudget: number;
  /** Optional text-completion ceiling; decisions retain the base ceiling. */
  readonly maxControlledCompletionInputBudget?: number;
  /** Generated-token ceiling; speech generates none and is not bound by it. */
  readonly maxOutputTokens: number;
  /** Exact USD tariff quote ceiling, before any claim; not an upstream invoice guarantee. */
  readonly maxPricePerRequestUsd?: string;
  /** Every operation's exact routes except speech, which has its own below. */
  readonly deployments: readonly InternalMeteredPilotDeployment[];
  /** Absent: only the exact {@link deployments} above are ever admitted. */
  readonly promotionalCredit?: InternalMeteredPromotionalCredit;
  /** Absent: every speech request is outside the pilot and refused. */
  readonly speech?: InternalMeteredSpeechPilot;
  /** Absent: every realtime grant is outside the pilot and refused. */
  readonly realtime?: InternalMeteredRealtimePilot;
  /** Absent: every transcription grant is outside the pilot and refused. */
  readonly transcription?: InternalMeteredTranscriptionPilot;
}

export interface InternalMeteredRelationship {
  /** Stable name recorded on every metered row admitted under it. */
  readonly relationshipId: string;
  /** The consuming application, by pinned id — never by name. */
  readonly consumerApplicationId: string;
  readonly consumerProduct: string;
  readonly providerProduct: string;
  readonly environments: readonly InferenceEnvironment[];
  /**
   * The lane the caller must have authenticated on. `service_token` is the
   * workload/service credential lane a product backend uses; a customer-mintable
   * machine key or a human product session never qualifies.
   */
  readonly lane: 'service_token';
  readonly capacity: InternalMeteredCapacity;
  readonly pilot?: InternalMeteredPilot;
}

/**
 * The configured internal relationships. Alia → Kaana is the one the plan names
 * (#1526); adding another is a product decision recorded in review, not here
 * by default.
 */
export const INTERNAL_METERED_RELATIONSHIPS: readonly InternalMeteredRelationship[] = [
  {
    relationshipId: 'alia-kaana',
    consumerApplicationId: ALIA_INFERENCE_CONSUMER_APPLICATION_ID,
    consumerProduct: 'alia',
    providerProduct: 'kaana',
    environments: ['production'],
    lane: 'service_token',
    // Approved by Nate on 2026-10-03; exact pilot proposal at 062d4d3019.
    // Sized from Alia's measured production traffic (inference_usage_events,
    // 2026-09-02..2026-10-02, read-only): busiest UTC day 185 requests (p95
    // 148, median 18), busiest minute 16, at most 3 requests in flight at once,
    // p95 latency 8.9 s. 32 in flight is ~10x the measured peak; 5,000 a day is
    // ~27x the busiest day. Either refuses with a 429 and never asks for a top-up.
    // Request counts do not bound cost by themselves: model eligibility does.
    capacity: {
      maxConcurrentRequests: 32,
      maxRequestsPerUtcDay: 5_000,
    },
    pilot: {
      maxControlledInputBudget: 8192,
      // Production chat includes system context, history and tool schemas. The
      // retired 8KiB synthetic pilot rejected those before provider dispatch.
      // This is a UTF-8/framing ceiling, not a provider token/cost guarantee.
      // Keep 4KiB below the reviewed 128Ki context; each route still qualifies
      // against its own context, output and quote. Decisions retain 8KiB.
      maxControlledCompletionInputBudget: 126_976,
      maxOutputTokens: 2048,
      maxPricePerRequestUsd: '0.05',
      deployments: [
        ...['cerebras', 'groq', 'openrouter'].map((provider) => ({
          deploymentId:
            provider === 'cerebras'
              ? 'dep_cerebras_gpt_oss_120b_observed_2026_09_01'
              : `dep_${provider}_openai_gpt_oss_120b_observed_2026_09_01`,
          modelReference: 'openai/gpt-oss-120b@observed-2026-09-01',
          provider,
        })),
        {
          // Existing reviewed High model; this adds one exact internal route,
          // without changing Auto's capability classes or its upward-only ladder.
          deploymentId: 'dep_openrouter_deepseek_deepseek_v4_flash_0731_observed_2026_09_01',
          modelReference: 'deepseek/deepseek-v4-flash-0731@observed-2026-09-01',
          provider: 'openrouter',
        },
      ],
      // ADR 0037. Pro and Ultra, when named, may run on any route whose current
      // scorecard says an AVAILABLE, in-window promotional credit grant funds it
      // (today Kaana's direct Anthropic key). A standard-paid route of the same
      // model (OpenRouter's Claude) is never admitted, and spent, stale or
      // unknown evidence removes the route, leaving the XHigh routes above.
      // USD 1.00 admits Opus 4.x/5 at the full 126,976-unit input plus 2048
      // output ($0.686); the grant, not this ceiling, bounds the month.
      promotionalCredit: {
        levels: ['pro', 'ultra'],
        fallbackLevel: 'xhigh',
        maxPricePerRequestUsd: '1.00',
      },
      // Approved by Nate on 2026-10-15: Alia's speech synthesis, refused since
      // the pilot began (2026-10-03, #1557) because the pilot had no speech
      // terms. Up to the 15,000 characters Kaana's xAI translation serves, on
      // the one reviewed xAI route only. At its $15.00 per 1M characters list
      // price the full request quotes USD 0.225, under the USD 0.25 ceiling.
      speech: {
        maxInputCharacters: KAANA_SPEECH_MAX_INPUT_CHARACTERS,
        maxPricePerRequestUsd: '0.25',
        deployments: [
          {
            deploymentId: KAANA_SPEECH_DEPLOYMENT_ID,
            modelReference: KAANA_SPEECH_MODEL_REFERENCE,
            provider: KAANA_SPEECH_PROVIDER_SLUG,
          },
        ],
      },
      // Alia ADR 0017 (accepted 2026-10-15): calls are realtime conversation
      // sessions and dictation is batch transcription, both on kaana.ai/v1
      // through a grant. Granted only by the grant API (Kaana ADR 0002 phase 2);
      // nothing calls it before phase 3. Concurrency and spend are the Alia
      // application's Console configuration, not terms here.
      //
      // USD 0.25 a minute admits the one reviewed realtime voice line (xAI's
      // Voice Agent, $0.08/min audio in + $0.08 out + $0.08 session, held all
      // three: $0.24) and no token-priced realtime line.
      realtime: {
        sessionKinds: ['conversation'],
        maxPricePerMinuteUsd: '0.25',
      },
      // Alia's dictation clip is capped at 5 minutes (ADR 0017 §7). USD 0.05
      // covers a full clip at up to $0.01/min; batch transcription lists at
      // $0.003-0.006/min (2026-10-15).
      transcription: {
        maxInputAudioMilliseconds: 300_000,
        maxPricePerRequestUsd: '0.05',
      },
    },
  },
];

/** The facts about an authenticated principal this decision may read. Nothing else. */
export interface EconomicTreatmentPrincipal {
  readonly lane: 'machine_credential' | 'service_token' | 'product_session';
  readonly applicationId: string;
  readonly environment: InferenceEnvironment;
  /** Live `applications.is_internal`, re-read on every request. */
  readonly applicationIsInternal: boolean | null;
}

export type EconomicTreatmentDecision =
  | {
      readonly treatment: Extract<InferenceEconomicTreatment, 'commercial'>;
      readonly policyVersion: string;
    }
  | {
      readonly treatment: Extract<InferenceEconomicTreatment, 'internal_metered'>;
      readonly policyVersion: string;
      readonly relationship: InternalMeteredRelationship;
    };

/**
 * Decide the economic treatment for an AUTHENTICATED principal.
 *
 * Pure, and typed to accept only the four principal facts it needs, so no
 * request-borne value can be passed in by a later refactor without the type
 * changing first.
 */
export function resolveEconomicTreatment(
  principal: EconomicTreatmentPrincipal,
  relationships: readonly InternalMeteredRelationship[] = INTERNAL_METERED_RELATIONSHIPS,
  policyVersion: string = INFERENCE_ECONOMIC_POLICY_VERSION,
): EconomicTreatmentDecision {
  // An application that is no longer marked internal loses the exemption on
  // its next request, whatever this file still says.
  if (principal.applicationIsInternal !== true) {
    return { treatment: 'commercial', policyVersion };
  }
  const relationship = relationships.find(
    (candidate) =>
      candidate.consumerApplicationId === principal.applicationId &&
      candidate.lane === principal.lane &&
      candidate.environments.includes(principal.environment),
  );
  return relationship === undefined
    ? { treatment: 'commercial', policyVersion }
    : { treatment: 'internal_metered', policyVersion, relationship };
}
