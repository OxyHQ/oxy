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

import type { InferenceEnvironment, InferenceEconomicTreatment } from '@oxy.so/contracts';

/**
 * The version every metered record is stamped with. Bump it on ANY change to
 * {@link INTERNAL_METERED_RELATIONSHIPS} — added, removed or re-sized.
 */
export const INFERENCE_ECONOMIC_POLICY_VERSION = 'oxy-inference-economics/2026-10-02.1';

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
    capacity: {
      maxConcurrentRequests: 256,
      maxRequestsPerUtcDay: 500_000,
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
  policyVersion: string = INFERENCE_ECONOMIC_POLICY_VERSION
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
      candidate.environments.includes(principal.environment)
  );
  return relationship === undefined
    ? { treatment: 'commercial', policyVersion }
    : { treatment: 'internal_metered', policyVersion, relationship };
}
