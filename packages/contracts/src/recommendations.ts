/**
 * Recommendation-engine API contracts.
 *
 * SINGLE SOURCE OF TRUTH for the wire shape of the reputation-weighted
 * profile-recommendation surface (`POST /profiles/recommendations`) and the
 * cross-app signal-ingest endpoint (`POST /app-signals/ingest`). The API
 * validates its INPUT/OUTPUT against these schemas; consumer SDKs validate the
 * same definitions, so the producer and every consumer cannot drift.
 *
 * Platform-agnostic — zod is the only runtime dependency (no react / react-native
 * / expo, ESM-safe).
 */

import { z } from 'zod';
import { userNameSchema } from './userResponse';

/** User-type filters a caller may exclude from the recommendation surface. */
export const recommendationExcludeTypeSchema = z.enum(['federated', 'agent', 'automated']);

export type RecommendationExcludeType = z.infer<typeof recommendationExcludeTypeSchema>;

/**
 * A caller-supplied editorial boost. `userIds` are nudged up (or down, for a
 * negative weight) in the ranking; the optional `reason` is for audit/telemetry
 * only and never surfaced to end users. Boost members still pass the eligibility
 * gate — a boost cannot resurrect a private/restricted/ineligible account.
 */
export const recommendationBoostSchema = z.object({
  userIds: z.array(z.string().trim().min(1)).min(1).max(200),
  weight: z.number().min(-5).max(5),
  reason: z.string().trim().max(120).optional(),
});

export type RecommendationBoost = z.infer<typeof recommendationBoostSchema>;

/**
 * Per-request overrides for the scoring signal weights. Every key is optional
 * and clamped server-side to the resolved weight profile's allowed range — a
 * caller can re-weight signals but never escape the profile's bounds.
 */
export const recommendationSignalWeightsSchema = z
  .object({
    graph: z.number().min(0).max(10).optional(),
    completeness: z.number().min(0).max(10).optional(),
    verified: z.number().min(0).max(10).optional(),
    curation: z.number().min(0).max(10).optional(),
    interest: z.number().min(0).max(10).optional(),
    appBoost: z.number().min(0).max(10).optional(),
    repCandidate: z.number().min(0).max(10).optional(),
    affinity: z.number().min(0).max(10).optional(),
  })
  .partial();

export type RecommendationSignalWeights = z.infer<typeof recommendationSignalWeightsSchema>;

/**
 * Request body for `POST /profiles/recommendations`.
 *
 * `clientId` selects the per-app weight profile (the Application `_id`); when
 * omitted the default profile is used. `excludeIds` removes accounts the caller
 * has already seen/handled; `boosts` and `signalWeights` let the caller bias the
 * ranking within server-enforced bounds.
 */
export const recommendationRequestSchema = z.object({
  clientId: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
  excludeTypes: z.array(recommendationExcludeTypeSchema).optional(),
  excludeIds: z.array(z.string().trim().min(1)).max(500).optional(),
  boosts: z.array(recommendationBoostSchema).max(50).optional(),
  signalWeights: recommendationSignalWeightsSchema.optional(),
});

export type RecommendationRequest = z.infer<typeof recommendationRequestSchema>;

/** Follower/following counts attached to a recommendation item. */
export const recommendationCountSchema = z.object({
  followers: z.number().int().nonnegative(),
  following: z.number().int().nonnegative(),
});

export type RecommendationCount = z.infer<typeof recommendationCountSchema>;

/**
 * A single recommended profile.
 *
 * `name` reuses the canonical {@link userNameSchema} so `name.displayName` is the
 * already-resolved server-side value. `score` and `matchedSignals` are present
 * only on the scored (v2) path; `mutualCount` and `_count` are always present.
 */
export const recommendationItemSchema = z
  .object({
    id: z.string(),
    username: z.string().optional(),
    name: userNameSchema,
    avatar: z.string().nullable().optional(),
    /** The account's accent colour, as on every profile; absent when unset. */
    color: z.string().optional(),
    description: z.string().nullable().optional(),
    verified: z.boolean().optional(),
    trustTier: z.string().optional(),
    mutualCount: z.number().int().nonnegative(),
    score: z.number().optional(),
    matchedSignals: z.array(z.string()).optional(),
    isFederated: z.boolean().optional(),
    isAgent: z.boolean().optional(),
    isAutomated: z.boolean().optional(),
    instance: z.string().optional(),
    _count: recommendationCountSchema,
  })
  .passthrough();

export type RecommendationItem = z.infer<typeof recommendationItemSchema>;

/** Wire shape of the recommendation response — an array of items. */
export const recommendationResponseSchema = z.array(recommendationItemSchema);

export type RecommendationResponse = z.infer<typeof recommendationResponseSchema>;

/** One endorsement edge an app reports: `ownerId` endorses `memberId`. */
export const appEndorsementInputSchema = z.object({
  ownerId: z.string().trim().min(1),
  memberId: z.string().trim().min(1),
  op: z.enum(['add', 'remove']).default('add'),
  sourceId: z.string().trim().min(1).optional(),
});

export type AppEndorsementInput = z.infer<typeof appEndorsementInputSchema>;

/** One interest signal an app reports: how interested `userId` is in a topic. */
export const appInterestInputSchema = z.object({
  userId: z.string().trim().min(1),
  interestScore: z.number().min(0).max(1),
});

export type AppInterestInput = z.infer<typeof appInterestInputSchema>;

/**
 * Request body for `POST /app-signals/ingest` (service token, `signals:write`).
 *
 * At least one of `endorsements` / `interests` must be non-empty — an ingest
 * with neither is a no-op and rejected so a misconfigured caller is surfaced
 * rather than silently succeeding.
 */
export const appUserSignalIngestSchema = z
  .object({
    endorsements: z.array(appEndorsementInputSchema).max(500).optional(),
    interests: z.array(appInterestInputSchema).max(500).optional(),
  })
  .refine((value) => (value.endorsements?.length ?? 0) > 0 || (value.interests?.length ?? 0) > 0, {
    message: 'At least one of endorsements or interests must be non-empty',
  });

export type AppUserSignalIngest = z.infer<typeof appUserSignalIngestSchema>;

/**
 * The directed interaction types a consuming app may report between two users.
 * Each type carries a server-side default weight (see the API's
 * `AFFINITY_EVENT_WEIGHTS`); a caller may override the applied weight per event.
 */
export const appAffinityEventTypeSchema = z.enum([
  'like',
  'reply',
  'boost',
  'follow',
  'mention',
  'profile_view',
  'quote',
  'repost',
]);

export type AppAffinityEventType = z.infer<typeof appAffinityEventTypeSchema>;

/**
 * One directed interaction event: `fromUserId` interacted with `toUserId`
 * (`type`) at `occurredAt`. The Oxy affinity-graph folds these into a per-app,
 * time-decayed directed affinity edge (`fromUserId → toUserId`).
 *
 * - `weight` (optional) overrides the per-type default weight for this event.
 * - `occurredAt` (optional, ISO) is the event time; absent means "now" at ingest.
 * - `eventId` (optional) makes an event idempotent — a repeated `eventId` for the
 *   same application is folded at most once (bounded dedup window).
 */
export const appAffinityEventSchema = z.object({
  fromUserId: z.string().trim().min(1),
  toUserId: z.string().trim().min(1),
  type: appAffinityEventTypeSchema,
  weight: z.number().min(0).max(100).optional(),
  occurredAt: z.string().datetime().optional(),
  eventId: z.string().trim().min(1).max(200).optional(),
});

export type AppAffinityEvent = z.infer<typeof appAffinityEventSchema>;

/**
 * Request body for `POST /app-signals/events` (service token, `signals:write`).
 *
 * A non-empty batch (1..1000) of directed interaction events for the requesting
 * application. Self-edges (`fromUserId === toUserId`) are dropped server-side.
 */
export const appAffinityEventsIngestSchema = z.object({
  events: z.array(appAffinityEventSchema).min(1).max(1000),
});

export type AppAffinityEventsIngest = z.infer<typeof appAffinityEventsIngestSchema>;
